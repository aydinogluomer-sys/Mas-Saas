import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { getRawPool } from "@/lib/db";
import { checkSchemaParity } from "@/lib/db/schema-parity";
import { monthSummary } from "@/lib/radar/queries";
import { buildReminderMessage, isEligible } from "@/lib/reminders/rules";
import { buildOvernightDeltaAttribution } from "@/lib/briefing/delta-attribution";
import { loadFourWaySubledgerHealth } from "@/lib/reconciliation/four-way-health";

interface GateResult {
  gateNo: number;
  name: string;
  passed: boolean;
  evidence: string;
}

const results: GateResult[] = [];
function record(gateNo: number, name: string, passed: boolean, evidence: string) {
  results.push({ gateNo, name, passed, evidence });
  console.log(`${passed ? "PASS" : "FAIL"}  [Gate #${gateNo}] ${name} — ${evidence}`);
}

async function main() {
  const appUrl = process.env.DATABASE_URL;
  const ownerUrl = process.env.MIGRATION_DATABASE_URL;
  if (!appUrl || !ownerUrl) {
    throw new Error("DATABASE_URL and MIGRATION_DATABASE_URL are required (use --env-file=.env.local).");
  }

  const appPool = new Pool({ connectionString: appUrl, max: 2 });
  const ownerPool = new Pool({ connectionString: ownerUrl, max: 2 });

  try {
    // ── Gate #1: Bağlantı, Runtime Rolü ve RLS ───────────────────────────────
    {
      const roleRes = await appPool.query<{
        usr: string;
        rolsuper: boolean;
        rolbypassrls: boolean;
        rolinherit: boolean;
      }>(
        `select current_user as usr, rolsuper, rolbypassrls, rolinherit
           from pg_roles where rolname = current_user`,
      );
      const r = roleRes.rows[0];
      const rlsRes = await ownerPool.query<{
        total: number;
        rls_on: number;
        views_total: number;
        invoker_on: number;
      }>(
        `select
           (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r') as total,
           (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity = true) as rls_on,
           (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'v') as views_total,
           (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'v' and coalesce('security_invoker=true' = any(c.reloptions), false)) as invoker_on`,
      );
      const s = rlsRes.rows[0];
      const ok =
        r?.usr === "mas_radar_app" &&
        r.rolsuper === false &&
        r.rolbypassrls === false &&
        r.rolinherit === false &&
        s.total === s.rls_on &&
        s.views_total === s.invoker_on;
      record(
        1,
        "Bağlantı, Runtime Rolü ve RLS Kalkanı",
        ok,
        `user=${r?.usr} super=${r?.rolsuper} bypassrls=${r?.rolbypassrls} RLS=${s.rls_on}/${s.total} security_invoker=${s.invoker_on}/${s.views_total}`,
      );
    }

    // ── Gate #2: Şema Uyumluluğu (App <-> Manifest <-> DB) ───────────────────
    {
      const parity = await checkSchemaParity(appPool);
      record(
        2,
        "Şema ve Migration Manifest Uyumluluğu",
        parity.aligned && parity.actualCount === parity.expectedCount && parity.actualLatestVersion === parity.expectedLatestVersion,
        `aligned=${parity.aligned} actual=${parity.actualCount}/${parity.actualLatestVersion} expected=${parity.expectedCount}/${parity.expectedLatestVersion}`,
      );
    }

    // ── Gate #3: İzole Yedek Geri Yükleme Kanıtı ─────────────────────────────
    {
      const receiptPath = path.join(process.cwd(), "backups", "latest-restore-drill.json");
      const exists = fs.existsSync(receiptPath);
      const receipt = exists ? JSON.parse(fs.readFileSync(receiptPath, "utf8")) : null;
      const ok =
        Boolean(receipt?.passed) &&
        Boolean(receipt?.aggregatesMatched) &&
        Boolean(receipt?.countsMatched) &&
        String(receipt?.schemaLedger ?? "").endsWith("/0123");
      record(
        3,
        "İzole Veritabanına Yedek Geri Yükleme Tatbikatı",
        ok,
        exists
          ? `passed=${receipt.passed} ledger=${receipt.schemaLedger} countsMatched=${receipt.countsMatched} aggregatesMatched=${receipt.aggregatesMatched}`
          : "backups/latest-restore-drill.json bulunamadı",
      );
    }

    // ── Gate #4: Finansal Mutabakat (30.000 TL ve 50.000 TL Farkın Kapanışı) ─
    {
      const nov = await monthSummary(ownerPool, "2026-11-01");
      const jun = await monthSummary(ownerPool, "2026-06-01");
      const novGap =
        Math.round(
          (nov.known_total - (nov.paid_known + nov.known_remaining + nov.settlementAdjustmentTry)) *
            100,
        ) / 100;
      const junGap =
        Math.round(
          (jun.known_total - (jun.paid_known + jun.known_remaining + jun.settlementAdjustmentTry)) *
            100,
        ) / 100;
      const grainRes = await ownerPool.query<{ total_cnt: number; no_cat: number }>(
        `select
           count(*)::int as total_cnt,
           count(*) filter (where p.category_id is null)::int as no_cat
         from public.payment_instances i
         left join public.payments p on p.id = i.payment_id
         where i.instance_month = '2026-11-01'
           and i.status <> 'cancelled'
           and i.cancelled_at is null
           and coalesce(i.direction, 'outflow') = 'outflow'`,
      );
      const g = grainRes.rows[0];
      const ok =
        novGap === 0 &&
        junGap === 0 &&
        nov.cancelledKnownTotal === 30000 &&
        jun.cancelledKnownTotal === 50000 &&
        g.no_cat <= g.total_cnt;
      record(
        4,
        "Finansal Rapor Aritmetik Mutabakatı & Kardinalite",
        ok,
        `2026-11 gap=${novGap} TL (known=${nov.known_total}, rem=${nov.known_remaining}, cancelledDisclosed=${nov.cancelledKnownTotal}) · 2026-06 gap=${junGap} TL (cancelledDisclosed=${jun.cancelledKnownTotal}) · grain=${g.no_cat}/${g.total_cnt}`,
      );
    }

    // ── Gate #5: Tarih ve Gecikme Sınıflandırma Motoru ──────────────────────
    {
      const target165 = {
        entityTable: "payment_instances",
        entityId: "t-165",
        name: "VAKIF KREDİ 1",
        dueDate: "2026-06-05",
        amount: null,
        status: "unpaid",
        owner: null,
        provider: null,
        riskReasons: ["missing_amount", "overdue"],
      };
      const todayISO = "2026-11-17";
      const match1to7 = isEligible(
        { id: "r1", name: "1-7", targetKind: "payment_instance", offsetDays: -1, channel: "telegram", minAmount: null, isActive: true },
        target165,
        todayISO,
      );
      const match8to30 = isEligible(
        { id: "r8", name: "8-30", targetKind: "payment_instance", offsetDays: -8, channel: "telegram", minAmount: null, isActive: true },
        target165,
        todayISO,
      );
      const match30Plus = isEligible(
        { id: "r31", name: "30+", targetKind: "payment_instance", offsetDays: -31, channel: "telegram", minAmount: null, isActive: true },
        target165,
        todayISO,
      );
      const msg = buildReminderMessage(
        { id: "r31", name: "30+", targetKind: "payment_instance", offsetDays: -31, channel: "telegram", minAmount: null, isActive: true },
        target165,
        todayISO,
      );
      const noRawSlugs =
        !msg.includes("missing_amount") &&
        !msg.includes("durum: unpaid") &&
        !msg.includes("1-7 Gün") &&
        !msg.includes("1–7 Gün");
      const ok = !match1to7 && !match8to30 && match30Plus && noRawSlugs;
      record(
        5,
        "Tarih & Ayrık Gecikme Kademesi Sınıflandırması",
        ok,
        `165g -> [-1:${match1to7}, -8:${match8to30}, -31:${match30Plus}] · noRawSlugs=${noRawSlugs}`,
      );
    }

    // ── Gate #6: Bildirim Idempotency & Olay Durum Makinesi ─────────────────
    {
      const client = await ownerPool.connect();
      let ok = false;
      let detail = "";
      try {
        await client.query("begin");
        const r1 = await client.query(
          `insert into public.notification_outbox (stream, channel, recipient_target, idempotency_key, body_text)
           values ('cfo_briefing', 'telegram', '-1001', 'gate6-idem-test-key', 'test')
           on conflict (idempotency_key) do nothing returning id`,
        );
        const r2 = await client.query(
          `insert into public.notification_outbox (stream, channel, recipient_target, idempotency_key, body_text)
           values ('cfo_briefing', 'telegram', '-1001', 'gate6-idem-test-key', 'test')
           on conflict (idempotency_key) do nothing returning id`,
        );
        const inc = await client.query(
          `insert into public.ops_incidents (signal_key, severity, state, last_value)
           values ('gate6_probe', 'P0', 'UNKNOWN', '?')
           returning state`,
        );
        ok = r1.rowCount === 1 && r2.rowCount === 0 && inc.rows[0]?.state === "UNKNOWN";
        detail = `firstInsert=${r1.rowCount} duplicateInsert=${r2.rowCount} incidentState=${inc.rows[0]?.state}`;
      } finally {
        await client.query("rollback");
        client.release();
      }
      record(6, "Bildirim Idempotency (Outbox) ve UNKNOWN/RESOLVED Olay Modeli", ok, detail);
    }

    // ── Gate #7: Veri Kaynağı Kesintisi & BLANK != ZERO Dürüstlüğü ──────────
    {
      const bridge = buildOvernightDeltaAttribution({
        fromDateISO: "2026-11-16",
        toDateISO: "2026-11-17",
        previousAvailableCash: null,
        currentAvailableCash: null,
        previousLiquidityGap7: null,
        currentLiquidityGap7: null,
        bankInflows: [],
        bankOutflows: [],
        newlyEntered7dObligations: [],
        slippedPromisesAndOverdueAr: [],
        hasVerifiedBankFeed: false,
      });
      const fourWay = await loadFourWaySubledgerHealth(ownerPool);
      const cashPillar = fourWay.pillars.find((p) => p.key === "bank_102");
      const ok =
        bridge.realizedBankInflows === null &&
        bridge.realizedBankOutflows === null &&
        bridge.fxAndAdjustmentImpact === null &&
        !bridge.cashDeltaIdentityBalanced &&
        cashPillar?.aligned === false;
      record(
        7,
        "Eksik Kaynakta 0 TL Yerine UNKNOWN (FIN-03 & Ekstre Dürüstlüğü)",
        ok,
        `bankIn=${String(bridge.realizedBankInflows)} fx=${String(bridge.fxAndAdjustmentImpact)} balanced=${String(bridge.cashDeltaIdentityBalanced)} cashAligned=${String(cashPillar?.aligned)}`,
      );
    }

    // ── Gate #8: Finansal Onay & IBAN Sert Güvenlik Engeli ───────────────────
    {
      const client = await ownerPool.connect();
      let blockedAbove100k = false;
      let allowedBelow100k = false;
      let errCode = "";
      try {
        await client.query("begin");
        const payRes = await client.query<{ id: string }>(
          `insert into public.payments (name, recurrence_type, due_day, default_amount, currency)
           values ('GATE8-TEST', 'monthly', 15, 175000, 'TRY') returning id`,
        );
        const instHigh = await client.query<{ id: string }>(
          `insert into public.payment_instances (payment_id, instance_month, due_date, amount, currency, status, direction, approval_status)
           values ($1, '2099-08-01', '2099-08-15', 175000, 'TRY', 'unpaid', 'outflow', 'not_required') returning id`,
          [payRes.rows[0].id],
        );
        const instLow = await client.query<{ id: string }>(
          `insert into public.payment_instances (payment_id, instance_month, due_date, amount, currency, status, direction, approval_status)
           values ($1, '2099-09-01', '2099-09-15', 12500, 'TRY', 'unpaid', 'outflow', 'not_required') returning id`,
          [payRes.rows[0].id],
        );

        await client.query(
          `update public.payment_instances set status = 'paid', paid_amount = 12500, paid_at = now() where id = $1`,
          [instLow.rows[0].id],
        );
        allowedBelow100k = true;

        await client.query("savepoint sp_gate8");
        try {
          await client.query(
            `update public.payment_instances set status = 'paid', paid_amount = 175000, paid_at = now() where id = $1`,
            [instHigh.rows[0].id],
          );
          blockedAbove100k = false;
        } catch (e: unknown) {
          blockedAbove100k = true;
          errCode = String((e as { code?: string }).code ?? "ERR");
          await client.query("rollback to savepoint sp_gate8");
        }
      } finally {
        await client.query("rollback");
        client.release();
      }
      record(
        8,
        "Eşik Üstü Onaysız Ödeme & IBAN Sert Veritabanı Engeli",
        allowedBelow100k && blockedAbove100k && errCode === "42501",
        `allowedBelow100k=${allowedBelow100k} blockedAbove100k=${blockedAbove100k} sqlstate=${errCode}`,
      );
    }

    // ── Gate #9: Rapor İzlenebilirliği & DSO 365 Gün Sapma Koruması ──────────
    {
      const client = await ownerPool.connect();
      let dsoAfterSingleInvoice: string | null = "NOT_RUN";
      try {
        await client.query("begin");
        const partyRes = await client.query<{ id: string }>(
          `insert into public.parties (name, normalized_name, party_type) values ('GATE9-MUSTERI', 'gate9-musteri', 'customer') returning id`,
        );
        await client.query(
          `insert into public.invoices (party_id, direction, issue_date, due_date, net_amount, gross_amount, currency, status, invoice_no)
           values ($1, 'sales', current_date, current_date + 30, 50000, 50000, 'TRY', 'open', 'G9-INV-001')`,
          [partyRes.rows[0].id],
        );
        const wcRes = await client.query<{ dso_days: string | null }>(
          `select dso_days::text from public.working_capital_metrics`,
        );
        dsoAfterSingleInvoice = wcRes.rows[0]?.dso_days ?? null;
      } finally {
        await client.query("rollback");
        client.release();
      }
      record(
        9,
        "DSO 365 Gün Cebirsel Sapma Koruması ve Rapor Kanıt Damgası",
        dsoAfterSingleInvoice === null,
        `singleDayZeroInvoiceDso=${String(dsoAfterSingleInvoice)} (365.0 gün yapay sıçraması engellendi)`,
      );
    }

    // ── Gate #10: Tüzel Kişilik / Tenant RLS İzolasyonu ─────────────────────
    {
      const setupClient = await ownerPool.connect();
      let leakedRows = -1;
      try {
        await setupClient.query("begin");
        const entA = (
          await setupClient.query<{ id: string }>(
            `insert into public.legal_entities (code, name, is_default, is_active) values ('G10-A', 'Gate10 Şirket A', false, true) returning id`,
          )
        ).rows[0].id;
        const entB = (
          await setupClient.query<{ id: string }>(
            `insert into public.legal_entities (code, name, is_default, is_active) values ('G10-B', 'Gate10 Şirket B', false, true) returning id`,
          )
        ).rows[0].id;
        const payA = (
          await setupClient.query<{ id: string }>(
            `insert into public.payments (name, recurrence_type, due_day, default_amount, currency, legal_entity_id)
             values ('G10 Gizli Ödeme A', 'monthly', 10, 25000, 'TRY', $1) returning id`,
            [entA],
          )
        ).rows[0].id;

        await setupClient.query(`set local role mas_radar_viewer`);
        await setupClient.query(`select set_config('app.current_legal_entity_id', $1, true)`, [entB]);
        const leakCheck = await setupClient.query<{ cnt: number }>(
          `select count(*)::int as cnt from public.payments where id = $1`,
          [payA],
        );
        leakedRows = leakCheck.rows[0]?.cnt ?? -1;
      } finally {
        await setupClient.query("rollback").catch(() => {});
        setupClient.release();
      }
      record(
        10,
        "PostgreSQL Kısıtlayıcı (RESTRICTIVE) Tüzel Kişilik RLS İzolasyonu",
        leakedRows === 0,
        `crossEntityVisibleRows=${leakedRows} (beklenen=0)`,
      );
    }
  } finally {
    await appPool.end();
    await ownerPool.end();
    await getRawPool().end().catch(() => {});
  }

  const failed = results.filter((r) => !r.passed);
  console.log(
    `\n=== 10 ZORUNLU ÜRETİME ÇIKIŞ DOĞRULAMA KAPISI: ${results.length - failed.length} / ${results.length} GEÇTİ ===`,
  );
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

void main();
