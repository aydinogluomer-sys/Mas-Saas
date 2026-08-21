// P0-B Slice 5 — read-only legacy-data inventory generator. Produces an IMMUTABLE
// InventoryManifest JSON file; never writes to the database (SELECT only), never
// contains an "approved" field — approval is a wholly separate artifact produced by
// legacy-repair-approval.ts.
//
// Fail-closed DB-identity gate: DATABASE_URL must be set explicitly; the database name
// parsed from it must match --expected-database-name; only after connecting and
// confirming current_database()/system_identifier live is the report generated. This
// script never imports src/lib/radar/engine.ts or any getPool()-touching module — it is
// pure SQL, so there is nothing to gate behind a dynamic import.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { istanbulDateISO } from "../../src/lib/time/istanbul";
import {
  CANONICALIZATION_VERSION,
  INVENTORY_MANIFEST_VERSION,
  InventoryManifestSchema,
  canonicalHash,
  fileSha256,
  payloadSha256,
  sortTargetsDeterministically,
  writeExclusiveDurable,
  type InventoryTarget,
} from "./legacy-repair-types";
import { ownerDatabaseUrl } from "./owner-url";

interface Args {
  expectedDatabaseName: string;
  out: string;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const expectedDatabaseName = get("--expected-database-name");
  const out = get("--out");
  if (!expectedDatabaseName) throw new Error("--expected-database-name zorunlu.");
  if (!out) throw new Error("--out zorunlu.");
  return { expectedDatabaseName, out };
}

