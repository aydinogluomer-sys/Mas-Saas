// Faz 31 — control engine: runs the checks, raises alerts, drives the review workflow.
//
// ═══ WHAT IT WRITES, AND WHAT IT REFUSES TO ═══
//
// It writes control_alerts, action_items and audit_logs. It NEVER writes to a financial record:
// a control that could "fix" what it found would be an automation altering amounts and dates,
// which CLAUDE.md forbids outright. A finding is put in front of a person; the person decides.
//
// The review workflow reuses action_items (Faz 14's model, as Faz 25 did for collections). No
// second task model is invented — phase31:verify asserts the source_type is the widened enum
// value rather than a new table.
//
// Does not import @/lib/ai. The negative control in the gate proves it.

import type { Pool } from "pg";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { DomainError } from "@/lib/domain-error";
import { moneyOrNull, rateOrNull } from "@/lib/money";
import { parseOrThrow } from "@/lib/validation";
import {
  ANOMALY_RULES, assessAnomaly, canTransition, controlState, falsePositiveRate, isEscalationDue,
  type AlertStatus, type AnomalyRule, type Severity,
} from "./rules";

export const setAlertStatusSchema = z.object({
  alertId: z.uuid(),
  status: z.enum(["acknowledged", "snoozed", "resolved", "false_positive", "open"]),
  note: z.string().trim().max(1000).optional(),
  snoozeUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});

export const raiseAlertSchema = z.object({
  checkCode: z.string().trim().min(1),
  severity: z.enum(["info", "warning", "critical"]),
  subjectTable: z.string().trim().min(1).nullable().optional(),
  subjectId: z.uuid().nullable().optional(),
  subjectLabel: z.string().trim().max(300).optional(),
  title: z.string().trim().min(1),
  detail: z.string().trim().max(2000).optional(),
  ruleCodes: z.array(z.string()).min(1, "Her uyarı en az bir kural adı taşımalı"),
  amount: z.number().nullable().optional(),
});

/**
 * Raise a finding, or re-record one already known.
 *
 * IDEMPOTENT BY DESIGN. Re-running the controls must not pile up duplicate rows for the same
 * finding — an alert list that grows every time the job runs is one nobody reads. The partial
 * unique index in 0076 covers live alerts, and a conflict bumps `occurrence_count` and
 * `last_seen_at` instead of inserting. A finding that recurs AFTER being resolved legitimately
 * creates a new alert, which is why the index excludes closed statuses.
 */
