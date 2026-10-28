// Phase 3 server modules: candidate mapping, instance generation, mutations.
// Eligibility semantics (documented in docs/import-mapping.md §review-status):
//   clean row (no reviews) → eligible
//   all linked reviews ∈ {accepted, resolved} → eligible
//   any review ∈ {open, rejected} → EXCLUDED (rule: no rejected/unresolved rows)
//   name missing → never importable (even if its review was accepted)

import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { extractPaymentMatrix } from "@/lib/importers/extractors";
import type { RowJson, SheetRow } from "@/lib/importers/row-utils";
import { DomainError } from "@/lib/domain-error";
import { assertISODateString } from "@/lib/time/istanbul";
import { audit } from "@/lib/audit";
import { formatIssues } from "@/lib/validation";
import { cache } from "@/lib/cache/engine";
import { CACHE_TAGS } from "@/lib/cache/tags";
import {
  addMonths,
  computeRisk,
  dueDateFor,
  type RiskThresholds,
} from "./rules";
import { APP_ROLES, DB_ROLE, can } from "@/lib/authz/matrix";

/* ── Bakım yazımları ve SALT-OKUR katmanlar ────────────────────────────────────────────────
 *
 * NE ÖLÇÜLDÜ. `/payments`, `/payments/calendar` ve `/payments/missing` ekranları RENDER
 * SIRASINDA yazma yapıyordu: `ensureWindow()` eksik ayları üretir, `refreshRiskFlags()` risk
 * bayrağı DEĞİŞMİŞ satırları UPDATE eder. Bu iki iş bakım işidir, kullanıcı aksiyonu değil —
 * ama render yolunda oldukları için sayfayı AÇAN kişinin yetkisiyle çalışıyorlardı.
 *
 * `viewer` ve `finance_approver` katmanları payment_instances üzerinde yalnız SELECT'e sahip
 * (matrix.ts: payment_instances → "operational"; policy: payment_instances_update_enter yalnız
 * operator/manager/admin). Dolayısıyla bu iki rol için UPDATE'i RLS reddediyor ve sayfa
 * "Server Components render" hatasıyla ÇÖKÜYORDU. Üretim sunucusunda birebir gözlendi:
 *
 *   viewer            /payments/calendar   → 42501 new row violates RLS policy
 *   finance_approver  /payments/missing    → 42501 new row violates RLS policy
 *
 * NEDEN ARALIKLI GÖRÜNÜYORDU. UPDATE yalnız bayrak GERÇEKTEN değiştiyse satır etkiler
 * (`where … risk_level is distinct from $2 …`). Bayraklar tazeyse sıfır satır döner ve hata
 * çıkmaz. Yani okuma-yalnız bir kullanıcı, bayraklar bayatladığı her an (gün dönümü, herhangi
 * bir veri değişikliği) çöken bir ekranla karşılaşıyordu — bazen de karşılaşmıyordu.
 *
 * SEÇİLEN ÇÖZÜM VE ELENEN İKİ ALTERNATİF.
 *   (a) `runAsSystem()` ile yükselt — ELENDİ. Okuma yolunu yazma yetkisine yükseltmek demek;
 *       /calendar ayı `?ym=` ile geldiği için salt-okur bir kullanıcı istediği ay için üretim
 *       tetikleyebilirdi. Finansal bir sistemde okuma isteğinin yetki yükseltmesi kabul edilemez.
 *   (b) 42501'i yakalayıp yutmak — ELENDİ. Güvenlik hatasını yutmak, gerçek bir yetki
 *       regresyonunu da sessizce gizler.
 *   (c) SEÇİLEN: bakım yazımı, çağıranın katmanı YAZABİLİYORSA yapılır; yazamıyorsa ATLANIR ve
 *       ekran mevcut veriyi gösterir. Yazabilen herhangi bir kullanıcının (veya açılıştaki
 *       `prepare-runtime.ts`'in) ziyareti veriyi tazeler.
 *
 * İZİN LİSTESİ TÜRETİLİR, ELLE YAZILMAZ. Aşağıdaki küme doğrudan authz matrisinden çıkar; RLS
 * politikaları da aynı matristen doğrulanır (`pnpm db:security-matrix:verify`). Elle yazılmış
 * bir rol listesi, politikalar değiştiği gün sessizce yanlışa düşerdi.
 */
const INSTANCE_MAINTENANCE_DB_ROLES: ReadonlySet<string> = new Set(
  APP_ROLES.filter((role) => can(role, "payment_instances", "insert") && can(role, "payment_instances", "update")).map(
    (role) => DB_ROLE[role],
  ),
);

/**
 * Bu bağlantının oturduğu katman payment_instances bakımını yapabilir mi?
 *
 * `current_user`, `src/lib/db.ts`'in her checkout'ta uyguladığı `set role` sonrasındaki KATMAN
 * rolüdür — yani sorunun cevabı bağlantının o anki gerçek yetkisidir, uygulamanın tahmini değil.
 * Katman yoksa (arka plan script'i, `runAsSystem` dışı) rol `mas_radar_app` olur ve zaten hiçbir
 * şey yazamaz; bu durumda da doğru cevap "hayır"dır.
 */