function dbNameFromUrl(url: string): string {
  return new URL(url).pathname.replace(/^\//, "");
}

const TO_CHAR_INSTANT = `to_char($COL$ at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const databaseUrl = ownerDatabaseUrl();
  if (!databaseUrl) {
    console.error("MIGRATION_DATABASE_URL (veya DATABASE_URL) açıkça verilmeli — varsayılan bağlantı kabul edilmez.");
    process.exit(1);
  }
  const parsedName = dbNameFromUrl(databaseUrl);
  if (parsedName !== args.expectedDatabaseName) {
    console.error(
      `DATABASE_URL'deki DB adı ('${parsedName}') --expected-database-name ('${args.expectedDatabaseName}') ile eşleşmiyor. Çıkış.`,
    );
    process.exit(1);
  }

  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const live = await pool.query<{ db: string; sysid: string }>(
      `select current_database() as db, (select system_identifier::text from pg_control_system()) as sysid`,
    );
    if (live.rows[0].db !== args.expectedDatabaseName) {
      console.error(
        `Canlı 'select current_database()' ('${live.rows[0].db}') beklenen ada ('${args.expectedDatabaseName}') eşit değil. Çıkış.`,
      );
      process.exit(1);
    }
    const systemIdentifier = live.rows[0].sysid;

    const ledger = await pool.query<{ n: string; last_version: string | null }>(
      `select count(*)::text as n, max(version) as last_version from public.schema_migrations`,
    );
    const ledgerCount = Number(ledger.rows[0].n);
    const lastMigrationVersion = ledger.rows[0].last_version;
    if (!lastMigrationVersion) {
      console.error("schema_migrations boş — bu araç yalnız uygulanmış bir ledger üzerinde çalışır. Çıkış.");
      process.exit(1);
    }

    const gitHead = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const todayISO = istanbulDateISO();

    // ── legacy cancelled instance(s) with missing metadata — genuine discovery, no hardcoded UUID ──
    const legacyRows = await pool.query<{ id: string }>(
      `select id from public.payment_instances where status='cancelled' and (cancelled_at is null or cancel_reason is null)`,
    );
    if (legacyRows.rowCount !== null && legacyRows.rowCount > 1) {
      console.error(
        `Beklenmedik durum: birden fazla (${legacyRows.rowCount}) metadata-eksik cancelled instance bulundu — bu araç yalnız 0 veya 1 için tasarlandı. Yeniden planlama gerekli. Çıkış.`,
      );
      process.exit(1);
    }

    const targets: InventoryTarget[] = [];
    let legacyInstanceAuditRow: {
      id: string; action: string; createdAt: string; canonicalHash: string;
    } | null = null;

    if (legacyRows.rowCount === 1) {
      const instanceId = legacyRows.rows[0].id;
      const rowRaw = await pool.query<{ payment_id: string | null; raw: string }>(
        `select payment_id, to_jsonb(t)::text as raw from public.payment_instances t where t.id=$1`,
        [instanceId],
      );
      if (rowRaw.rowCount !== 1) {
        console.error(`Beklenmedik durum: instance ${instanceId} artık bulunamıyor (rowCount=${rowRaw.rowCount}). Çıkış.`);
        process.exit(1);
      }
      // The instance's real, live payment_id — never hardcoded. A metadata-repair target
      // is not necessarily payment-scoped in its REPAIR ACTION, but the manifest must
      // still report the row's true relationship, whatever it is (including null), so
      // apply.ts's live-DB semantic invariant has real ground truth to check against.
      const legacyInstancePaymentId = rowRaw.rows[0].payment_id;
      const beforeStateHash = canonicalHash(rowRaw.rows[0].raw);

      const auditRes = await pool.query<{ id: string; created_at_iso: string; raw: string }>(
        `select id, ${TO_CHAR_INSTANT.replace("$COL$", "created_at")} as created_at_iso, to_jsonb(t)::text as raw
         from public.audit_logs t
         where entity_table='payment_instances' and entity_id=$1 and action='cancel_instance'
         order by created_at desc limit 1`,
        [instanceId],
      );

      let proposedCancelledAt: string | null = null;
      let rationale: string;
      if (auditRes.rowCount === 1) {
        proposedCancelledAt = auditRes.rows[0].created_at_iso;
        legacyInstanceAuditRow = {
          id: auditRes.rows[0].id,
          action: "cancel_instance",
          createdAt: auditRes.rows[0].created_at_iso,
          canonicalHash: canonicalHash(auditRes.rows[0].raw),
        };
        rationale =
          "audit cancel_instance created_at güvenilir zaman kanıtı; cancel_reason için hiçbir kaynak yok " +
          "(after_data'da alan yok, note boş, source_row_id null) — fabrikasyon yapılmadı. Kullanıcı açık " +
          "bir cancel_reason sağlamadan bu satır approved olamaz.";
      } else {
        rationale = "cancelled_at/cancel_reason eksik ve hiçbir cancel_instance audit kanıtı bulunamadı — cancelledAt için de kanıt yok.";
      }

      targets.push({
        kind: "cancellation_metadata_repair",
        paymentId: legacyInstancePaymentId,
        instanceId,
        beforeStateHash,
        classification: "unresolved",
        proposedCancelledAt,
        cancelledAtPolicy: proposedCancelledAt ? "fixed_evidence_timestamp" : null,
        proposedCancelReason: null,
        rationale,
      });
    }

    // ── archived payment(s) + their instances — genuine discovery, no hardcoded UUID ──
    const archivedRows = await pool.query<{ id: string }>(`select id from public.payments where status='archived'`);
    if (archivedRows.rowCount !== null && archivedRows.rowCount > 1) {
      console.error(
        `Beklenmedik durum: birden fazla (${archivedRows.rowCount}) arşivlenmiş ödeme bulundu — bu araç yalnız 0 veya 1 için tasarlandı. Yeniden planlama gerekli. Çıkış.`,
      );
      process.exit(1);
    }

    let archivedPayment: { id: string; beforeStateHash: string } | null = null;
    let archivedPaymentAuditRow: {
      id: string; action: string; createdAt: string; canonicalHash: string; archiveReason: string; archivedAt: string;
    } | null = null;

    if (archivedRows.rowCount === 1) {
      const paymentId = archivedRows.rows[0].id;
      const paymentRaw = await pool.query<{ raw: string }>(
        `select to_jsonb(t)::text as raw from public.payments t where t.id=$1`,
        [paymentId],
      );
      archivedPayment = { id: paymentId, beforeStateHash: canonicalHash(paymentRaw.rows[0].raw) };

      const payAuditRes = await pool.query<{
        id: string; action: string; created_at_iso: string; raw: string; archive_reason: string | null; archived_at_iso: string | null;
      }>(
        `select al.id, al.action, ${TO_CHAR_INSTANT.replace("$COL$", "al.created_at")} as created_at_iso, to_jsonb(al)::text as raw,
                (select archive_reason from public.payments where id=$1) as archive_reason,
                (select ${TO_CHAR_INSTANT.replace("$COL$", "archived_at")} from public.payments where id=$1) as archived_at_iso
         from public.audit_logs al
         where al.entity_table='payments' and al.entity_id=$1
           and al.action in ('archive_payment','archive_record')
         order by al.created_at desc limit 1`,
        [paymentId],
      );
      if (payAuditRes.rowCount === 1 && payAuditRes.rows[0].archive_reason && payAuditRes.rows[0].archived_at_iso) {
        archivedPaymentAuditRow = {
          id: payAuditRes.rows[0].id,
          action: payAuditRes.rows[0].action,
          createdAt: payAuditRes.rows[0].created_at_iso,
          canonicalHash: canonicalHash(payAuditRes.rows[0].raw),
          archiveReason: payAuditRes.rows[0].archive_reason,
          archivedAt: payAuditRes.rows[0].archived_at_iso,
        };
      }

      const instances = await pool.query<{
        id: string; status: string; due_date: string; raw: string;
      }>(
        `select id, status, to_char(due_date,'YYYY-MM-DD') as due_date, to_jsonb(t)::text as raw
         from public.payment_instances t
         where payment_id=$1
         order by due_date, id`,
        [paymentId],
      );
      const cascadeEligibleStatuses = new Set(["unpaid", "planned"]);
      for (const row of instances.rows) {
        const beforeStateHash = canonicalHash(row.raw);
        const isFuture = row.due_date >= todayISO;
        const statusEligible = cascadeEligibleStatuses.has(row.status);
        if (statusEligible && isFuture) {
          targets.push({
            kind: "archive_cascade_repair",
            paymentId,
            instanceId: row.id,
            beforeStateHash,
            classification: "candidate",
            proposedCancelledAt: null,
            cancelledAtPolicy: "apply_transaction_timestamp",
            proposedCancelReason: archivedPaymentAuditRow
              ? `Ödeme arşivlendi: ${archivedPaymentAuditRow.archiveReason} (Slice 5 legacy repair)`
              : null,
            rationale: `due_date (${row.due_date}) >= todayISO (${todayISO}), status='${row.status}', arşivlenmiş payment'a bağlı — Slice 4 cascade'i bu satırı retroaktif olarak hiç işlemedi.`,
          });
        } else {
          const reason = !statusEligible
            ? `status='${row.status}' — cascade adayı değil (yalnız unpaid/planned uygun).`
            : `due_date (${row.due_date}) < todayISO (${todayISO}) — geçmiş vadeli, cascade adayı değil.`;
          targets.push({
            kind: "archive_cascade_repair",
            paymentId,
            instanceId: row.id,
            beforeStateHash,
            classification: "ineligible",
            proposedCancelledAt: null,
            cancelledAtPolicy: null,
            proposedCancelReason: null,
            rationale: reason,
          });
        }
      }
    }

    const sortedTargets = sortTargetsDeterministically(targets);

    // canonicalizationVersion is part of the semantic payload hash scope (it describes
    // what the content MEANS); durability is transport/file-write metadata, deliberately
    // excluded — it is only known after the write's own directory-fsync probe runs
    // inside writeExclusiveDurable, which happens after this hash is already fixed.
    const manifestWithoutHash = {
      canonicalizationVersion: CANONICALIZATION_VERSION,
      inventoryManifestVersion: INVENTORY_MANIFEST_VERSION,
      todayISO,
      timezone: "Europe/Istanbul" as const,
      gitHead,
      databaseName: args.expectedDatabaseName,
      systemIdentifier,
      ledgerCount,
      lastMigrationVersion,
      evidence: { legacyInstanceAuditRow, archivedPaymentAuditRow },
      archivedPayment,
      targets: sortedTargets,
    };
    const inventoryPayloadSha256 = payloadSha256(manifestWithoutHash);

    const manifestWithoutDurability = {
      generatedAt: new Date().toISOString(),
      ...manifestWithoutHash,
      inventoryPayloadSha256,
    };

    const confirmedDurability = writeExclusiveDurable(
      args.out,
      (durability) => {
        const manifest = { ...manifestWithoutDurability, durability };
        const parsed = InventoryManifestSchema.safeParse(manifest);
        if (!parsed.success) {
          throw new Error(`Üretilen inventory manifest kendi şemasından geçemedi (programlama hatası): ${parsed.error.message}`);
        }
        return JSON.stringify(parsed.data, null, 2);
      },
      (text) => {
        const parsed = InventoryManifestSchema.safeParse(JSON.parse(text));
        if (!parsed.success) throw new Error(`inventory manifest kendi şemasından geçemedi: ${parsed.error.message}`);
      },
    );

    const finalBytes = readFileSync(args.out);
    const sha256 = fileSha256(finalBytes);

    console.log(`Inventory manifest yazıldı: ${path.resolve(args.out)}`);
    console.log(`  bytes: ${finalBytes.length}`);
    console.log(`  fileSha256: ${sha256}`);
    console.log(`  inventoryPayloadSha256: ${inventoryPayloadSha256}`);
    console.log(`  durability: ${JSON.stringify(confirmedDurability)}`);
    console.log(`  targets: ${sortedTargets.length} (candidate=${sortedTargets.filter((t) => t.classification === "candidate").length}, unresolved=${sortedTargets.filter((t) => t.classification === "unresolved").length}, ineligible=${sortedTargets.filter((t) => t.classification === "ineligible").length})`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("legacy-repair-inventory beklenmedik hata ile durdu:", err);
  process.exit(1);
});
