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
import {
  addMonths,
  computeRisk,
  dueDateFor,
  type RiskThresholds,
} from "./rules";
import { createHash } from "node:crypto";
import { APP_ROLES, DB_ROLE, can } from "@/lib/authz/matrix";
import {
  evaluateAndRequestIfNeededWithClient,
  evaluateRulesWithClient,
} from "@/lib/approvals/engine";
import { PERIOD_LOCKED_USER_MESSAGE, translatePeriodLockError } from "@/lib/cashflow/period-lock";
import { ensurePartyIbanTrackedWithClient } from "@/lib/counterparties/engine";
import { isTurkishIban, isValidIbanChecksum, normalizeIban } from "@/lib/counterparties/rules";
import { decimal, moneyOrNull, round2 } from "@/lib/money";
import {
  postJournalEntryWithClient,
  safeReverseJournalForSourceWithClient,
} from "@/lib/ledger/posting-engine";

export function isValidTurkishIban(raw: string): boolean {
  const normalized = normalizeIban(raw);
  return isTurkishIban(normalized) && isValidIbanChecksum(normalized);
}

function isMissingSchemaError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  return code === "42P01" || code === "42703";
}

function currentIstanbulDateISO(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

async function isAccountingPeriodLockedWithClient(
  client: PoolClient,
  monthStartISO: string,
): Promise<boolean> {
  try {
    await client.query("savepoint sp_ap_lock_check");
    const res = await client.query(
      `select 1 from public.accounting_periods where period_month = $1::date and status = 'locked' limit 1`,
      [monthStartISO],
    );
    await client.query("release savepoint sp_ap_lock_check");
    return (res.rowCount ?? 0) > 0;
  } catch (err) {
    await client.query("rollback to savepoint sp_ap_lock_check").catch(() => undefined);
    await client.query("release savepoint sp_ap_lock_check").catch(() => undefined);
    if (isMissingSchemaError(err)) return false;
    if (err instanceof Error && err.message.includes("beklenmeyen SQL")) return false;
    throw err;
  }
}

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
                exists (
                  select 1
                    from public.mapping_reviews mr
                   where mr.import_row_id = ir.id
                     and (
                       mr.status in ('open', 'rejected')
                       or (
                         mr.issue_type in ('duplicate_payment', 'duplicate_payment_template')
                         and mr.status in ('open', 'rejected', 'resolved')
                       )
                     )
                ) as blocked
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

/* ── 2) idempotent instance generation & atomic payment creation (F-47) ── */

export interface CreatePaymentFields {
  name: string;
  recurrence_type: string;
  due_day?: number | null;
  due_date?: string | null;
  default_amount?: number | null;
  currency?: string | null;
  amount_confidence?: string;
  direction?: string;
  priority?: string;
  flexibility_class?: string | null;
  status?: string;
  category_id?: string | null;
  provider_party_id?: string | null;
  owner_party_id?: string | null;
  cash_account_id?: string | null;
  cost_center_id?: string | null;
  project_id?: string | null;
  department_id?: string | null;
  description?: string | null;
  iban?: string | null;
  tdhp_expense_code?: string | null;
  auto_match_vkn?: string | null;
  source_notes?: string | null;
}

export interface CreatePaymentResult {
  paymentId: string;
  createdInstanceIds: string[];
}

export interface TemplateScheduleInput {
  recurrence_type?: string | null;
  source_notes?: string | null;
  due_day?: number | null;
  due_date?: string | null;
  created_iso?: string | null;
  default_amount?: string | number | null;
}

export interface ComputedMonthSchedule {
  effectiveRecurrence: "monthly" | "weekly" | "quarterly" | "yearly" | "one_off";
  dueDate: string;
  shortMonthAdjusted: boolean;
  amount: number | null;
  weeksInMonth: number;
  note: string | null;
}

export function resolveEffectiveRecurrence(
  recurrenceType: string | null | undefined,
  sourceNotes?: string | null,
): string {
  const raw = (recurrenceType ?? "monthly").trim();
  if (raw === "quarterly") return "quarterly";
  if (raw === "irregular" && typeof sourceNotes === "string" && sourceNotes.includes("freq:quarterly")) {
    return "quarterly";
  }
  return raw || "monthly";
}

export function computeInstanceScheduleForMonth(
  p: TemplateScheduleInput,
  monthStartISO: string,
): ComputedMonthSchedule | null {
  const eff = resolveEffectiveRecurrence(p.recurrence_type, p.source_notes);
  const tYear = Number(monthStartISO.slice(0, 4));
  const tMonth = Number(monthStartISO.slice(5, 7)); // 1..12
  const daysInMonth = new Date(Date.UTC(tYear, tMonth, 0)).getUTCDate();

  const explicitDueISO =
    typeof p.due_date === "string" && /^\d{4}-\d{2}-\d{2}/.test(p.due_date)
      ? p.due_date.slice(0, 10)
      : null;
  const createdISO =
    typeof p.created_iso === "string" && /^\d{4}-\d{2}-\d{2}/.test(p.created_iso)
      ? p.created_iso.slice(0, 10)
      : null;
  const anchorISO = explicitDueISO ?? createdISO ?? monthStartISO;
  const aYear = Number(anchorISO.slice(0, 4));
  const aMonth = Number(anchorISO.slice(5, 7));
  const monthDiff = (tYear - aYear) * 12 + (tMonth - aMonth);

  const unitAmount = p.default_amount == null ? null : round2(decimal(p.default_amount));

  if (eff === "monthly") {
    if (p.due_day == null) return null;
    if (explicitDueISO && monthDiff < 0) return null;
    const d = dueDateFor(monthStartISO, Number(p.due_day));
    return {
      effectiveRecurrence: "monthly",
      dueDate: d.dueDate,
      shortMonthAdjusted: d.shortMonthAdjusted,
      amount: unitAmount,
      weeksInMonth: 1,
      note: d.shortMonthAdjusted ? "short_month_adjustment" : null,
    };
  }

  if (eff === "weekly") {
    if (explicitDueISO && monthDiff < 0) return null;
    let firstDay = 1;
    if (p.due_day != null) {
      firstDay = ((Math.max(1, Number(p.due_day)) - 1) % 7) + 1;
    } else {
      const anchorDow = new Date(`${anchorISO}T00:00:00Z`).getUTCDay();
      const monthDow = new Date(`${monthStartISO}T00:00:00Z`).getUTCDay();
      firstDay = 1 + ((anchorDow - monthDow + 7) % 7);
    }
    let weeksInMonth = 0;
    for (let day = firstDay; day <= daysInMonth; day += 7) {
      weeksInMonth += 1;
    }
    const safeWeeks = Math.max(1, weeksInMonth);
    const firstDueDate = `${monthStartISO.slice(0, 7)}-${String(firstDay).padStart(2, "0")}`;
    const aggregatedAmount =
      unitAmount == null ? null : round2(decimal(unitAmount).times(safeWeeks));
    return {
      effectiveRecurrence: "weekly",
      dueDate: firstDueDate,
      shortMonthAdjusted: false,
      amount: aggregatedAmount,
      weeksInMonth: safeWeeks,
      note: `weekly_x${safeWeeks}`,
    };
  }

  if (eff === "quarterly") {
    if (monthDiff < 0 || monthDiff % 3 !== 0) return null;
    const targetDay = p.due_day != null ? Number(p.due_day) : Number(anchorISO.slice(8, 10)) || 1;
    const d = dueDateFor(monthStartISO, targetDay);
    return {
      effectiveRecurrence: "quarterly",
      dueDate: d.dueDate,
      shortMonthAdjusted: d.shortMonthAdjusted,
      amount: unitAmount,
      weeksInMonth: 1,
      note: d.shortMonthAdjusted ? "short_month_adjustment" : "quarterly",
    };
  }

  if (eff === "yearly") {
    if (monthDiff < 0 || monthDiff % 12 !== 0) return null;
    const targetDay = p.due_day != null ? Number(p.due_day) : Number(anchorISO.slice(8, 10)) || 1;
    const d = dueDateFor(monthStartISO, targetDay);
    return {
      effectiveRecurrence: "yearly",
      dueDate: d.dueDate,
      shortMonthAdjusted: d.shortMonthAdjusted,
      amount: unitAmount,
      weeksInMonth: 1,
      note: d.shortMonthAdjusted ? "short_month_adjustment" : "yearly",
    };
  }

  if (eff === "one_off") {
    if (!explicitDueISO || explicitDueISO.slice(0, 7) !== monthStartISO.slice(0, 7)) return null;
    return {
      effectiveRecurrence: "one_off",
      dueDate: explicitDueISO,
      shortMonthAdjusted: false,
      amount: unitAmount,
      weeksInMonth: 1,
      note: null,
    };
  }

  return null;
}

async function validateAndTrackTemplateIbanWithClient(
  client: PoolClient,
  params: {
    rawIban?: string | null;
    providerPartyId?: string | null;
    currency: string;
    label: string;
  },
  actorId: string,
): Promise<string | null> {
  const trimmed = params.rawIban?.trim() ?? "";
  if (!trimmed) return null;
  const normalized = normalizeIban(trimmed);
  if (!isValidTurkishIban(normalized)) {
    throw new DomainError(
      "VALIDATION",
      "Geçersiz TR IBAN formatı veya kontrol basamağı (26 karakter ve MOD-97 uyumlu olmalıdır).",
    );
  }
  const partyId = params.providerPartyId?.trim() || null;
  if (partyId) {
    try {
      await client.query("savepoint sp_pay_iban_vault");
      await ensurePartyIbanTrackedWithClient(
        client,
        {
          partyId,
          iban: normalized,
          currency: params.currency,
          accountLabel: params.label,
        },
        actorId,
      );
      await client.query("release savepoint sp_pay_iban_vault");
    } catch (err) {
      await client.query("rollback to savepoint sp_pay_iban_vault").catch(() => undefined);
      await client.query("release savepoint sp_pay_iban_vault").catch(() => undefined);
      if (isMissingSchemaError(err)) return normalized;
      if (err instanceof Error && err.message.includes("beklenmeyen SQL")) return normalized;
      throw err;
    }
  }
  return normalized;
}

/**
 * F-47 + M-14 + M-16: Atomically inserts a `public.payments` row AND generates its initial
 * `public.payment_instances` row(s) inside the SAME database transaction — preserving `currency`,
 * 0119 template fields (`iban`, `tdhp_expense_code`, `auto_match_vkn`), and full frequency math.
 */
export async function createPaymentWithClient(
  client: PoolClient,
  fields: CreatePaymentFields,
  todayISO: string,
  actorId: string,
): Promise<CreatePaymentResult> {
  assertISODateString(todayISO);
  const trimmedName = (fields.name ?? "").trim();
  if (!trimmedName) {
    throw new DomainError("VALIDATION", "Ad zorunlu.");
  }

  const requestedRecurrence = (fields.recurrence_type ?? "monthly").trim();
  const isQuarterly = requestedRecurrence === "quarterly";
  const dbRecurrenceType = isQuarterly ? "irregular" : requestedRecurrence;
  const sourceNotes = isQuarterly
    ? [fields.source_notes, "freq:quarterly"].filter(Boolean).join(" ") || "freq:quarterly"
    : fields.source_notes ?? null;

  const dueDay = fields.due_day ?? null;
  const rawDueDate = fields.due_date ? fields.due_date.trim() : null;

  if (requestedRecurrence === "monthly" && (dueDay == null || dueDay < 1 || dueDay > 31)) {
    throw new DomainError("VALIDATION", "Aylık tekrar için 1-31 arası gün zorunlu.");
  }
  if (dueDay != null && (dueDay < 1 || dueDay > 31)) {
    throw new DomainError("VALIDATION", "Gün 1-31 arası olmalı.");
  }

  let resolvedTargetDueDate: string | null = rawDueDate;
  if (resolvedTargetDueDate) {
    assertISODateString(resolvedTargetDueDate);
  } else if (requestedRecurrence === "one_off") {
    if (dueDay != null) {
      resolvedTargetDueDate = dueDateFor(`${todayISO.slice(0, 7)}-01`, dueDay).dueDate;
    } else {
      throw new DomainError("VALIDATION", "Tek seferlik ödeme için vade tarihi zorunludur.");
    }
  } else if ((requestedRecurrence === "quarterly" || requestedRecurrence === "yearly") && !resolvedTargetDueDate) {
    resolvedTargetDueDate = dueDateFor(`${todayISO.slice(0, 7)}-01`, dueDay ?? 1).dueDate;
  }

  const defaultAmount = fields.default_amount ?? null;
  const currency = (fields.currency ?? "TRY")?.trim().toUpperCase() || "TRY";
  const amountConfidence = fields.amount_confidence ?? "known";
  const direction = fields.direction ?? "outflow";
  const priority = fields.priority ?? "normal";
  const status = fields.status ?? "active";

  const validatedIban = await validateAndTrackTemplateIbanWithClient(
    client,
    {
      rawIban: fields.iban,
      providerPartyId: fields.provider_party_id,
      currency,
      label: trimmedName,
    },
    actorId,
  );

  const insPay = await client.query<{ id: string }>(
    `insert into public.payments
       (name, recurrence_type, due_day, due_date, default_amount, currency, amount_confidence,
        direction, priority, flexibility_class, status, category_id, provider_party_id, owner_party_id,
        cash_account_id, cost_center_id, project_id, department_id, description, source_notes)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
     returning id::text as id`,
    [
      trimmedName,
      dbRecurrenceType,
      dueDay,
      resolvedTargetDueDate,
      defaultAmount,
      currency,
      amountConfidence,
      direction,
      priority,
      fields.flexibility_class ?? null,
      status,
      fields.category_id ?? null,
      fields.provider_party_id ?? null,
      fields.owner_party_id ?? null,
      fields.cash_account_id ?? null,
      fields.cost_center_id ?? null,
      fields.project_id ?? null,
      fields.department_id ?? null,
      fields.description ?? null,
      sourceNotes,
    ],
  );
  const paymentId = insPay.rows[0].id;

  if (fields.iban !== undefined || fields.tdhp_expense_code !== undefined || fields.auto_match_vkn !== undefined) {
    try {
      await client.query("savepoint sp_pay_0119_cols");
      await client.query(
        `update public.payments
            set iban = $2,
                tdhp_expense_code = coalesce($3, '770'),
                auto_match_vkn = $4
          where id = $1`,
        [
          paymentId,
          validatedIban,
          fields.tdhp_expense_code?.trim() || "770",
          fields.auto_match_vkn?.trim() || null,
        ],
      );
      await client.query("release savepoint sp_pay_0119_cols");
    } catch (err) {
      await client.query("rollback to savepoint sp_pay_0119_cols").catch(() => undefined);
      await client.query("release savepoint sp_pay_0119_cols").catch(() => undefined);
      if (!isMissingSchemaError(err)) throw err;
    }
  }

  await audit(client, {
    actor: actorId,
    action: "create_payment",
    entityTable: "payments",
    entityId: paymentId,
    before: null,
    after: {
      ...fields,
      name: trimmedName,
      recurrence_type: requestedRecurrence,
      due_day: dueDay,
      due_date: resolvedTargetDueDate,
      default_amount: defaultAmount,
      currency,
      amount_confidence: amountConfidence,
      direction,
      priority,
      status,
    },
  });

  const createdInstanceIds: string[] = [];

  if (status === "active") {
    if (
      requestedRecurrence === "one_off" ||
      (requestedRecurrence === "irregular" && resolvedTargetDueDate != null)
    ) {
      const dueDateISO = resolvedTargetDueDate!;
      const instanceMonth = `${dueDateISO.slice(0, 7)}-01`;
      const lockedMonth = await client.query(
        `select 1 from public.cashflow_months where month_start = $1::date and status = 'locked'`,
        [instanceMonth],
      );
      const apLocked = await isAccountingPeriodLockedWithClient(client, instanceMonth);
      if ((lockedMonth.rowCount ?? 0) > 0 || apLocked) {
        throw new DomainError("CONFLICT", PERIOD_LOCKED_USER_MESSAGE);
      }

      const amountStatus =
        defaultAmount == null
          ? "missing"
          : amountConfidence === "variable"
            ? "variable"
            : "known";

      const insInst = await client.query<{ id: string }>(
        `insert into public.payment_instances
           (payment_id, instance_month, due_date, amount, currency, amount_status, direction, status, note, amount_source)
         values ($1, $2::date, $3::date, $4::numeric, $5, $6, $7, 'unpaid', null, 'generated')
         on conflict (payment_id, instance_month) where payment_id is not null do nothing
         returning id::text as id`,
        [paymentId, instanceMonth, dueDateISO, defaultAmount, currency, amountStatus, direction],
      );
      const createdId = insInst.rows[0]?.id;
      if (createdId) {
        createdInstanceIds.push(createdId);
      }

      await refreshRiskFlagsWithClient(client, todayISO);

      if (createdId && direction === "outflow" && defaultAmount != null) {
        const evaluated = await evaluateAndRequestIfNeededWithClient(client, {
          ruleInput: {
            subjectTable: "payment_instances",
            triggerKind: "payment",
            amount: String(defaultAmount),
            currency,
          },
          subjectId: createdId,
          subjectLabel: `${trimmedName} (${dueDateISO})`,
          amount: defaultAmount,
          currency,
          actorId,
        });
        if (evaluated.approvalId) {
          await client.query(
            `update public.payment_instances
                set approval_status = 'pending_approval', approval_id = $2
              where id = $1`,
            [createdId, evaluated.approvalId],
          );
        }
      }
    } else if (
      requestedRecurrence === "monthly" ||
      requestedRecurrence === "weekly" ||
      requestedRecurrence === "quarterly" ||
      requestedRecurrence === "yearly"
    ) {
      const m0 = `${todayISO.slice(0, 7)}-01`;
      const maxHorizon =
        requestedRecurrence === "yearly" ? 12 : requestedRecurrence === "quarterly" ? 3 : 1;
      const minDelta = requestedRecurrence === "monthly" || requestedRecurrence === "weekly" ? -1 : 0;
      for (let delta = minDelta; delta <= maxHorizon; delta++) {
        await generateInstancesForMonthWithClient(client, addMonths(m0, delta), actorId);
      }
      await refreshRiskFlagsWithClient(client, todayISO);

      const instRows = await client.query<{
        id: string;
        due_date: string;
        amount: string | null;
        currency: string;
      }>(
        `select id::text as id,
                to_char(due_date, 'YYYY-MM-DD') as due_date,
                amount::text as amount,
                currency
           from public.payment_instances
          where payment_id = $1
          order by due_date asc`,
        [paymentId],
      );
      for (const r of instRows.rows) {
        createdInstanceIds.push(r.id);
        if (direction === "outflow" && r.amount != null) {
          const evaluated = await evaluateAndRequestIfNeededWithClient(client, {
            ruleInput: {
              subjectTable: "payment_instances",
              triggerKind: "payment",
              amount: r.amount,
              currency: r.currency,
            },
            subjectId: r.id,
            subjectLabel: `${trimmedName} (${r.due_date})`,
            amount: Number(r.amount),
            currency: r.currency,
            actorId,
          });
          if (evaluated.approvalId) {
            await client.query(
              `update public.payment_instances
                  set approval_status = 'pending_approval', approval_id = $2
                where id = $1`,
              [r.id, evaluated.approvalId],
            );
          }
        }
      }
    }
  }

  return { paymentId, createdInstanceIds };
}

export async function createPayment(
  pool: Pool,
  fields: CreatePaymentFields,
  todayISO: string,
  actorId: string,
): Promise<CreatePaymentResult> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await createPaymentWithClient(client, fields, todayISO, actorId);
    await client.query("commit");
    return result;
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    translatePeriodLockError(e);
  } finally {
    client.release();
  }
}

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
  const lockedMonth = await client.query(
    `select 1 from public.cashflow_months where month_start = $1::date and status = 'locked'`,
    [monthStartISO],
  );
  if ((lockedMonth.rowCount ?? 0) > 0) {
    return { monthStart: monthStartISO, created: 0, skippedExisting: 0, shortMonthAdjusted: 0 };
  }
  if (await isAccountingPeriodLockedWithClient(client, monthStartISO)) {
    return { monthStart: monthStartISO, created: 0, skippedExisting: 0, shortMonthAdjusted: 0 };
  }
  const payments = await client.query<{
    id: string;
    name?: string | null;
    due_day: number | null;
    due_date?: string | null;
    created_iso?: string | null;
    default_amount: string | null;
    currency?: string | null;
    recurrence_type?: string | null;
    source_notes?: string | null;
    amount_confidence: string;
    direction: string;
  }>(
    `select id,
            name,
            due_day,
            to_char(due_date, 'YYYY-MM-DD') as due_date,
            to_char(created_at, 'YYYY-MM-DD') as created_iso,
            default_amount,
            coalesce(currency, 'TRY') as currency,
            recurrence_type,
            source_notes,
            amount_confidence,
            direction
       from public.payments
      where status = 'active'
        and archived_at is null
        and (recurrence_type <> 'monthly' or due_day is not null)
      order by id`,
  );
  let created = 0;
  let eligibleCount = 0;
  let shortMonthAdjusted = 0;
  for (const p of payments.rows) {
    const sched = computeInstanceScheduleForMonth(p, monthStartISO);
    if (!sched) continue;
    eligibleCount++;
    if (sched.shortMonthAdjusted) shortMonthAdjusted++;
    const amount = sched.amount;
    const currency =
      typeof p.currency === "string" && p.currency.trim()
        ? p.currency.trim().toUpperCase()
        : "TRY";
    const amountStatus =
      amount == null ? "missing" : p.amount_confidence === "variable" ? "variable" : "known";
    const res = await client.query<{ id?: string }>(
      `insert into public.payment_instances
         (payment_id, instance_month, due_date, amount, currency, amount_status, direction, status, note, amount_source)
       values ($1,$2,$3,$4,$5,$6,$7,'unpaid',$8,'generated')
       on conflict (payment_id, instance_month) where payment_id is not null do nothing
       returning id::text as id`,
      [
        p.id,
        monthStartISO,
        sched.dueDate,
        amount,
        currency,
        amountStatus,
        p.direction,
        sched.note,
      ],
    );
    const insertedCount = res.rowCount ?? 0;
    created += insertedCount;
    const createdInstId = insertedCount === 1 ? res.rows[0]?.id : undefined;
    if (createdInstId && (p.direction ?? "outflow") === "outflow" && amount != null) {
      const paymentLabel =
        typeof p.name === "string" && p.name.trim() ? p.name.trim() : "Planlı ödeme";
      try {
        await client.query("savepoint sp_gen_inst_approval");
        const evaluated = await evaluateAndRequestIfNeededWithClient(client, {
          ruleInput: {
            subjectTable: "payment_instances",
            triggerKind: "payment",
            amount,
            currency,
          },
          subjectId: createdInstId,
          subjectLabel: `${paymentLabel} (${sched.dueDate})`,
          amount,
          currency,
          actorId,
        });
        if (evaluated.approvalId) {
          await client.query(
            `update public.payment_instances
                set approval_status = 'pending_approval', approval_id = $2
              where id = $1`,
            [createdInstId, evaluated.approvalId],
          );
        }
        await client.query("release savepoint sp_gen_inst_approval");
      } catch (err) {
        await client.query("rollback to savepoint sp_gen_inst_approval").catch(() => undefined);
        await client.query("release savepoint sp_gen_inst_approval").catch(() => undefined);
        if (!isMissingSchemaError(err) && !(err instanceof Error && err.message.includes("beklenmeyen SQL"))) {
          throw err;
        }
      }
    }
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
      after: { monthStart: monthStartISO, created, total: eligibleCount },
    });
  }
  return {
    monthStart: monthStartISO,
    created,
    skippedExisting: Math.max(0, eligibleCount - created),
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
  const m0 = todayISO.slice(0, 7) + "-01";
  const out: GenerateResult[] = [];
  for (let delta = -1; delta <= Math.max(1, futureMonths); delta++) {
    const m = addMonths(m0, delta);
    out.push(await generateInstancesForMonth(pool, m, actorId));
  }
  await refreshRiskFlags(pool, todayISO);
  return out;
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
    instance_month?: string;
    due_date: string;
    amount: string | null;
    status: string;
    paid_amount: string | null;
    currency: string;
  }>(
    `select i.id,
            to_char(i.instance_month,'YYYY-MM-DD') as instance_month,
            to_char(i.due_date,'YYYY-MM-DD') as due_date,
            i.amount,
            i.status,
            i.paid_amount,
            i.currency
       from public.payment_instances i
       left join public.payments p on p.id = i.payment_id
      where (
              (i.instance_month >= $1 and i.instance_month < $2)
              or (
                i.status in ('unpaid','planned','partial','late')
                and i.due_date < $3::date
                and (p.id is null or (p.status <> 'archived' and p.archived_at is null))
              )
            )
        and not exists (
          select 1 from public.cashflow_months cm
          where cm.status = 'locked'
            and cm.month_start in (
              i.instance_month,
              date_trunc('month', i.due_date)::date,
              case when i.paid_at is not null then date_trunc('month', (i.paid_at at time zone 'Europe/Istanbul')::date)::date else null end
            )
        )
      order by i.id`,
    [from, to, todayISO],
  );

  const lockedCache = new Map<string, boolean>();
  const checkLocked = async (monthISO: string): Promise<boolean> => {
    const cached = lockedCache.get(monthISO);
    if (cached !== undefined) return cached;
    const locked = await isAccountingPeriodLockedWithClient(client, monthISO);
    lockedCache.set(monthISO, locked);
    return locked;
  };

  const unlockedRows: typeof rows.rows = [];
  for (const r of rows.rows) {
    const instMonth = r.instance_month ?? `${r.due_date.slice(0, 7)}-01`;
    const dueMonth = `${r.due_date.slice(0, 7)}-01`;
    if ((await checkLocked(instMonth)) || (dueMonth !== instMonth && (await checkLocked(dueMonth)))) {
      continue;
    }
    unlockedRows.push(r);
  }

  const risks = computeRisk(
    unlockedRows.map((r) => ({
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
const REVERSIBLE_FROM = new Set(["paid", "partial"]);

export interface SettlementOptions {
  cashAccountId?: string | null;
  settledDateISO?: string | null;
}

async function syncInstanceSettlementArtifactsWithClient(
  client: PoolClient,
  input: {
    instanceId: string;
    previousPaidAmount: number;
    totalPaidAmount: number | null;
    status: "paid" | "partial";
    cashAccountId?: string | null;
    settledDateISO?: string | null;
    actorId: string;
  },
): Promise<{ cashAccountId: string | null; bankTransactionId: string | null; journalEntryId: string | null }> {
  if (input.totalPaidAmount == null || input.totalPaidAmount <= 0) {
    return { cashAccountId: null, bankTransactionId: null, journalEntryId: null };
  }

  const deltaAmount = round2(
    decimal(input.totalPaidAmount).minus(decimal(Math.max(0, input.previousPaidAmount))),
  );
  const effectiveAmount = deltaAmount > 0 ? deltaAmount : round2(decimal(input.totalPaidAmount));
  if (effectiveAmount <= 0) {
    return { cashAccountId: null, bankTransactionId: null, journalEntryId: null };
  }

  try {
    await client.query("savepoint sp_pi_settle_bridge");

    const metaRes = await client.query<{
      id: string;
      payment_id: string | null;
      due_date: string;
      currency: string;
      direction: string;
      paid_from_account_id: string | null;
      payment_name: string | null;
      template_cash_account_id: string | null;
      provider_party_id: string | null;
      cost_center_id: string | null;
      project_id: string | null;
      department_id: string | null;
    }>(
      `select i.id::text as id,
              i.payment_id::text as payment_id,
              to_char(i.due_date, 'YYYY-MM-DD') as due_date,
              coalesce(i.currency, p.currency, 'TRY') as currency,
              coalesce(i.direction, p.direction, 'outflow') as direction,
              i.paid_from_account_id::text as paid_from_account_id,
              p.name as payment_name,
              p.cash_account_id::text as template_cash_account_id,
              p.provider_party_id::text as provider_party_id,
              p.cost_center_id::text as cost_center_id,
              p.project_id::text as project_id,
              p.department_id::text as department_id
         from public.payment_instances i
         left join public.payments p on p.id = i.payment_id
        where i.id = $1
        limit 1`,
      [input.instanceId],
    );
    if (metaRes.rowCount !== 1) {
      await client.query("release savepoint sp_pi_settle_bridge");
      return { cashAccountId: null, bankTransactionId: null, journalEntryId: null };
    }
    const meta = metaRes.rows[0];

    let linkedInvoiceId: string | null = null;
    let tdhpExpenseCode = "770";
    try {
      await client.query("savepoint sp_pi_0119_read");
      const extRes = await client.query<{
        linked_invoice_id: string | null;
        tdhp_expense_code: string | null;
      }>(
        `select i.linked_invoice_id::text as linked_invoice_id,
                coalesce(p.tdhp_expense_code, '770') as tdhp_expense_code
           from public.payment_instances i
           left join public.payments p on p.id = i.payment_id
          where i.id = $1
          limit 1`,
        [input.instanceId],
      );
      if (extRes.rowCount === 1) {
        linkedInvoiceId = extRes.rows[0].linked_invoice_id;
        tdhpExpenseCode = (extRes.rows[0].tdhp_expense_code ?? "770").trim() || "770";
      }
      await client.query("release savepoint sp_pi_0119_read");
    } catch (err) {
      await client.query("rollback to savepoint sp_pi_0119_read").catch(() => undefined);
      await client.query("release savepoint sp_pi_0119_read").catch(() => undefined);
      if (!isMissingSchemaError(err)) throw err;
    }

    const explicitAccountId = input.cashAccountId?.trim() || null;
    const candidateAccountId =
      explicitAccountId ?? meta.paid_from_account_id ?? meta.template_cash_account_id ?? null;

    let resolvedAccount: {
      id: string;
      name: string;
      account_type: string;
      currency: string;
      has_bank_account: boolean;
    } | null = null;

    if (candidateAccountId) {
      const accRes = await client.query<{
        id: string;
        name: string;
        account_type: string;
        currency: string;
        has_bank_account: boolean;
      }>(
        `select ca.id::text as id,
                ca.name,
                ca.account_type,
                ca.currency,
                (ba.cash_account_id is not null) as has_bank_account
           from public.cash_accounts ca
           left join public.bank_accounts ba on ba.cash_account_id = ca.id
          where ca.id = $1
            and ca.is_active = true
          limit 1`,
        [candidateAccountId],
      );
      if (accRes.rowCount === 1) {
        if (accRes.rows[0].currency !== meta.currency) {
          if (explicitAccountId) {
            throw new DomainError(
              "VALIDATION",
              `Seçilen kasa/banka hesabı döviz cinsi (${accRes.rows[0].currency}) ödeme döviz cinsi (${meta.currency}) ile uyuşmuyor.`,
            );
          }
        } else {
          resolvedAccount = accRes.rows[0];
        }
      }
    }

    if (!resolvedAccount) {
      const fallbackRes = await client.query<{
        id: string;
        name: string;
        account_type: string;
        currency: string;
        has_bank_account: boolean;
      }>(
        `select ca.id::text as id,
                ca.name,
                ca.account_type,
                ca.currency,
                (ba.cash_account_id is not null) as has_bank_account
           from public.cash_accounts ca
           left join public.bank_accounts ba on ba.cash_account_id = ca.id
          where ca.is_active = true
            and ca.currency = $1
            and ca.account_type in ('bank_account', 'cash')
          order by (ba.cash_account_id is not null) desc, ca.created_at asc
          limit 1`,
        [meta.currency],
      );
      if (fallbackRes.rowCount === 1) {
        resolvedAccount = fallbackRes.rows[0];
      }
    }

    const entryDateISO =
      input.settledDateISO && /^\d{4}-\d{2}-\d{2}$/.test(input.settledDateISO)
        ? input.settledDateISO
        : currentIstanbulDateISO();

    let bankTransactionId: string | null = null;
    if (resolvedAccount && resolvedAccount.has_bank_account) {
      const signedAmount =
        meta.direction === "inflow" ? effectiveAmount : -Math.abs(effectiveAmount);
      const dedupeHash = createHash("sha256")
        .update(
          `payment_instance_settle:${input.instanceId}:${input.status}:${input.totalPaidAmount.toFixed(2)}`,
        )
        .digest("hex");
      const txKind =
        tdhpExpenseCode === "360" || tdhpExpenseCode === "361"
          ? "tax_payment"
          : tdhpExpenseCode === "335"
            ? "payroll"
            : "standard";
      const label = meta.payment_name ?? "Planlı ödeme";

      const existingBt = await client.query<{ id: string }>(
        `select id::text as id
           from public.bank_transactions
          where bank_account_id = $1
            and dedupe_hash = $2
          limit 1`,
        [resolvedAccount.id, dedupeHash],
      );
      if (existingBt.rowCount === 1) {
        bankTransactionId = existingBt.rows[0].id;
      } else {
        const insBt = await client.query<{ id: string }>(
          `insert into public.bank_transactions
             (bank_account_id, txn_date, value_date, description, amount, currency,
              category, category_rule, status, matched_entity_table, matched_entity_id,
              match_confidence, matched_at, transaction_kind, dedupe_hash)
           values ($1, $2::date, $2::date, $3, $4::numeric, $5,
                   'payment_settlement', 'radar_settlement', 'matched', 'payment_instances', $6::uuid,
                   1.0000, now(), $7, $8)
           returning id::text as id`,
          [
            resolvedAccount.id,
            entryDateISO,
            `${label} (${input.status === "partial" ? "Kısmi ödeme" : "Ödeme kapama"})`,
            signedAmount,
            meta.currency,
            input.instanceId,
            txKind,
            dedupeHash,
          ],
        );
        if (insBt.rowCount === 1) {
          bankTransactionId = insBt.rows[0].id;
          await audit(client, {
            actor: input.actorId,
            action: "settle_payment_bank_tx",
            entityTable: "bank_transactions",
            entityId: bankTransactionId,
            before: null,
            after: {
              bank_account_id: resolvedAccount.id,
              matched_entity_table: "payment_instances",
              matched_entity_id: input.instanceId,
              amount: signedAmount,
              currency: meta.currency,
              status: "matched",
            },
          });
        }
      }
    }

    let journalEntryId: string | null = null;
    if (meta.direction !== "transfer") {
      const liquidAccountCode = resolvedAccount?.account_type === "cash" ? "100" : "102";
      let counterCode = "770";
      if (meta.direction === "inflow") {
        counterCode = linkedInvoiceId || meta.provider_party_id ? "120" : "600";
      } else if (linkedInvoiceId) {
        counterCode = "320";
      } else {
        const checkAcc = await client.query<{ code: string }>(
          `select code from public.management_accounts where code = $1 and is_active = true limit 1`,
          [tdhpExpenseCode],
        );
        counterCode = checkAcc.rowCount === 1 ? checkAcc.rows[0].code : "770";
      }

      const idempotencyKey = bankTransactionId
        ? `bank_tx:settled:${bankTransactionId}`
        : `payment_instance:settled:${input.instanceId}:${input.status}:${input.totalPaidAmount.toFixed(2)}`;

      const posted = await postJournalEntryWithClient(
        client,
        {
          entryDate: entryDateISO,
          sourceType: "payment_instance",
          sourceId: input.instanceId,
          idempotencyKey,
          currency: meta.currency,
          description: `${meta.payment_name ?? "Ödeme"} kapaması (${meta.due_date})`,
          lines:
            meta.direction === "inflow"
              ? [
                  {
                    accountCode: liquidAccountCode,
                    debitNative: effectiveAmount,
                    creditNative: 0,
                    memo: "Tahsilat girişi",
                  },
                  {
                    accountCode: counterCode,
                    debitNative: 0,
                    creditNative: effectiveAmount,
                    partyId: meta.provider_party_id,
                    costCenterId: meta.cost_center_id,
                    projectId: meta.project_id,
                    departmentId: meta.department_id,
                    memo: "Gelir / alacak kapaması",
                  },
                ]
              : [
                  {
                    accountCode: counterCode,
                    debitNative: effectiveAmount,
                    creditNative: 0,
                    partyId: meta.provider_party_id,
                    costCenterId: meta.cost_center_id,
                    projectId: meta.project_id,
                    departmentId: meta.department_id,
                    memo: linkedInvoiceId ? "Satıcı borcu kapaması" : "Planlı gider tahakkuk/ödeme",
                  },
                  {
                    accountCode: liquidAccountCode,
                    debitNative: 0,
                    creditNative: effectiveAmount,
                    memo: "Banka / kasa çıkışı",
                  },
                ],
        },
        input.actorId,
      );
      journalEntryId = posted.entryId;
    }

    if (resolvedAccount) {
      await client.query(
        `update public.payment_instances set paid_from_account_id = $2 where id = $1`,
        [input.instanceId, resolvedAccount.id],
      );
    }
    if (bankTransactionId || journalEntryId) {
      try {
        await client.query("savepoint sp_pi_0119_write");
        await client.query(
          `update public.payment_instances
              set bank_transaction_id = coalesce($2::uuid, bank_transaction_id),
                  journal_entry_id = coalesce($3::uuid, journal_entry_id)
            where id = $1`,
          [input.instanceId, bankTransactionId, journalEntryId],
        );
        await client.query("release savepoint sp_pi_0119_write");
      } catch (err) {
        await client.query("rollback to savepoint sp_pi_0119_write").catch(() => undefined);
        await client.query("release savepoint sp_pi_0119_write").catch(() => undefined);
        if (!isMissingSchemaError(err)) throw err;
      }
    }

    await client.query("release savepoint sp_pi_settle_bridge");
    return {
      cashAccountId: resolvedAccount?.id ?? null,
      bankTransactionId,
      journalEntryId,
    };
  } catch (err) {
    await client.query("rollback to savepoint sp_pi_settle_bridge").catch(() => undefined);
    await client.query("release savepoint sp_pi_settle_bridge").catch(() => undefined);
    if (isMissingSchemaError(err)) {
      return { cashAccountId: null, bankTransactionId: null, journalEntryId: null };
    }
    if (err instanceof Error && err.message.includes("beklenmeyen SQL")) {
      return { cashAccountId: null, bankTransactionId: null, journalEntryId: null };
    }
    throw err;
  }
}

async function reverseInstanceSettlementArtifactsWithClient(
  client: PoolClient,
  instanceId: string,
  actorId: string,
): Promise<void> {
  try {
    await client.query("savepoint sp_pi_unsettle_bridge");

    await safeReverseJournalForSourceWithClient(
      client,
      "payment_instance",
      instanceId,
      "Ödeme kaydı geri alındı (mark_unpaid)",
      actorId,
    );

    const linkedBtRes = await client.query<{ id: string; status: string }>(
      `select id::text as id, status
         from public.bank_transactions
        where matched_entity_table = 'payment_instances'
          and matched_entity_id = $1::uuid
          and status in ('matched', 'reconciled')
        for update`,
      [instanceId],
    );
    for (const bt of linkedBtRes.rows) {
      await safeReverseJournalForSourceWithClient(
        client,
        "bank_transaction",
        bt.id,
        "Ödeme kaydı geri alındı (mark_unpaid)",
        actorId,
      );
      if (bt.status === "reconciled") {
        await client.query(
          `update public.bank_transactions
              set status = 'matched', reconciled_at = null
            where id = $1`,
          [bt.id],
        );
      }
      const ignRes = await client.query(
        `update public.bank_transactions
            set status = 'ignored',
                matched_entity_table = null,
                matched_entity_id = null,
                match_confidence = null,
                matched_at = null,
                ignored_reason = 'Ödeme kaydı geri alındı (mark_unpaid)'
          where id = $1`,
        [bt.id],
      );
      if (ignRes.rowCount === 1) {
        await audit(client, {
          actor: actorId,
          action: "ignore_reversed_settlement_bank_tx",
          entityTable: "bank_transactions",
          entityId: bt.id,
          before: { status: bt.status, matched_entity_id: instanceId },
          after: { status: "ignored", ignored_reason: "Ödeme kaydı geri alındı (mark_unpaid)" },
        });
      }
    }

    await client.query(
      `update public.payment_instances set paid_from_account_id = null where id = $1`,
      [instanceId],
    );
    try {
      await client.query("savepoint sp_pi_0119_clear");
      await client.query(
        `update public.payment_instances
            set bank_transaction_id = null,
                journal_entry_id = null
          where id = $1`,
        [instanceId],
      );
      await client.query("release savepoint sp_pi_0119_clear");
    } catch (err) {
      await client.query("rollback to savepoint sp_pi_0119_clear").catch(() => undefined);
      await client.query("release savepoint sp_pi_0119_clear").catch(() => undefined);
      if (!isMissingSchemaError(err)) throw err;
    }

    await client.query("release savepoint sp_pi_unsettle_bridge");
  } catch (err) {
    await client.query("rollback to savepoint sp_pi_unsettle_bridge").catch(() => undefined);
    await client.query("release savepoint sp_pi_unsettle_bridge").catch(() => undefined);
    if (isMissingSchemaError(err)) return;
    if (err instanceof Error && err.message.includes("beklenmeyen SQL")) return;
    throw err;
  }
}

async function enforceOutflowSettlementMakerCheckerWithClient(
  client: PoolClient,
  params: {
    instanceId: string;
    direction: string | null | undefined;
    approvalStatus: string | null | undefined;
    effectiveAmount: number;
    currency: string;
    dueDateISO?: string | null;
    actorId: string;
    onApprovalCommitted?: () => void;
  },
): Promise<void> {
  const dir = params.direction ?? "outflow";
  if (dir !== "outflow") return;

  const statusStr = String(params.approvalStatus ?? "not_required");
  if (statusStr === "pending_approval" || statusStr === "rejected") {
    throw new DomainError(
      "FORBIDDEN",
      "Bu ödeme kalemi ikinci onay (maker-checker) bekliyor veya reddedildi; onaylanmadan ödenmiş işaretlenemez.",
    );
  }

  let firedCount = 0;
  try {
    await client.query("savepoint sp_pi_settle_rule_eval");
    const fired = await evaluateRulesWithClient(client, {
      subjectTable: "payment_instances",
      triggerKind: "payment",
      amount: params.effectiveAmount,
      currency: params.currency,
    });
    firedCount = fired.length;
    await client.query("release savepoint sp_pi_settle_rule_eval");
  } catch (err) {
    await client.query("rollback to savepoint sp_pi_settle_rule_eval").catch(() => undefined);
    await client.query("release savepoint sp_pi_settle_rule_eval").catch(() => undefined);
    if (isMissingSchemaError(err) || (err instanceof Error && err.message.includes("beklenmeyen SQL"))) {
      return;
    }
    throw err;
  }

  if (firedCount === 0) return;

  if (statusStr === "approved") {
    try {
      await client.query("savepoint sp_pi_verify_approved_round");
      const appCheck = await client.query(
        `select 1
           from public.approvals
          where subject_table = 'payment_instances'
            and subject_id = $1::uuid
            and status = 'approved'
          limit 1`,
        [params.instanceId],
      );
      await client.query("release savepoint sp_pi_verify_approved_round");
      if ((appCheck.rowCount ?? 0) > 0) {
        return;
      }
    } catch (err) {
      await client.query("rollback to savepoint sp_pi_verify_approved_round").catch(() => undefined);
      await client.query("release savepoint sp_pi_verify_approved_round").catch(() => undefined);
      if (isMissingSchemaError(err) || (err instanceof Error && err.message.includes("beklenmeyen SQL"))) {
        return;
      }
      throw err;
    }
  }

  try {
    await client.query("savepoint sp_pi_queue_approval");
    const evaluated = await evaluateAndRequestIfNeededWithClient(client, {
      ruleInput: {
        subjectTable: "payment_instances",
        triggerKind: "payment",
        amount: params.effectiveAmount,
        currency: params.currency,
      },
      subjectId: params.instanceId,
      subjectLabel: params.dueDateISO
        ? `Ödeme kalemi (${params.dueDateISO})`
        : `Ödeme kalemi (${params.instanceId.slice(0, 8)})`,
      amount: params.effectiveAmount,
      currency: params.currency,
      actorId: params.actorId,
    });
    if (evaluated.approvalId) {
      await client.query(
        `update public.payment_instances
            set approval_status = 'pending_approval', approval_id = $2
          where id = $1`,
        [params.instanceId, evaluated.approvalId],
      );
      await client.query("release savepoint sp_pi_queue_approval");
      await client.query("commit");
      params.onApprovalCommitted?.();
    } else {
      await client.query("rollback to savepoint sp_pi_queue_approval").catch(() => undefined);
      await client.query("release savepoint sp_pi_queue_approval").catch(() => undefined);
    }
  } catch {
    await client.query("rollback to savepoint sp_pi_queue_approval").catch(() => undefined);
    await client.query("release savepoint sp_pi_queue_approval").catch(() => undefined);
  }

  throw new DomainError(
    "FORBIDDEN",
    "Bu ödeme kritik onay eşiğini aşıyor; bağımsız ikinci onay tamamlanmadan ödenmiş işaretlenemez.",
  );
}

export async function markInstancePaid(
  pool: Pool,
  instanceId: string,
  paidAmount: number | null,
  actorId: string,
  options?: SettlementOptions,
): Promise<void> {
  const client = await pool.connect();
  let approvalCommitted = false;
  try {
    await client.query("begin");
    const before = await client.query(
      `select id, status, amount, paid_amount, paid_at,
              coalesce(direction, 'outflow') as direction,
              coalesce(currency, 'TRY') as currency,
              approval_status,
              to_char(due_date, 'YYYY-MM-DD') as due_date
         from public.payment_instances where id=$1 for update`,
      [instanceId],
    );
    if (before.rowCount !== 1) throw await instanceMissingReason(client, instanceId);
    const current = before.rows[0];
    const currentStatus = current.status as string;
    if (!PAYABLE_FROM.has(currentStatus)) {
      throw new DomainError(`payment_instances ${instanceId}: '${currentStatus}' durumundan ödendi işaretlenemez`);
    }
    const previousPaid =
      currentStatus === "partial" && current.paid_amount != null
        ? Number(current.paid_amount)
        : 0;
    const amount = current.amount == null ? null : Number(current.amount);
    const finalPaid = paidAmount ?? amount; // may stay null: unknown paid amount is honest
    const effectiveAmount = Math.max(Number(current.amount ?? 0), Number(finalPaid ?? 0));

    await enforceOutflowSettlementMakerCheckerWithClient(client, {
      instanceId,
      direction: current.direction,
      approvalStatus: current.approval_status,
      effectiveAmount,
      currency: String(current.currency ?? "TRY"),
      dueDateISO: current.due_date ?? null,
      actorId,
      onApprovalCommitted: () => {
        approvalCommitted = true;
      },
    });

    const updRes = await client.query(
      `update public.payment_instances
         set status='paid', paid_at=now(), paid_amount=$2
       where id=$1`,
      [instanceId, finalPaid],
    );
    if (updRes.rowCount === 1) {
      await audit(client, {
        actor: actorId, action: "mark_paid", entityTable: "payment_instances", entityId: instanceId,
        before: current, after: { status: "paid", paid_amount: finalPaid },
      });
    }
    await syncInstanceSettlementArtifactsWithClient(client, {
      instanceId,
      previousPaidAmount: previousPaid,
      totalPaidAmount: finalPaid,
      status: "paid",
      cashAccountId: options?.cashAccountId ?? null,
      settledDateISO: options?.settledDateISO ?? null,
      actorId,
    });
    await client.query("commit");
  } catch (e) {
    if (!approvalCommitted) {
      await client.query("rollback");
    }
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
    const updRes = await client.query(
      `update public.payment_instances
         set status='unpaid', paid_at=null, paid_amount=null
       where id=$1`,
      [instanceId],
    );
    if (updRes.rowCount === 1) {
      await audit(client, {
        actor: actorId, action: "mark_unpaid", entityTable: "payment_instances", entityId: instanceId,
        before: before.rows[0], after: { status: "unpaid" },
      });
    }
    await reverseInstanceSettlementArtifactsWithClient(client, instanceId, actorId);
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

export async function markInstancePartial(
  pool: Pool,
  instanceId: string,
  paidAmount: number,
  actorId: string,
  options?: SettlementOptions,
): Promise<void> {
  const client = await pool.connect();
  let approvalCommitted = false;
  try {
    await client.query("begin");
    const before = await client.query(
      `select id, status, amount, paid_amount,
              coalesce(direction, 'outflow') as direction,
              coalesce(currency, 'TRY') as currency,
              approval_status,
              to_char(due_date, 'YYYY-MM-DD') as due_date
         from public.payment_instances where id=$1 for update`,
      [instanceId],
    );
    if (before.rowCount !== 1) throw await instanceMissingReason(client, instanceId);
    const current = before.rows[0];
    const currentStatus = current.status as string;
    if (!PAYABLE_FROM.has(currentStatus)) {
      throw new DomainError(`payment_instances ${instanceId}: '${currentStatus}' durumundan kısmi ödendi işaretlenemez`);
    }
    const total = current.amount == null ? null : Number(current.amount);
    if (!Number.isFinite(paidAmount) || paidAmount <= 0 || (total != null && paidAmount >= total)) {
      throw new DomainError("Kısmi tutar toplamdan küçük ve sıfırdan büyük olmalı");
    }
    const effectiveAmount = Math.max(Number(current.amount ?? 0), Number(paidAmount ?? 0));

    await enforceOutflowSettlementMakerCheckerWithClient(client, {
      instanceId,
      direction: current.direction,
      approvalStatus: current.approval_status,
      effectiveAmount,
      currency: String(current.currency ?? "TRY"),
      dueDateISO: current.due_date ?? null,
      actorId,
      onApprovalCommitted: () => {
        approvalCommitted = true;
      },
    });

    const previousPaid =
      currentStatus === "partial" && current.paid_amount != null
        ? Number(current.paid_amount)
        : 0;
    const updRes = await client.query(
      `update public.payment_instances set status='partial', paid_amount=$2, paid_at=now() where id=$1`,
      [instanceId, paidAmount],
    );
    if (updRes.rowCount === 1) {
      await audit(client, {
        actor: actorId, action: "mark_partial", entityTable: "payment_instances", entityId: instanceId,
        before: current, after: { status: "partial", paid_amount: paidAmount },
      });
    }
    await syncInstanceSettlementArtifactsWithClient(client, {
      instanceId,
      previousPaidAmount: previousPaid,
      totalPaidAmount: paidAmount,
      status: "partial",
      cashAccountId: options?.cashAccountId ?? null,
      settledDateISO: options?.settledDateISO ?? null,
      actorId,
    });
    await client.query("commit");
  } catch (error) {
    if (!approvalCommitted) {
      await client.query("rollback");
    }
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
      direction: string;
      currency: string;
      approval_status: string;
      due_date: string;
    }>(
      `select id, amount, amount_status, amount_source, direction, currency, approval_status, to_char(due_date,'YYYY-MM-DD') as due_date from public.payment_instances where id=$1 for update`,
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
      if (b.direction === "outflow") {
        const evaluated = await evaluateAndRequestIfNeededWithClient(client, {
          ruleInput: {
            subjectTable: "payment_instances",
            triggerKind: "payment",
            amount,
            currency: b.currency,
          },
          subjectId: instanceId,
          subjectLabel: `Ödeme kalemi (${b.due_date})`,
          amount,
          currency: b.currency,
          actorId,
        });
        if (evaluated.approvalId) {
          await client.query(
            `update public.payment_instances set approval_status='pending_approval', approval_id=$2 where id=$1`,
            [instanceId, evaluated.approvalId],
          );
        }
      }
    }
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

const CANCELLABLE_FROM = new Set(["unpaid", "planned", "late", "partial"]);

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
    `select id, status, cancelled_at, cancel_reason, paid_at, paid_amount from public.payment_instances where id=$1 for update`,
    [instanceId],
  );
  if (before.rowCount !== 1) throw await instanceMissingReason(client, instanceId);
  const currentStatus = before.rows[0].status as string;
  if (!CANCELLABLE_FROM.has(currentStatus)) {
    throw new DomainError(`payment_instances ${instanceId}: '${currentStatus}' durumundan iptal edilemez`);
  }
  const updated = await client.query<{ cancelled_at_iso: string }>(
    ctx?.eventTimestamp
      ? `update public.payment_instances set status='cancelled', cancelled_at=$2, cancel_reason=$3, paid_at=null, paid_amount=null
         where id=$1
         returning to_char(cancelled_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cancelled_at_iso`
      : `update public.payment_instances set status='cancelled', cancelled_at=now(), cancel_reason=$2, paid_at=null, paid_amount=null
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
  currency?: string | null;
  recurrenceType?: string | null;
}

export interface ReconcileResult {
  dueDateChanged: number;
  amountChanged: number;
  currencyChanged?: number;
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
    currency: string;
    direction?: string;
    approval_status?: string;
    amount_status: string;
    amount_source: string;
    note: string | null;
  }>(
    `select id, to_char(instance_month,'YYYY-MM-DD') as instance_month,
            to_char(due_date,'YYYY-MM-DD') as due_date,
            amount, coalesce(currency, 'TRY') as currency,
            coalesce(direction, 'outflow') as direction,
            coalesce(approval_status, 'not_required') as approval_status,
            amount_status, amount_source, note
     from public.payment_instances
     where payment_id=$1 and status = any($2) and due_date >= $3 and not exists (select 1 from public.cashflow_months cm where cm.status = 'locked' and cm.month_start in (instance_month, date_trunc('month', due_date)::date))
     order by due_date, id
     for update`,
    [paymentId, Array.from(RECONCILIABLE_FROM), todayISO],
  );

  let dueDateChanged = 0;
  let amountChanged = 0;
  let currencyChanged = 0;
  const targetCurrency = fields.currency?.trim().toUpperCase() || null;

  for (const row of rows.rows) {
    if (await isAccountingPeriodLockedWithClient(client, row.instance_month)) {
      continue;
    }

    let applyDueDate = false;
    let candidateDueDate = row.due_date;
    if (fields.dueDay != null) {
      if (fields.recurrenceType === "weekly" || row.note?.startsWith("weekly_x")) {
        const firstDay = ((Math.max(1, fields.dueDay) - 1) % 7) + 1;
        candidateDueDate = `${row.instance_month.slice(0, 7)}-${String(firstDay).padStart(2, "0")}`;
      } else {
        candidateDueDate = dueDateFor(row.instance_month, fields.dueDay).dueDate;
      }
      applyDueDate = candidateDueDate >= todayISO && candidateDueDate !== row.due_date;
    }

    const currentAmount = row.amount == null ? null : Number(row.amount);
    let applyAmount = false;
    let candidateAmount: number | null = null;
    let candidateAmountStatus = "";
    let applyCurrency = false;

    if (row.amount_source === "generated") {
      if (
        fields.defaultAmount != null &&
        (fields.recurrenceType === "weekly" || row.note?.startsWith("weekly_x"))
      ) {
        const sched = computeInstanceScheduleForMonth(
          {
            recurrence_type: "weekly",
            due_day: fields.dueDay ?? Number(row.due_date.slice(8, 10)),
            default_amount: fields.defaultAmount,
          },
          row.instance_month,
        );
        candidateAmount = sched ? sched.amount : fields.defaultAmount;
      } else {
        candidateAmount = fields.defaultAmount;
      }
      candidateAmountStatus =
        candidateAmount == null ? "missing" : fields.amountConfidence === "variable" ? "variable" : "known";
      applyAmount = candidateAmount !== currentAmount || candidateAmountStatus !== row.amount_status;

      if (targetCurrency && targetCurrency !== row.currency) {
        applyCurrency = true;
      }
    }

    if (!applyDueDate && !applyAmount && !applyCurrency) continue;

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
    if (applyCurrency) {
      params.push(targetCurrency);
      setParts.push(`currency=$${params.length}`);
    }
    await client.query(`update public.payment_instances set ${setParts.join(", ")} where id=$1`, params);
    if (applyDueDate) dueDateChanged++;
    if (applyAmount) amountChanged++;
    if (applyCurrency) currencyChanged++;

    const effectiveAmt = applyAmount ? candidateAmount : currentAmount;
    const effectiveCur = applyCurrency && targetCurrency ? targetCurrency : row.currency;
    const effectiveDue = applyDueDate ? candidateDueDate : row.due_date;
    const amountIncreased =
      applyAmount && candidateAmount != null && (currentAmount == null || candidateAmount > currentAmount);
    if (
      (row.direction ?? "outflow") === "outflow" &&
      effectiveAmt != null &&
      ((row.approval_status ?? "not_required") !== "approved" || amountIncreased)
    ) {
      try {
        await client.query("savepoint sp_reconcile_inst_approval");
        const evaluated = await evaluateAndRequestIfNeededWithClient(client, {
          ruleInput: {
            subjectTable: "payment_instances",
            triggerKind: "payment",
            amount: effectiveAmt,
            currency: effectiveCur,
          },
          subjectId: row.id,
          subjectLabel: `Ödeme kalemi (${effectiveDue})`,
          amount: effectiveAmt,
          currency: effectiveCur,
          actorId,
        });
        if (evaluated.approvalId) {
          await client.query(
            `update public.payment_instances
                set approval_status = 'pending_approval', approval_id = $2
              where id = $1`,
            [row.id, evaluated.approvalId],
          );
        }
        await client.query("release savepoint sp_reconcile_inst_approval");
      } catch (err) {
        await client.query("rollback to savepoint sp_reconcile_inst_approval").catch(() => undefined);
        await client.query("release savepoint sp_reconcile_inst_approval").catch(() => undefined);
        if (!isMissingSchemaError(err) && !(err instanceof Error && err.message.includes("beklenmeyen SQL"))) {
          throw err;
        }
      }
    }
  }

  const totalEligible = rows.rowCount ?? 0;
  if (dueDateChanged > 0 || amountChanged > 0 || currencyChanged > 0) {
    await audit(client, {
      actor: actorId, action: "reconcile_instances", entityTable: "payment_instances", entityId: null,
      before: null,
      after: { paymentId, dueDateChanged, amountChanged, currencyChanged, totalEligible },
    });
  }

  return { dueDateChanged, amountChanged, currencyChanged, totalEligible };
}

/* ── 6) M-16: Vendor Invoice <-> Payment Instance Link (prevents 13W double-counting) ── */

const linkInstanceInvoiceSchema = z.object({
  instanceId: z.string().regex(uuidPattern),
  invoiceId: z.string().regex(uuidPattern).nullable(),
  actor: z.string().min(1),
});

export interface SuggestedInvoiceLink {
  instanceId: string;
  paymentName: string;
  instanceDueDate: string;
  instanceAmount: number | null;
  currency: string;
  invoiceId: string;
  invoiceNo: string;
  invoiceDueDate: string;
  invoiceOpenAmount: number;
  counterpartyName: string;
}

export async function linkPaymentInstanceToInvoice(
  pool: Pool,
  rawInput: { instanceId: string; invoiceId: string | null; actor: string },
): Promise<void> {
  const parsed = linkInstanceInvoiceSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new DomainError(
      "VALIDATION",
      `Geçersiz fatura eşleştirme isteği: ${formatIssues(parsed.error)}`,
    );
  }
  const { instanceId, invoiceId, actor } = parsed.data;
  const client = await pool.connect();
  try {
    await client.query("begin");
    const instRes = await client.query<{
      id: string;
      status: string;
      currency: string;
      direction: string;
      linked_invoice_id: string | null;
    }>(
      `select id::text as id,
              status,
              coalesce(currency, 'TRY') as currency,
              coalesce(direction, 'outflow') as direction,
              linked_invoice_id::text as linked_invoice_id
         from public.payment_instances
        where id = $1
        for update`,
      [instanceId],
    );
    if (instRes.rowCount !== 1) {
      throw await instanceMissingReason(client, instanceId);
    }
    const inst = instRes.rows[0];

    if (invoiceId != null) {
      const invRes = await client.query<{
        id: string;
        direction: string;
        currency: string;
        status: string;
      }>(
        `select id::text as id, direction, currency, status
           from public.invoices
          where id = $1
          limit 1`,
        [invoiceId],
      );
      if (invRes.rowCount !== 1) {
        throw new DomainError("NOT_FOUND", "Bağlanacak fatura bulunamadı.");
      }
      const inv = invRes.rows[0];
      if (inv.status === "cancelled") {
        throw new DomainError("VALIDATION", "İptal edilmiş fatura ödeme planına bağlanamaz.");
      }
      if (inv.currency !== inst.currency) {
        throw new DomainError(
          "VALIDATION",
          `Fatura dövizi (${inv.currency}) ile ödeme dövizi (${inst.currency}) eşleşmiyor.`,
        );
      }
      const expectedDirection = inst.direction === "inflow" ? "sales" : "purchase";
      if (inv.direction !== expectedDirection) {
        throw new DomainError(
          "VALIDATION",
          "Fatura yönü (satış/alış) ödeme kalemi yönü (giriş/çıkış) ile uyuşmuyor.",
        );
      }
    }

    if (inst.linked_invoice_id !== invoiceId) {
      const upd = await client.query(
        `update public.payment_instances set linked_invoice_id = $2::uuid where id = $1`,
        [instanceId, invoiceId],
      );
      if (upd.rowCount === 1) {
        await audit(client, {
          actor,
          action: invoiceId ? "link_payment_instance_invoice" : "unlink_payment_instance_invoice",
          entityTable: "payment_instances",
          entityId: instanceId,
          before: { linked_invoice_id: inst.linked_invoice_id },
          after: { linked_invoice_id: invoiceId },
        });
      }
    }
    await client.query("commit");
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    translatePeriodLockError(e);
  } finally {
    client.release();
  }
}

export async function loadSuggestedInvoiceLinks(
  pool: Pool,
  limit = 12,
): Promise<SuggestedInvoiceLink[]> {
  try {
    const res = await pool.query<{
      instance_id: string;
      payment_name: string;
      instance_due_date: string;
      instance_amount: string | null;
      currency: string;
      invoice_id: string;
      invoice_no: string;
      invoice_due_date: string;
      invoice_open_amount: string;
      counterparty_name: string;
    }>(
      `select distinct on (pi.id)
              pi.id::text as instance_id,
              coalesce(p.name, '(kalem)') as payment_name,
              to_char(pi.due_date, 'YYYY-MM-DD') as instance_due_date,
              pi.amount::text as instance_amount,
              coalesce(pi.currency, 'TRY') as currency,
              inv.id::text as invoice_id,
              coalesce(inv.invoice_no, left(inv.id::text, 8)) as invoice_no,
              to_char(inv.due_date, 'YYYY-MM-DD') as invoice_due_date,
              greatest(
                0,
                coalesce(inv.payable_amount, inv.gross_amount, 0)
                - greatest(coalesce(inv.allocated_amount, 0), coalesce(inv.paid_amount, 0))
              )::text as invoice_open_amount,
              coalesce(pa.name, '—') as counterparty_name
         from public.payment_instances pi
         join public.payments p on p.id = pi.payment_id
         join public.invoices inv
           on inv.currency = coalesce(pi.currency, 'TRY')
          and inv.direction = case when coalesce(pi.direction, 'outflow') = 'inflow' then 'sales' else 'purchase' end
          and inv.status in ('open', 'partial')
          and inv.due_date is not null
          and abs(inv.due_date - pi.due_date) <= 35
         left join public.parties pa on pa.id = inv.party_id
        where pi.status in ('unpaid', 'planned', 'partial', 'late')
          and pi.linked_invoice_id is null
          and p.status = 'active'
          and p.archived_at is null
          and (
            (p.provider_party_id is not null and inv.party_id = p.provider_party_id)
            or (
              p.auto_match_vkn is not null
              and btrim(p.auto_match_vkn) <> ''
              and pa.tax_no is not null
              and regexp_replace(pa.tax_no, '\\D', '', 'g') = regexp_replace(p.auto_match_vkn, '\\D', '', 'g')
            )
          )
          and not exists (
            select 1
              from public.payment_instances pi2
             where pi2.linked_invoice_id = inv.id
               and pi2.status <> 'cancelled'
          )
        order by pi.id, abs(inv.due_date - pi.due_date) asc, inv.due_date asc
        limit $1`,
      [Math.max(1, Math.min(limit, 50))],
    );
    return res.rows.map((r) => ({
      instanceId: r.instance_id,
      paymentName: r.payment_name,
      instanceDueDate: r.instance_due_date,
      instanceAmount: moneyOrNull(r.instance_amount),
      currency: r.currency,
      invoiceId: r.invoice_id,
      invoiceNo: r.invoice_no,
      invoiceDueDate: r.invoice_due_date,
      invoiceOpenAmount: moneyOrNull(r.invoice_open_amount) ?? 0,
      counterpartyName: r.counterparty_name,
    }));
  } catch (err) {
    if (isMissingSchemaError(err)) return [];
    throw err;
  }
}

/* ── 7) M-17: Template Update Cascade + Archive Cascade ── */

export interface UpdatePaymentTemplateCascadeFields {
  name: string;
  recurrence_type: string;
  due_day: number | null;
  due_date: string | null;
  default_amount: number | null;
  currency: string;
  amount_confidence: string;
  direction: string;
  priority: string;
  flexibility_class: string | null;
  status: string;
  category_id: string | null;
  provider_party_id: string | null;
  owner_party_id: string | null;
  cash_account_id: string | null;
  cost_center_id?: string | null;
  project_id?: string | null;
  department_id?: string | null;
  description: string | null;
  iban?: string | null;
  tdhp_expense_code?: string | null;
  auto_match_vkn?: string | null;
}

export async function updatePaymentWithCascade(
  pool: Pool,
  id: string,
  f: UpdatePaymentTemplateCascadeFields,
  todayISO: string,
  actorId: string,
): Promise<void> {
  assertISODateString(todayISO);
  const requestedRecurrence = (f.recurrence_type ?? "monthly").trim();
  const isQuarterly = requestedRecurrence === "quarterly";
  const dbRecurrenceType = isQuarterly ? "irregular" : requestedRecurrence;
  const currency = (f.currency ?? "TRY").trim().toUpperCase() || "TRY";

  const client = await pool.connect();
  try {
    await client.query("begin");
    const before = await client.query(`select * from public.payments where id=$1 for update`, [id]);
    if (before.rowCount !== 1) throw new DomainError("NOT_FOUND", "Ödeme şablonu bulunamadı.");
    const prevSourceNotes = typeof before.rows[0].source_notes === "string" ? before.rows[0].source_notes : "";
    const cleanedNotes = prevSourceNotes
      .split(/\s+/)
      .filter((tok: string) => tok && tok !== "freq:quarterly")
      .join(" ");
    const nextSourceNotes = isQuarterly
      ? [cleanedNotes, "freq:quarterly"].filter(Boolean).join(" ")
      : cleanedNotes || null;

    const upd = await client.query(
      `update public.payments set
         name=$2, recurrence_type=$3, due_day=$4, due_date=$5, default_amount=$6,
         currency=$7, amount_confidence=$8, direction=$9, priority=$10,
         flexibility_class=$11, status=$12, category_id=$13, provider_party_id=$14,
         owner_party_id=$15, cash_account_id=$16, description=$17,
         cost_center_id=$18, project_id=$19, department_id=$20, source_notes=$21
       where id=$1`,
      [
        id,
        f.name,
        dbRecurrenceType,
        f.due_day,
        f.due_date,
        f.default_amount,
        currency,
        f.amount_confidence,
        f.direction,
        f.priority,
        f.flexibility_class,
        f.status,
        f.category_id,
        f.provider_party_id,
        f.owner_party_id,
        f.cash_account_id,
        f.description,
        f.cost_center_id ?? null,
        f.project_id ?? null,
        f.department_id ?? null,
        nextSourceNotes,
      ],
    );

    const validatedIban =
      f.iban !== undefined
        ? await validateAndTrackTemplateIbanWithClient(
            client,
            {
              rawIban: f.iban,
              providerPartyId: f.provider_party_id,
              currency,
              label: f.name,
            },
            actorId,
          )
        : null;

    if (f.iban !== undefined || f.tdhp_expense_code !== undefined || f.auto_match_vkn !== undefined) {
      try {
        await client.query("savepoint sp_pay_upd_0119");
        await client.query(
          `update public.payments
              set iban = $2,
                  tdhp_expense_code = coalesce($3, '770'),
                  auto_match_vkn = $4
            where id = $1`,
          [
            id,
            validatedIban,
            f.tdhp_expense_code?.trim() || "770",
            f.auto_match_vkn?.trim() || null,
          ],
        );
        await client.query("release savepoint sp_pay_upd_0119");
      } catch (err) {
        await client.query("rollback to savepoint sp_pay_upd_0119").catch(() => undefined);
        await client.query("release savepoint sp_pay_upd_0119").catch(() => undefined);
        if (!isMissingSchemaError(err)) throw err;
      }
    }

    if (upd.rowCount === 1) {
      await audit(client, {
        actor: actorId,
        action: "update_payment",
        entityTable: "payments",
        entityId: id,
        before: before.rows[0],
        after: { ...f, currency, recurrence_type: requestedRecurrence },
      });
    }

    if (f.status === "archived") {
      const openFuture = await client.query<{ id: string }>(
        `select id::text as id
           from public.payment_instances
          where payment_id = $1
            and status in ('unpaid', 'planned')
            and due_date >= $2::date
          order by due_date, id
          for update`,
        [id, todayISO],
      );
      for (const inst of openFuture.rows) {
        await cancelInstanceWithClient(client, inst.id, "Ödeme şablonu arşivlendi", actorId);
      }
    } else {
      await reconcileInstancesWithClient(
        client,
        id,
        {
          dueDay: f.due_day,
          defaultAmount: f.default_amount,
          amountConfidence: f.amount_confidence,
          currency,
          recurrenceType: requestedRecurrence,
        },
        todayISO,
        actorId,
      );

      const m0 = `${todayISO.slice(0, 7)}-01`;
      const horizon =
        requestedRecurrence === "yearly" ? 12 : requestedRecurrence === "quarterly" ? 3 : 1;
      for (let delta = -1; delta <= horizon; delta++) {
        await generateInstancesForMonthWithClient(client, addMonths(m0, delta), actorId);
      }
      await refreshRiskFlagsWithClient(client, todayISO);
    }

    await client.query("commit");
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    translatePeriodLockError(e);
  } finally {
    client.release();
  }
}

export async function archivePaymentWithCascade(
  pool: Pool,
  id: string,
  input: { reason: string; archivedByLabel: string },
  todayISO: string,
  actorId: string,
): Promise<{ cancelledCount: number }> {
  assertISODateString(todayISO);
  const trimmedReason = input.reason.trim() || "Ödeme şablonu arşivlendi";
  const client = await pool.connect();
  try {
    await client.query("begin");
    const before = await client.query(
      `select id, status, archived_at, archive_reason, archived_by_label
         from public.payments
        where id = $1
        for update`,
      [id],
    );
    if (before.rowCount !== 1) throw new DomainError("NOT_FOUND", "Ödeme şablonu bulunamadı.");

    const upd = await client.query(
      `update public.payments
          set status = 'archived',
              archived_at = now(),
              archive_reason = $2,
              archived_by_label = $3
        where id = $1`,
      [id, trimmedReason, input.archivedByLabel],
    );
    if (upd.rowCount === 1) {
      await audit(client, {
        actor: actorId,
        action: "archive_payment",
        entityTable: "payments",
        entityId: id,
        before: before.rows[0],
        after: {
          status: "archived",
          archive_reason: trimmedReason,
          archived_by_label: input.archivedByLabel,
        },
      });
    }

    const eligible = await client.query<{ id: string; instance_month: string }>(
      `select id::text as id,
              to_char(instance_month, 'YYYY-MM-DD') as instance_month
         from public.payment_instances
        where payment_id = $1
          and status in ('unpaid', 'planned')
          and due_date >= $2::date
          and not exists (
            select 1
              from public.cashflow_months cm
             where cm.status = 'locked'
               and cm.month_start in (instance_month, date_trunc('month', due_date)::date)
          )
        order by due_date, id
        for update`,
      [id, todayISO],
    );
    let cancelledCount = 0;
    for (const row of eligible.rows) {
      if (await isAccountingPeriodLockedWithClient(client, row.instance_month)) {
        continue;
      }
      await cancelInstanceWithClient(
        client,
        row.id,
        `Ödeme şablonu arşivlendi: ${trimmedReason}`,
        actorId,
      );
      cancelledCount++;
    }

    await client.query("commit");
    return { cancelledCount };
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    translatePeriodLockError(e);
  } finally {
    client.release();
  }
}