export async function tierMayMaintainInstances(pool: Pool): Promise<boolean> {
  const res = await pool.query<{ current_user: string }>("select current_user");
  return INSTANCE_MAINTENANCE_DB_ROLES.has(res.rows[0]?.current_user ?? "");
}

/**
 * "Bulunamadı" mı, "yetkiniz yok" mu? — bir mutasyonun kilit satırı boş döndüğünde.
 *
 * ═══ NEDEN AYIRT ETMEK ZORUNDAYIZ ═══
 *
 * Her örnek mutasyonu şöyle başlar:
 *
 *     select … from public.payment_instances where id=$1 for update
 *     if (rowCount !== 1) throw new DomainError("instance not found");
 *
 * `SELECT … FOR UPDATE`, RLS altında SELECT politikasını değil UPDATE politikasını uygular.
 * `viewer` ve `finance_approver` katmanlarının payment_instances üzerinde UPDATE politikası YOK,
 * dolayısıyla satır onlara kilitlenemez ve sorgu SIFIR satır döner — satır pekâlâ ORADA olmasına
 * rağmen. Kod bunu "bulunamadı" diye okuyordu ve kullanıcıya öyle söylüyordu.
 *
 * Üretim sunucusunda birebir gözlendi (viewer, /payments/missing, "ödendi" düğmesi):
 *
 *     /payments/missing?error=instance%20not%20found
 *
 * Bir finans kullanıcısı için bu mesaj YANLIŞ ve tehlikelidir: kaydın silindiğini ya da verinin
 * bozulduğunu düşündürür, oysa tek gerçek "bu işlemi yapma yetkiniz yok"tur. Yanlış teşhis,
 * sessiz başarısızlıktan bir adım daha kötüdür — kullanıcıyı olmayan bir sorunu kovalamaya yollar.
 *
 * Bu yüzden kilit boş döndüğünde satırın SELECT ile görünüp görünmediğine bakılır: görünüyorsa
 * sorun yetkidir, görünmüyorsa gerçekten yoktur.
 */
export async function instanceMissingReason(client: PoolClient, instanceId: string): Promise<DomainError> {
  const visible = await client.query(`select 1 from public.payment_instances where id=$1`, [instanceId]);
  if (visible.rowCount === 1) {
    return new DomainError(
      "Bu ödeme örneğini değiştirme yetkiniz yok. Kayıt duruyor; işlemi yapabilmek için " +
        "finans operatörü veya üstü bir rol gerekir.",
    );
  }
  return new DomainError("Ödeme örneği bulunamadı.");
}

/** The Slice-5 legacy-repair tooling is the ONLY thing that may pass null: it operates on a
 * frozen pre-0031 database (scripts/db/legacy-repair-verify.ts deliberately hides every
 * migration from 0030 onward, so public.users does not exist there) and null is the only
 * truthful actor in that world — the same value every pre-P0-A audit row already carries per
 * 0032 ("actor stays nullable here — every pre-P0-A row keeps actor=null forever"). On any
 * real, migrated database that tool resolves the reserved "system" account instead, and every
 * interactive/app path passes a real session user id typed `string` at its own call site. */
export type LegacyRepairActorId = string | null;

/** Returns the inserted row's id (RETURNING id) — existing callers that ignore the
 * resolved value are unaffected; Slice 5's repair flow collects it for its receipts.
 * `createdAt`, when given, overrides audit_logs' own `created_at` DEFAULT now() — used
 * only where a specific historical or transaction-shared timestamp must be recorded
 * instead of "when this INSERT happened to run". `actor` is nullable only for the case
 * LegacyRepairActorId documents. Deliberately NOT exported — an
 * arbitrary-action/entity/payload audit writer is too broad a surface to hand to
 * external tooling. legacy-repair-apply.ts gets only writeLegacyRepairSummaryWithClient
 * below, which hardcodes the one action/entity shape it's allowed to write. */

/* ── Slice 5 legacy repair — narrow audit-write surface ──
   Everything below is deliberately self-contained (its own tiny Zod validators, not
   imported from scripts/db/legacy-repair-types.ts — application code under src/ must not
   depend on a dev-tooling module under scripts/). Kept in sync with
   scripts/db/legacy-repair-types.ts's ReceiptCore/AppliedRepairResult shapes by the one
   place both are used together: legacy-repair-apply.ts. */