export async function raiseAlert(pool: Pool, raw: unknown, actorId: string): Promise<string> {
  const input = parseOrThrow(raiseAlertSchema, raw, "Kontrol uyarısı");
  // Only KNOWN anomaly rules contribute to the score. The first version cast the whole array
  // through a predicate that returned true for everything, which lint flagged — and it was also
  // wrong: a control-only rule code (or a typo) would have scored as an anomaly weight lookup of
  // `undefined`. Filtering against the registry means an unrecognised code is carried on the
  // alert for the record but cannot silently move the number.
  const anomaly = assessAnomaly(
    input.ruleCodes.filter((r): r is AnomalyRule =>
      (ANOMALY_RULES as readonly string[]).includes(r)));

  const client = await pool.connect();
  try {
    await client.query("begin");
    const existing = await client.query(
      `select id, occurrence_count from public.control_alerts
       where check_code = $1
         and subject_table is not distinct from $2
         and subject_id is not distinct from $3
         and status in ('open','acknowledged','snoozed')
       for update`,
      [input.checkCode, input.subjectTable ?? null, input.subjectId ?? null]);

    if ((existing.rowCount ?? 0) > 0) {
      const id = existing.rows[0].id;
      await client.query(
        `update public.control_alerts
           set last_seen_at = now(), occurrence_count = occurrence_count + 1
         where id = $1`, [id]);
      await client.query("commit");
      return id;
    }

    const res = await client.query(
      `insert into public.control_alerts
         (check_code, severity, subject_table, subject_id, subject_label, title, detail,
          rule_codes, anomaly_score, amount)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       returning id`,
      [input.checkCode, input.severity, input.subjectTable ?? null, input.subjectId ?? null,
       input.subjectLabel ?? null, input.title, input.detail ?? null,
       input.ruleCodes, anomaly.score > 0 ? anomaly.score : null, input.amount ?? null]);
    const id = res.rows[0].id;

    await audit(client, {
      actor: actorId, action: "raise_control_alert",
      entityTable: "control_alerts", entityId: id,
      after: {
        checkCode: input.checkCode, severity: input.severity,
        ruleCodes: input.ruleCodes, anomalyScore: anomaly.score,
        // Recorded explicitly: raising a finding changes no financial record.
        mutatedFinancialRecords: false, automated: true,
      },
    });
    await client.query("commit");
    return id;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Move an alert through its lifecycle.
 *
 * Checked here as well as by the trigger: the guard raises a PostgreSQL exception the operator
 * sees as a 500, whereas this produces a sentence. The guard remains the authority.
 */
export async function setAlertStatus(pool: Pool, raw: unknown, actorId: string): Promise<void> {
  const input = parseOrThrow(setAlertStatusSchema, raw, "Uyarı durumu");
  const client = await pool.connect();
  try {
    await client.query("begin");
    const before = await client.query(
      `select id, status, check_code from public.control_alerts where id=$1 for update`,
      [input.alertId]);
    if (before.rowCount === 0) throw new DomainError("Uyarı bulunamadı.");
    const current = before.rows[0].status as AlertStatus;

    if (current === input.status) throw new DomainError("Uyarı zaten bu durumda.");
    if (!canTransition(current, input.status)) {
      throw new DomainError(
        `Bu geçiş yapılamaz: ${current} → ${input.status}. ` +
        `Kapatılmış bir bulgu yeniden açılmaz; tekrarlarsa yeni bir uyarı oluşur.`);
    }
    if (input.status === "snoozed" && !input.snoozeUntil) {
      throw new DomainError("Erteleme için bir tarih zorunlu.");
    }
    if ((input.status === "resolved" || input.status === "false_positive") && !input.note) {
      // The CHECK enforces this too; saying it here explains WHY rather than failing opaquely.
      throw new DomainError("Kapatma gerekçesi zorunlu — gerekçesiz kapatma kontrolü sessizce kapatır.");
    }

    await client.query(
      `update public.control_alerts
         set status = $2,
             acknowledged_at = case when $2='acknowledged' then now()
                                    when $2='open' then null else acknowledged_at end,
             acknowledged_by = case when $2='acknowledged' then $3::uuid
                                    when $2='open' then null else acknowledged_by end,
             snooze_until    = case when $2='snoozed' then $4::date else null end,
             resolved_at     = case when $2 in ('resolved','false_positive') then now() else null end,
             resolved_by     = case when $2 in ('resolved','false_positive') then $3::uuid else null end,
             resolution_note = case when $2 in ('resolved','false_positive') then $5 else resolution_note end
       where id = $1`,
      [input.alertId, input.status, actorId, input.snoozeUntil ?? null, input.note ?? null]);

    await audit(client, {
      actor: actorId, action: `control_alert_${input.status}`,
      entityTable: "control_alerts", entityId: input.alertId,
      before: { status: current },
      after: {
        status: input.status,
        // A false positive is feedback about the RULE, not just about this row.
        isRuleFeedback: input.status === "false_positive",
        checkCode: before.rows[0].check_code, automated: false,
      },
    });
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Turn an alert into a follow-up task.
 *
 * Uses action_items with source_type='control' — the existing task model (Faz 14), reused exactly
 * as Faz 25 reused it for collections. 0015's partial unique index means raising the same task
 * twice is impossible while one is still open, so this is safe to call repeatedly.
 */
export async function raiseActionItemForAlert(
  pool: Pool, alertId: string, actorId: string,
): Promise<string | null> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const a = await client.query(
      `select id, check_code, severity, title, subject_table, subject_id, action_item_id
       from public.control_alerts where id=$1 for update`, [alertId]);
    if (a.rowCount === 0) throw new DomainError("Uyarı bulunamadı.");
    if (a.rows[0].action_item_id) {
      await client.query("commit");
      return a.rows[0].action_item_id;
    }

    const severity = a.rows[0].severity as Severity;
    const item = await client.query(
      `insert into public.action_items
         (title, severity, status, source_type, related_entity_table, related_entity_id, note, created_by)
       values ($1,$2,'open','control','control_alerts',$3,$4,$5)
       on conflict do nothing
       returning id`,
      [a.rows[0].title, severity === "critical" ? "critical" : severity === "warning" ? "high" : "medium",
       alertId, `Kontrol bulgusu: ${a.rows[0].check_code}`, actorId]);
    const itemId = item.rows[0]?.id ?? null;
    if (itemId) {
      await client.query(
        `update public.control_alerts set action_item_id=$2 where id=$1`, [alertId, itemId]);
      await audit(client, {
        actor: actorId, action: "raise_control_action_item",
        entityTable: "control_alerts", entityId: alertId,
        after: { actionItemId: itemId, checkCode: a.rows[0].check_code, automated: false },
      });
    }
    await client.query("commit");
    return itemId;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/* ── reads ────────────────────────────────────────────────────────────────────────────── */

export async function loadControlDashboard(pool: Pool) {
  const r = await pool.query(
    `select check_code, title, default_severity, enforcement, rationale, finding_count, state
     from public.control_dashboard order by
       case state when 'CRITICAL' then 0 when 'WARNING' then 1 when 'INFO' then 2 else 3 end,
       check_code`);
  return r.rows.map((x) => ({
    checkCode: x.check_code,
    title: x.title,
    severity: x.default_severity as Severity,
    // Whether the database already prevents this, or this view is the only thing that notices.
    enforcement: x.enforcement as "enforced_elsewhere" | "detection_only",
    rationale: x.rationale as string,
    findingCount: Number(x.finding_count),
    state: controlState(x.default_severity as Severity, Number(x.finding_count)),
  }));
}

export async function loadAlerts(pool: Pool, limit = 100) {
  const r = await pool.query(
    `select id, check_code, severity, subject_table, subject_id, subject_label, title, detail,
            rule_codes, anomaly_score, amount, currency, status,
            to_char(snooze_until,'YYYY-MM-DD') as snooze_until,
            first_seen_at, last_seen_at, occurrence_count, action_item_id, resolution_note
     from public.control_alerts
     order by case status when 'open' then 0 when 'acknowledged' then 1 when 'snoozed' then 2 else 3 end,
              case severity when 'critical' then 0 when 'warning' then 1 else 2 end,
              last_seen_at desc
     limit $1`, [limit]);
  return r.rows.map((x) => ({
    id: x.id,
    checkCode: x.check_code,
    severity: x.severity as Severity,
    subjectTable: x.subject_table as string | null,
    subjectLabel: x.subject_label as string | null,
    title: x.title as string,
    detail: x.detail as string | null,
    ruleCodes: (x.rule_codes ?? []) as string[],
    anomalyScore: rateOrNull(x.anomaly_score),
    amount: moneyOrNull(x.amount),
    currency: x.currency as string,
    status: x.status as AlertStatus,
    snoozeUntil: x.snooze_until as string | null,
    firstSeenAt: x.first_seen_at as string,
    occurrenceCount: Number(x.occurrence_count),
    actionItemId: x.action_item_id as string | null,
    resolutionNote: x.resolution_note as string | null,
  }));
}

/** Alerts past their escalation window, computed through the pure rule. */
export async function loadEscalationsDue(pool: Pool, nowISO = new Date().toISOString()) {
  const r = await pool.query(
    `select a.id, a.check_code, a.severity, a.title, a.status, a.first_seen_at,
            e.code as rule_code, e.escalate_after_hours, e.channel
     from public.control_alerts a
     join public.alert_escalation_rules e
       on e.is_active and e.severity = a.severity
      and (e.check_code is null or e.check_code = a.check_code)
     where a.status = 'open'`);
  return r.rows
    .filter((x) => isEscalationDue({
      status: x.status as AlertStatus,
      firstSeenAt: new Date(x.first_seen_at).toISOString(),
      escalateAfterHours: Number(x.escalate_after_hours),
      nowISO,
    }))
    .map((x) => ({
      alertId: x.id,
      checkCode: x.check_code as string,
      severity: x.severity as Severity,
      title: x.title as string,
      escalationRule: x.rule_code as string,
      escalateAfterHours: Number(x.escalate_after_hours),
      channel: x.channel as string,
    }));
}

/**
 * Per-control false-positive rate — the feedback loop the plan asks for.
 *
 * Counts only closed alerts, so a control does not look accurate merely because nobody triaged it.
 */
export async function loadFalsePositiveRates(pool: Pool) {
  const r = await pool.query(
    `select check_code,
            count(*) filter (where status = 'resolved')::int       as resolved_count,
            count(*) filter (where status = 'false_positive')::int as false_positive_count,
            count(*) filter (where status in ('open','acknowledged','snoozed'))::int as open_count
     from public.control_alerts group by check_code order by check_code`);
  return r.rows.map((x) => ({
    checkCode: x.check_code as string,
    resolvedCount: Number(x.resolved_count),
    falsePositiveCount: Number(x.false_positive_count),
    openCount: Number(x.open_count),
    falsePositiveRate: falsePositiveRate(Number(x.resolved_count), Number(x.false_positive_count)),
  }));
}

export async function loadAnomalies(pool: Pool) {
  const [round, split, newPayee, baseline, hour] = await Promise.all([
    pool.query(`select payment_instance_id, payment_name, amount, due_date from public.anomaly_round_number_payments limit 50`),
    pool.query(`select party_id, party_name, due_date, payment_count, total_amount, largest_single from public.anomaly_split_payments limit 50`),
    pool.query(`select party_id, party_name, first_payment_date, payment_count, total_amount from public.anomaly_new_payee limit 50`),
    pool.query(`select payment_instance_id, party_name, amount, avg_amount, sample_count, times_baseline from public.anomaly_amount_vs_baseline limit 50`),
    pool.query(`select txn_id, txn_date, amount, recorded_hour, caveat from public.anomaly_unusual_record_hour limit 50`),
  ]);
  return {
    roundNumber: round.rows,
    splitPayments: split.rows,
    newPayees: newPayee.rows,
    aboveBaseline: baseline.rows,
    // The caveat travels with the rows: this is RECORD time, not transaction time.
    unusualRecordHour: hour.rows,
  };
}