const sha256HexPattern = /^[0-9a-f]{64}$/;
const isoInstantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.(?:\d{3}|\d{6})Z$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const AppliedRepairResultSchema = z
  .object({
    instanceId: z.string().regex(uuidPattern),
    kind: z.enum(["archive_cascade_repair", "cancellation_metadata_repair"]),
    auditId: z.string().regex(uuidPattern),
    cancelledAt: z.string().regex(isoInstantPattern),
    beforeHash: z.string().regex(sha256HexPattern),
    afterHash: z.string().regex(sha256HexPattern),
  })
  .strict();

/** Result of one applied repair mutation — the audit row and the row it describes are
 * always recorded together, never as separately-sortable parallel arrays. */
export type AppliedRepairResult = z.infer<typeof AppliedRepairResultSchema>;

const LegacyRepairSummaryInputSchema = z
  .object({
    operationId: z.string().regex(uuidPattern),
    receiptCoreSha256: z.string().regex(sha256HexPattern),
    pendingFileSha256: z.string().regex(sha256HexPattern),
    inventoryFileSha256: z.string().regex(sha256HexPattern),
    approvalFileSha256: z.string().regex(sha256HexPattern),
    backupSha256: z.string().regex(sha256HexPattern),
    backupReceiptSha256: z.string().regex(sha256HexPattern),
    transactionTimestamp: z.string().regex(isoInstantPattern),
    appliedRepairs: z
      .array(AppliedRepairResultSchema)
      .min(1)
      .superRefine((repairs, ctx) => {
        const instanceIds = new Set<string>();
        const auditIds = new Set<string>();
        for (const r of repairs) {
          if (instanceIds.has(r.instanceId)) ctx.addIssue({ code: "custom", message: `duplicate instanceId: ${r.instanceId}` });
          instanceIds.add(r.instanceId);
          if (auditIds.has(r.auditId)) ctx.addIssue({ code: "custom", message: `duplicate auditId: ${r.auditId}` });
          auditIds.add(r.auditId);
        }
      }),
    untouchedScopeAfterHash: z.string().regex(sha256HexPattern),
  })
  .strict();

export type LegacyRepairSummaryInput = z.infer<typeof LegacyRepairSummaryInputSchema>;

/** The ONLY way legacy-repair-apply.ts (or any external script) may write an audit_logs
 * row through this module: action and entity_table are hardcoded, entity_id is always
 * null (this is a whole-operation summary, not tied to one row), and the payload shape
 * is strictly validated before the INSERT — no arbitrary action/entity/payload can ever
 * reach audit_logs through this function. `eventTimestamp` becomes the row's own
 * created_at (the shared transaction timestamp, not "when this INSERT happened to run"),
 * matching every other write in the same repair transaction. */
export async function writeLegacyRepairSummaryWithClient(
  client: PoolClient,
  input: LegacyRepairSummaryInput,
  eventTimestamp: string,
  actorId: LegacyRepairActorId,
): Promise<string> {
  const parsed = LegacyRepairSummaryInputSchema.safeParse(input);
  if (!parsed.success) {
    // Faz 18: was `parsed.error.message`, which in Zod v4 is a JSON dump of the raw issue
    // array. Since Faz 16 a DomainError's message is passed through to the client verbatim
    // (api-response.ts), so that dump was reachable from outside. formatIssues renders the
    // same failure as one readable line without the internal structure.
    throw new DomainError(`writeLegacyRepairSummaryWithClient: geçersiz input — ${formatIssues(parsed.error)}`);
  }
  return audit(client, {
    actor: actorId, action: "legacy_repair_summary", entityTable: "legacy_repair", entityId: null,
    before: null, after: parsed.data, createdAt: eventTimestamp,
  });
}

export async function loadThresholds(client: PoolClient | Pool): Promise<RiskThresholds> {
  return cache.withCache(
    "radar:thresholds",
    async () => {
      const r = await client.query(`select key, value from public.settings where key in
        ('large_payment_threshold_try','critical_payment_threshold_try','same_day_cluster_count')`);
      const v = (k: string, d: number) => {
        const row = r.rows.find((x) => x.key === k);
        return row ? Number(row.value) : d;
      };
      return {
        large: v("large_payment_threshold_try", 50_000),
        critical: v("critical_payment_threshold_try", 100_000),
        clusterCount: v("same_day_cluster_count", 3),
      };
    },
    { ttlSeconds: 300, tags: [CACHE_TAGS.CONTROLS] },
  );
}

/* ── 1) accepted candidates → payments ── */

export interface MapResult {
  eligible: number;
  created: number;
  skippedAlreadyMapped: number;
  excluded: Array<{ rowIndex: number; reason: string }>;
}

export async function mapAcceptedCandidates(pool: Pool, workbookId: string, actorId: string): Promise<MapResult> {
  const client = await pool.connect();
  try {
    await client.query("begin");

    const sheets = await client.query(
      `select id, sheet_name from public.source_sheets
       where workbook_id=$1 and detected_type='payment_day_matrix'`,
      [workbookId],
    );
    const result: MapResult = { eligible: 0, created: 0, skippedAlreadyMapped: 0, excluded: [] };

    for (const sheet of sheets.rows) {
      const rowsRes = await client.query<{
        id: string;
        row_index: number;
        row_json: RowJson;
        mapping_status: string;
        blocked: boolean;
      }>(
        `select ir.id, ir.row_index, ir.row_json, ir.mapping_status,
                exists (select 1 from public.mapping_reviews mr
                        where mr.import_row_id = ir.id and mr.status in ('open','rejected')) as blocked
         from public.import_rows ir
         where ir.sheet_id = $1
         order by ir.row_index`,
        [sheet.id],
      );
      const sheetRows: SheetRow[] = rowsRes.rows.map((r) => ({
        rowIndex: r.row_index,
        cells: r.row_json,
      }));
      const { candidates } = extractPaymentMatrix(sheetRows);
      const byIndex = new Map(rowsRes.rows.map((r) => [r.row_index, r]));

      for (const c of candidates) {
        const row = byIndex.get(c.rowIndex);
        if (!row) continue;
        if (!c.name) {
          result.excluded.push({ rowIndex: c.rowIndex, reason: "isimsiz (etiketsiz tutar)" });
          continue;
        }
        if (row.blocked) {
          result.excluded.push({ rowIndex: c.rowIndex, reason: "açık/ret inceleme" });
          continue;
        }
        result.eligible++;
        if (row.mapping_status === "mapped") {
          result.skippedAlreadyMapped++;
          continue;
        }
        const recurrence = c.dueDay != null ? "monthly" : "irregular";
        const amountConfidence =
          c.amountCandidate == null
            ? "unknown"
            : c.amountSource === "ag" || c.flags.includes("negative_amount")
              ? "variable"
              : "known";
        const ins = await client.query(
          `insert into public.payments
             (name, recurrence_type, due_day, default_amount, amount_confidence,
              direction, priority, status, source_workbook_id, source_sheet_id, source_row_id,
              source_notes)
           values ($1,$2,$3,$4,$5,'outflow','normal','active',$6,$7,$8,$9)
           returning id`,
          [
            c.name,
            recurrence,
            c.dueDay,
            c.amountCandidate, // null stays null — never zero
            amountConfidence,
            workbookId,
            sheet.id,
            row.id,
            c.flags.length ? `flags: ${c.flags.join(",")}` : null,
          ],
        );
        const paymentId: string = ins.rows[0].id;
        await client.query(
          `update public.import_rows
             set mapping_status='mapped', mapped_entity_table='payments', mapped_entity_id=$2
           where id=$1`,
          [row.id, paymentId],
        );
        await audit(client, {
          actor: actorId, action: "map_payment_candidate", entityTable: "payments", entityId: paymentId,
          before: null,
          after: {
            name: c.name,
            due_day: c.dueDay,
            default_amount: c.amountCandidate,
            source_row_id: row.id,
          },
        });
        result.created++;
      }
    }
    await client.query("commit");
    return result;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/* ── 2) idempotent instance generation ── */

export interface GenerateResult {
  monthStart: string;
  created: number;
  skippedExisting: number;
  shortMonthAdjusted: number;
}

export async function generateInstancesForMonthWithClient(
  client: PoolClient,
  monthStartISO: string,
  actorId: string,
): Promise<GenerateResult> {
  assertISODateString(monthStartISO);
  const payments = await client.query<{
    id: string;
    due_day: number;
    default_amount: string | null;
    amount_confidence: string;
    direction: string;
  }>(
    `select id, due_day, default_amount, amount_confidence, direction
     from public.payments
     where status='active' and recurrence_type='monthly' and due_day is not null
     order by id`,
  );
  let created = 0;
  let shortMonthAdjusted = 0;
  for (const p of payments.rows) {
    const d = dueDateFor(monthStartISO, p.due_day);
    if (d.shortMonthAdjusted) shortMonthAdjusted++;
    const amount = p.default_amount == null ? null : Number(p.default_amount);
    const amountStatus =
      amount == null ? "missing" : p.amount_confidence === "variable" ? "variable" : "known";
    const res = await client.query(
      `insert into public.payment_instances
         (payment_id, instance_month, due_date, amount, amount_status, direction, status, note, amount_source)
       values ($1,$2,$3,$4,$5,$6,'unpaid',$7,'generated')
       on conflict (payment_id, instance_month) where payment_id is not null do nothing`,
      [
        p.id,
        monthStartISO,
        d.dueDate,
        amount,
        amountStatus,
        p.direction,
        d.shortMonthAdjusted ? "short_month_adjustment" : null,
      ],
    );
    created += res.rowCount ?? 0;
  }
  // P1 — denetim kaydı yalnız GERÇEKTEN bir şey yaratıldığında yazılır.
  //
  // Bu satır eskiden koşulsuzdu ve tek başına zararsız görünüyordu: ayda bir satır. Ama tek
  // çağıran `ensureWindow(..., 24)`, yani `prepare-runtime`, bu fonksiyonu delta -1..24 için
  // 26 KEZ çağırır. Pencere zaten doluyken 26 çağrının 26'sı da `created = 0` döner ve yine de
  // 26 `generate_instances` satırı yazılırdı.
  //
  // Ölçüm (P24B Attempt-04, gerçek mas_radar_dev, 2026-09-03): tek bir `pnpm start` sonrası
  // payment_instances 502 → 502 (INSERT 0, UPDATE 0) iken audit_logs 788 → 814. Yani sıfır iş
  // için 26 kayıt. Bu, denetim kaydını olayların değil sunucu açılışlarının kaydına çeviriyordu
  // ve P24B soruşturmasında audit_logs okumayı zorlaştıran şeylerden biri buydu.
  //
  // Değişen tek şey bu koşul. Ufuk (24 ay), üretim mantığı, risk-flag yenilemesi, tarih/ay
  // semantiği, aktör kimliği ve `audit()` yardımcısının kendisi olduğu gibi duruyor:
  // `created > 0` olduğunda kayıt ve payload'ı bit-bazında eskisiyle aynı.
  if (created > 0) {
    await audit(client, {
      actor: actorId, action: "generate_instances", entityTable: "payment_instances", entityId: null,
      before: null,
      after: { monthStart: monthStartISO, created, total: payments.rowCount },
    });
  }
  return {
    monthStart: monthStartISO,
    created,
    skippedExisting: (payments.rowCount ?? 0) - created,
    shortMonthAdjusted,
  };
}

export async function generateInstancesForMonth(
  pool: Pool,
  monthStartISO: string,
  actorId: string,
): Promise<GenerateResult> {
  // Salt-okur katman: üretim ATLANIR (yukarıdaki uzun gerekçe). Sayfa mevcut örneklerle
  // render edilir; "hiç örnek yok" ile "üretemedim" karışmasın diye sonuç sıfırlarla döner.
  if (!(await tierMayMaintainInstances(pool))) {
    return { monthStart: monthStartISO, created: 0, skippedExisting: 0, shortMonthAdjusted: 0 };
  }
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await generateInstancesForMonthWithClient(client, monthStartISO, actorId);
    await client.query("commit");
    return result;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

export async function ensureWindow(
  pool: Pool,
  todayISO: string,
  actorId: string,
  futureMonths = 1,
): Promise<GenerateResult[]> {
  const run = async () => {
    const m0 = todayISO.slice(0, 7) + "-01";
    const out: GenerateResult[] = [];
    for (let delta = -1; delta <= Math.max(1, futureMonths); delta++) {
      const m = addMonths(m0, delta);
      out.push(await generateInstancesForMonth(pool, m, actorId));
    }
    await refreshRiskFlags(pool, todayISO);
    return out;
  };

  if (process.env.NODE_ENV === "test") {
    return run();
  }

  return cache.withCache(
    `radar:ensureWindow:${todayISO}:${futureMonths}`,
    run,
    { ttlSeconds: 120, tags: [CACHE_TAGS.PAYMENTS] }
  );
}

/* ── 3) risk refresh (window: prev..next month) ── */

export async function refreshRiskFlagsWithClient(client: PoolClient, todayISO: string): Promise<number> {
  assertISODateString(todayISO);
  const m0 = todayISO.slice(0, 7) + "-01";
  const from = addMonths(m0, -1);
  const to = addMonths(m0, 2);
  const t = await loadThresholds(client);
  const rows = await client.query<{
    id: string;
    due_date: string;
    amount: string | null;
    status: string;
    paid_amount: string | null;
    currency: string;
  }>(
    `select id, to_char(due_date,'YYYY-MM-DD') as due_date, amount, status, paid_amount, currency
     from public.payment_instances
     where instance_month >= $1 and instance_month < $2
     order by id`,
    [from, to],
  );
  const risks = computeRisk(
    rows.rows.map((r) => ({
      id: r.id,
      dueDate: r.due_date,
      amount: r.amount == null ? null : Number(r.amount),
      status: r.status,
      paidAmount: r.paid_amount == null ? null : Number(r.paid_amount),
      // PHASE 2.2: eşikler TRY; kolon `not null default 'TRY'` — yine de null gelirse bilinmiyor.
      currency: r.currency ?? null,
    })),
    todayISO,
    t,
  );
  let updated = 0;
  for (const [id, r] of risks) {
    const res = await client.query(
      `update public.payment_instances
         set risk_level=$2, risk_reasons=$3
       where id=$1 and (risk_level is distinct from $2 or risk_reasons is distinct from $3)`,
      [id, r.level, r.reasons],
    );
    updated += res.rowCount ?? 0;
  }
  return updated;
}

export async function refreshRiskFlags(pool: Pool, todayISO: string): Promise<number> {
  // Salt-okur katman: bayrak tazeleme ATLANIR. 0 döner çünkü GERÇEKTEN sıfır satır güncellendi;
  // çağıranların hiçbiri bu sayıyı "hata yok" kanıtı olarak kullanmıyor.
  if (!(await tierMayMaintainInstances(pool))) return 0;
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await refreshRiskFlagsWithClient(client, todayISO);
    await client.query("commit");
    return result;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/* ── 4) paid/unpaid + amount fill — every mutation audited ── */

const PAYABLE_FROM = new Set(["unpaid", "planned", "late", "partial"]);
const REVERSIBLE_FROM = new Set(["paid"]);

export async function markInstancePaid(
  pool: Pool,
  instanceId: string,
  paidAmount: number | null,
  actorId: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const before = await client.query(
      `select id, status, amount, paid_amount, paid_at from public.payment_instances where id=$1 for update`,
      [instanceId],
    );
    if (before.rowCount !== 1) throw await instanceMissingReason(client, instanceId);
    const currentStatus = before.rows[0].status as string;
    if (!PAYABLE_FROM.has(currentStatus)) {
      throw new DomainError(`payment_instances ${instanceId}: '${currentStatus}' durumundan ödendi işaretlenemez`);
    }
    const amount = before.rows[0].amount == null ? null : Number(before.rows[0].amount);
    const finalPaid = paidAmount ?? amount; // may stay null: unknown paid amount is honest
    await client.query(
      `update public.payment_instances
         set status='paid', paid_at=now(), paid_amount=$2
       where id=$1`,
      [instanceId, finalPaid],
    );
    await audit(client, {
      actor: actorId, action: "mark_paid", entityTable: "payment_instances", entityId: instanceId,
      before: before.rows[0], after: { status: "paid", paid_amount: finalPaid },
    });
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

export async function markInstanceUnpaid(pool: Pool, instanceId: string, actorId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const before = await client.query(
      `select id, status, paid_amount, paid_at from public.payment_instances where id=$1 for update`,
      [instanceId],
    );
    if (before.rowCount !== 1) throw await instanceMissingReason(client, instanceId);
    const currentStatus = before.rows[0].status as string;
    if (!REVERSIBLE_FROM.has(currentStatus)) {
      throw new DomainError(`payment_instances ${instanceId}: '${currentStatus}' durumundan geri alınamaz`);
    }
    await client.query(
      `update public.payment_instances
         set status='unpaid', paid_at=null, paid_amount=null
       where id=$1`,
      [instanceId],
    );
    await audit(client, {
      actor: actorId, action: "mark_unpaid", entityTable: "payment_instances", entityId: instanceId,
      before: before.rows[0], after: { status: "unpaid" },
    });
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

export async function markInstancePartial(pool: Pool, instanceId: string, paidAmount: number, actorId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const before = await client.query(
      `select id, status, amount, paid_amount from public.payment_instances where id=$1 for update`,
      [instanceId],
    );
    if (before.rowCount !== 1) throw await instanceMissingReason(client, instanceId);
    const currentStatus = before.rows[0].status as string;
    // Same source-status set as markInstancePaid: 'partial' and 'paid' are both "some payment
    // was recorded" outcomes reachable from exactly the same starting statuses (including
    // 'partial' itself, so correcting an already-recorded partial amount doesn't require
    // unmarking first). Was missing entirely — every call reached the DB trigger and failed
    // there instead, for every caller, always (found via scripts/seed-demo.ts against a
    // freshly migrated DB; migration 0033 closes the matching gap in the trigger's allow-list).
    if (!PAYABLE_FROM.has(currentStatus)) {
      throw new DomainError(`payment_instances ${instanceId}: '${currentStatus}' durumundan kısmi ödendi işaretlenemez`);
    }
    const total = before.rows[0].amount == null ? null : Number(before.rows[0].amount);
    if (!Number.isFinite(paidAmount) || paidAmount <= 0 || (total != null && paidAmount >= total)) {
      throw new DomainError("Kısmi tutar toplamdan küçük ve sıfırdan büyük olmalı");
    }
    await client.query(
      `update public.payment_instances set status='partial', paid_amount=$2, paid_at=now() where id=$1`,
      [instanceId, paidAmount],
    );
    await audit(client, {
      actor: actorId, action: "mark_partial", entityTable: "payment_instances", entityId: instanceId,
      before: before.rows[0], after: { status: "partial", paid_amount: paidAmount },
    });
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function setInstanceAmount(
  pool: Pool,
  instanceId: string,
  amount: number,
  actorId: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const before = await client.query<{
      id: string;
      amount: string | null;
      amount_status: string;
      amount_source: string;
    }>(
      `select id, amount, amount_status, amount_source from public.payment_instances where id=$1 for update`,
      [instanceId],
    );
    if (before.rowCount !== 1) throw await instanceMissingReason(client, instanceId);
    const b = before.rows[0];
    const currentAmount = b.amount == null ? null : Number(b.amount);
    // Re-entering the identical (amount, already-manual) state must not produce a
    // spurious UPDATE/audit/updated_at bump — but a source transition (e.g.
    // generated → manual at an unchanged numeric value) is a real, audited change.
    const noop = b.amount_status === "known" && b.amount_source === "manual" && currentAmount === amount;
    if (!noop) {
      await client.query(
        `update public.payment_instances set amount=$2, amount_status='known', amount_source='manual' where id=$1`,
        [instanceId, amount],
      );
      await audit(client, {
        actor: actorId, action: "set_instance_amount", entityTable: "payment_instances",
        entityId: instanceId, before: b,
        after: { amount, amount_status: "known", amount_source: "manual" },
      });
    }
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

const CANCELLABLE_FROM = new Set(["unpaid", "planned", "late"]);

/** Result of a cancellation mutation — carries the value actually persisted (read back
 * via RETURNING+to_char), never a JS-side approximation of "now". */
export interface CancellationResult {
  instanceId: string;
  auditId: string;
  cancelledAt: string;
}

/** Optional override for cancelInstanceWithClient — omitted entirely, every existing
 * production caller (cancelInstanceAction, transitions-verify.ts, etc.) keeps today's
 * exact behavior (auditAction="cancel_instance", cancelled_at=now()). Slice 5's legacy
 * repair flow is the only caller that supplies eventTimestamp, and it must be the SAME
 * transaction-wide timestamp used for every row and audit record in that repair. */
export interface CancellationContext {
  auditAction?: string;
  eventTimestamp?: string;
}

export async function cancelInstanceWithClient(
  client: PoolClient,
  instanceId: string,
  reason: string,
  actorId: LegacyRepairActorId,
  ctx?: CancellationContext,
): Promise<CancellationResult> {
  const trimmedReason = reason.trim();
  const before = await client.query(
    `select id, status, cancelled_at, cancel_reason from public.payment_instances where id=$1 for update`,
    [instanceId],
  );
  if (before.rowCount !== 1) throw await instanceMissingReason(client, instanceId);
  const currentStatus = before.rows[0].status as string;
  if (!CANCELLABLE_FROM.has(currentStatus)) {
    throw new DomainError(`payment_instances ${instanceId}: '${currentStatus}' durumundan iptal edilemez`);
  }
  const updated = await client.query<{ cancelled_at_iso: string }>(
    ctx?.eventTimestamp
      ? `update public.payment_instances set status='cancelled', cancelled_at=$2, cancel_reason=$3
         where id=$1
         returning to_char(cancelled_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cancelled_at_iso`
      : `update public.payment_instances set status='cancelled', cancelled_at=now(), cancel_reason=$2
         where id=$1
         returning to_char(cancelled_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cancelled_at_iso`,
    ctx?.eventTimestamp ? [instanceId, ctx.eventTimestamp, trimmedReason] : [instanceId, trimmedReason],
  );
  const cancelledAt = updated.rows[0].cancelled_at_iso;
  const auditId = await audit(client, {
    actor: actorId,
    action: ctx?.auditAction ?? "cancel_instance",
    entityTable: "payment_instances",
    entityId: instanceId,
    before: before.rows[0],
    after: { status: "cancelled", cancel_reason: trimmedReason },
    // Legacy repair backdates the row to when the change actually happened; see audit.ts.
    createdAt: ctx?.eventTimestamp,
  });
  return { instanceId, auditId, cancelledAt };
}

export async function cancelInstance(pool: Pool, instanceId: string, reason: string, actorId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await cancelInstanceWithClient(client, instanceId, reason, actorId);
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

export interface MetadataRepairResult {
  instanceId: string;
  auditId: string;
  cancelledAt: string;
}

/** Slice 5 legacy repair only — distinct from cancelInstanceWithClient because it does NOT
 * perform a status transition: the target row is already status='cancelled' with both
 * cancelled_at and cancel_reason null (the exact P0-B legacy-anomaly shape). This fills in
 * historically-accurate metadata for a cancellation that already happened, using a fixed,
 * evidence-derived cancelledAt supplied by the caller — never `now()`. The audit row's OWN
 * created_at is deliberately left at its DEFAULT now() (the repair is happening now; the
 * cancellation itself happened in the past — the two moments are not the same and must not
 * be conflated). */
export async function repairCancellationMetadataWithClient(
  client: PoolClient,
  instanceId: string,
  cancelledAt: string,
  cancelReason: string,
  actorId: LegacyRepairActorId,
): Promise<MetadataRepairResult> {
  const trimmedReason = cancelReason.trim();
  if (trimmedReason === "") {
    throw new DomainError(`payment_instances ${instanceId}: cancel_reason boş olamaz`);
  }
  const before = await client.query(
    `select id, status, cancelled_at, cancel_reason from public.payment_instances where id=$1 for update`,
    [instanceId],
  );
  if (before.rowCount !== 1) throw await instanceMissingReason(client, instanceId);
  const b = before.rows[0];
  if (b.status !== "cancelled" || b.cancelled_at !== null || b.cancel_reason !== null) {
    throw new DomainError(
      `payment_instances ${instanceId}: legacy metadata repair yalnız status='cancelled' ve cancelled_at/cancel_reason ikisi de null olan satırlar için geçerli`,
    );
  }
  const updated = await client.query<{ cancelled_at_iso: string }>(
    `update public.payment_instances set cancelled_at=$2, cancel_reason=$3
     where id=$1
     returning to_char(cancelled_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cancelled_at_iso`,
    [instanceId, cancelledAt, trimmedReason],
  );
  const resultCancelledAt = updated.rows[0].cancelled_at_iso;
  const auditId = await audit(client, {
    actor: actorId, action: "legacy_cancel_metadata_repair", entityTable: "payment_instances",
    entityId: instanceId, before: b,
    after: { cancelled_at: resultCancelledAt, cancel_reason: trimmedReason },
  });
  return { instanceId, auditId, cancelledAt: resultCancelledAt };
}

/* ── 5) reconciliation — propagates a payment template edit onto its already-generated,
   still-open (unpaid/planned; 'late' is excluded from all bulk/automatic mutation)
   future instances. Two independent per-row decisions:
   - due_date: recomputed from the new due_day, but only written if the recomputed
     date does not itself fall before todayISO — otherwise the row is left alone and
     the new due_day simply takes effect starting the next eligible month.
   - amount/amount_status: only touched when amount_source='generated'; 'manual' and
     'legacy_unknown' rows are never rewritten, regardless of due_date outcome.
   Every field is IS-DISTINCT-FROM-guarded in application code before being included
   in an UPDATE, so a true no-op row is never written (no updated_at bump, not counted). ── */

export interface ReconcileFields {
  dueDay: number | null;
  defaultAmount: number | null;
  amountConfidence: string;
}

export interface ReconcileResult {
  dueDateChanged: number;
  amountChanged: number;
  totalEligible: number;
}

const RECONCILIABLE_FROM = new Set(["unpaid", "planned"]);

export async function reconcileInstancesWithClient(
  client: PoolClient,
  paymentId: string,
  fields: ReconcileFields,
  todayISO: string,
  actorId: string,
): Promise<ReconcileResult> {
  assertISODateString(todayISO);
  const rows = await client.query<{
    id: string;
    instance_month: string;
    due_date: string;
    amount: string | null;
    amount_status: string;
    amount_source: string;
  }>(
    `select id, to_char(instance_month,'YYYY-MM-DD') as instance_month,
            to_char(due_date,'YYYY-MM-DD') as due_date,
            amount, amount_status, amount_source
     from public.payment_instances
     where payment_id=$1 and status = any($2) and due_date >= $3
     order by due_date, id
     for update`,
    [paymentId, Array.from(RECONCILIABLE_FROM), todayISO],
  );

  let dueDateChanged = 0;
  let amountChanged = 0;

  for (const row of rows.rows) {
    let applyDueDate = false;
    let candidateDueDate = row.due_date;
    if (fields.dueDay != null) {
      candidateDueDate = dueDateFor(row.instance_month, fields.dueDay).dueDate;
      applyDueDate = candidateDueDate >= todayISO && candidateDueDate !== row.due_date;
    }

    const currentAmount = row.amount == null ? null : Number(row.amount);
    let applyAmount = false;
    let candidateAmount: number | null = null;
    let candidateAmountStatus = "";
    if (row.amount_source === "generated") {
      candidateAmount = fields.defaultAmount;
      candidateAmountStatus =
        candidateAmount == null ? "missing" : fields.amountConfidence === "variable" ? "variable" : "known";
      applyAmount = candidateAmount !== currentAmount || candidateAmountStatus !== row.amount_status;
    }

    if (!applyDueDate && !applyAmount) continue;

    const setParts: string[] = [];
    const params: unknown[] = [row.id];
    if (applyDueDate) {
      params.push(candidateDueDate);
      setParts.push(`due_date=$${params.length}`);
    }
    if (applyAmount) {
      params.push(candidateAmount);
      setParts.push(`amount=$${params.length}`);
      params.push(candidateAmountStatus);
      setParts.push(`amount_status=$${params.length}`);
    }
    await client.query(`update public.payment_instances set ${setParts.join(", ")} where id=$1`, params);
    if (applyDueDate) dueDateChanged++;
    if (applyAmount) amountChanged++;
  }

  const totalEligible = rows.rowCount ?? 0;
  if (dueDateChanged > 0 || amountChanged > 0) {
    await audit(client, {
      actor: actorId, action: "reconcile_instances", entityTable: "payment_instances", entityId: null,
      before: null,
      after: { paymentId, dueDateChanged, amountChanged, totalEligible },
    });
  }

  return { dueDateChanged, amountChanged, totalEligible };
}
