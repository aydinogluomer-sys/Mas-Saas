// Unified Idempotent Notification Outbox & Stateful Ops Incident Engine (Migration 0122).
// BOUNDARY INVARIANT: Zero process.env, zero fetch, zero secret console logging.
// Outbound delivery routes exclusively through `@/lib/reminders/transport`.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Pool, PoolClient } from "pg";
import type {
  IncidentLifecycleState,
  IncidentResolutionEvidence,
  IncidentSeverityLevel,
} from "@/lib/contracts/remediation-contracts";
import {
  redactBotToken,
  transportFor,
  type DeliveryResult,
  type NotificationChannel,
  type Transport,
} from "./transport";

export type { IncidentResolutionEvidence };

type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;

export type OutboxStream =
  | "ops_incident"
  | "cfo_briefing"
  | "periodic_report"
  | "reminder_digest"
  | "counterparty_notice"
  | "auth_security";

export type OutboxStatus =
  | "pending"
  | "claiming"
  | "sent"
  | "failed_retryable"
  | "delivery_uncertain"
  | "dead_letter"
  | "skipped";

export type OpsIncidentState = IncidentLifecycleState;
export type OpsIncidentSeverity = IncidentSeverityLevel;

export const DEFAULT_OPS_INCIDENT_STATE_PATH = path.resolve("logs", "ops-incident-state.json");

const P0_COOLDOWN_MS = 6 * 60 * 60 * 1_000;
const P1_COOLDOWN_MS = 24 * 60 * 60 * 1_000;
const P2_COOLDOWN_MS = 72 * 60 * 60 * 1_000;
const UNKNOWN_COOLDOWN_MS = 6 * 60 * 60 * 1_000;

/**
 * Computes a deterministic 64-character SHA-256 hex idempotency key from tuple parts or named fields.
 */
export function computeNotificationIdempotencyKey(
  parts:
    | readonly (string | number | boolean | null | undefined)[]
    | Readonly<Record<string, string | number | boolean | null | undefined>>,
): string {
  const canonical = Array.isArray(parts)
    ? parts.map((p) => String(p ?? "").trim()).join("|")
    : Object.keys(parts)
        .sort()
        .map((k) => `${k}=${String((parts as Record<string, unknown>)[k] ?? "").trim()}`)
        .join("|");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export interface EnqueueOutboxInput {
  stream: OutboxStream;
  channel: NotificationChannel;
  recipientTarget?: string;
  idempotencyKey: string;
  subject?: string | null;
  bodyText: string;
  bodyFormat?: "plain" | "html";
  metadata?: Record<string, unknown>;
  maxAttempts?: number;
  legalEntityId?: string | null;
}

export interface EnqueueOutboxResult {
  enqueued: boolean;
  id: string | null;
}

/**
 * Idempotently inserts a pending notification into `public.notification_outbox`.
 * Duplicate `idempotency_key` inserts return `{ enqueued: false, id: null }` without error.
 */
export async function enqueueOutboxNotification(
  client: Queryable,
  entry: EnqueueOutboxInput,
): Promise<EnqueueOutboxResult> {
  const recipientTarget = (entry.recipientTarget ?? "").trim() || `default:${entry.channel}`;
  const bodyFormat = entry.bodyFormat ?? "plain";
  const maxAttempts = Math.max(1, Math.floor(entry.maxAttempts ?? 5));

  const res = await client.query<{ id: string }>(
    `insert into public.notification_outbox
       (stream, channel, recipient_target, idempotency_key, subject, body_text, body_format, metadata, max_attempts, legal_entity_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
     on conflict (idempotency_key) do nothing
     returning id::text as id`,
    [
      entry.stream,
      entry.channel,
      recipientTarget,
      entry.idempotencyKey,
      entry.subject ?? null,
      entry.bodyText,
      bodyFormat,
      JSON.stringify(entry.metadata ?? {}),
      maxAttempts,
      entry.legalEntityId ?? null,
    ],
  );

  if ((res.rowCount ?? 0) === 1 && res.rows[0]?.id) {
    return { enqueued: true, id: res.rows[0].id };
  }
  return { enqueued: false, id: null };
}

export interface ClaimAndDispatchOutboxOptions {
  batchSize?: number;
  stream?: OutboxStream;
  channel?: NotificationChannel;
  transportResolver?: (channel: NotificationChannel) => Transport;
  staleClaimMinutes?: number;
}

export interface OutboxDispatchSummary {
  claimed: number;
  sent: number;
  retried: number;
  deadLettered: number;
  skipped: number;
  uncertain?: number;
}

interface ClaimedOutboxRow {
  id: string;
  stream: OutboxStream;
  channel: NotificationChannel;
  recipient_target: string;
  idempotency_key: string;
  subject: string | null;
  body_text: string;
  body_format: "plain" | "html";
  metadata: Record<string, unknown> | null;
  claim_token: string;
  attempt_count: number;
  max_attempts: number;
}

function computeRetryBackoffSeconds(nextAttemptCount: number): number {
  const exp = Math.min(7, Math.max(0, nextAttemptCount - 1));
  return Math.min(3600, 30 * 2 ** exp);
}

/**
 * Atomically claims due outbox rows (`FOR UPDATE SKIP LOCKED` + `claim_token = gen_random_uuid()`),
 * dispatches them outside the DB lock via `transportFor(channel)`, and finalizes status asserting
 * `res.rowCount === 1` on `(id, claim_token)`.
 */
export async function claimAndDispatchOutbox(
  pool: Pool,
  opts: ClaimAndDispatchOutboxOptions = {},
): Promise<OutboxDispatchSummary> {
  const batchSize = Math.max(1, Math.min(100, Math.floor(opts.batchSize ?? 25)));
  const staleMinutes = Math.max(1, Math.floor(opts.staleClaimMinutes ?? 10));
  const resolveTransport = opts.transportResolver ?? transportFor;

  let claimedRows: ClaimedOutboxRow[] = [];
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      `update public.notification_outbox
          set status = 'failed_retryable',
              claim_token = null,
              last_error = coalesce(last_error, 'stale_claim_recovered'),
              updated_at = now()
        where status = 'claiming'
          and claimed_at < now() - ($1::int * interval '1 minute')`,
      [staleMinutes],
    );

    const claimRes = await client.query<ClaimedOutboxRow>(
      `with due as (
         select id
           from public.notification_outbox
          where status in ('pending', 'failed_retryable')
            and next_retry_at <= now()
            and ($1::text is null or stream = $1)
            and ($2::text is null or channel = $2)
          order by next_retry_at asc, created_at asc
          limit $3
          for update skip locked
       )
       update public.notification_outbox o
          set status = 'claiming',
              claim_token = gen_random_uuid(),
              claimed_at = now(),
              updated_at = now()
         from due
        where o.id = due.id
       returning o.id::text as id,
                 o.stream,
                 o.channel,
                 o.recipient_target,
                 o.idempotency_key,
                 o.subject,
                 o.body_text,
                 o.body_format,
                 o.metadata,
                 o.claim_token::text as claim_token,
                 o.attempt_count,
                 o.max_attempts`,
      [opts.stream ?? null, opts.channel ?? null, batchSize],
    );
    claimedRows = claimRes.rows;
    await client.query("commit");
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  let sent = 0;
  let retried = 0;
  let deadLettered = 0;
  let skipped = 0;
  let uncertain = 0;

  for (const row of claimedRows) {
    const transport = resolveTransport(row.channel);
    let delivery: DeliveryResult;
    try {
      delivery = await transport.send(row.body_text, {
        ...(row.body_format === "html" && row.channel === "telegram" ? { parseMode: "HTML" as const } : {}),
        ...(row.subject ? { subject: row.subject } : {}),
      });
    } catch (err) {
      delivery = {
        ok: false,
        error: `outbox transport threw: ${redactBotToken((err as Error).message ?? String(err))}`,
      };
    }

    const classified = delivery as DeliveryResult & {
      uncertainOutcome?: boolean;
      retryAfterSeconds?: number | null;
    };

    if (delivery.ok) {
      const upd = await pool.query(
        `update public.notification_outbox
            set status = 'sent',
                sent_at = now(),
                attempt_count = attempt_count + 1,
                last_error = null,
                claim_token = null,
                updated_at = now()
          where id = $1 and claim_token = $2::uuid`,
        [row.id, row.claim_token],
      );
      if (upd.rowCount !== 1) {
        throw new Error(`Outbox sent güncellemesi claim_token doğrulamasını geçemedi (id=${row.id}).`);
      }
      sent += 1;
    } else if (delivery.skippedUnconfigured) {
      const upd = await pool.query(
        `update public.notification_outbox
            set status = 'skipped',
                attempt_count = attempt_count + 1,
                last_error = $3,
                claim_token = null,
                updated_at = now()
          where id = $1 and claim_token = $2::uuid`,
        [row.id, row.claim_token, redactBotToken(delivery.error ?? "skipped_unconfigured")],
      );
      if (upd.rowCount !== 1) {
        throw new Error(`Outbox skipped güncellemesi claim_token doğrulamasını geçemedi (id=${row.id}).`);
      }
      skipped += 1;
    } else if (classified.uncertainOutcome === true) {
      const safeError = redactBotToken(
        delivery.error ?? "delivery_uncertain: gönderim sonrası yanıt doğrulanamadı",
      );
      const upd = await pool.query(
        `update public.notification_outbox
            set status = 'delivery_uncertain',
                uncertain_at = now(),
                attempt_count = attempt_count + 1,
                last_error = $3,
                claim_token = null,
                updated_at = now()
          where id = $1 and claim_token = $2`,
        [row.id, row.claim_token, safeError],
      );
      if (upd.rowCount !== 1) {
        throw new Error(
          `Outbox delivery_uncertain güncellemesi claim_token doğrulamasını geçemedi (id=${row.id}).`,
        );
      }
      uncertain += 1;
    } else {
      const nextAttempt = Number(row.attempt_count) + 1;
      const maxAttempts = Math.max(1, Number(row.max_attempts));
      const nextStatus: OutboxStatus = nextAttempt >= maxAttempts ? "dead_letter" : "failed_retryable";
      const computedBackoff = computeRetryBackoffSeconds(nextAttempt);
      const backoffSec =
        typeof classified.retryAfterSeconds === "number" &&
        Number.isFinite(classified.retryAfterSeconds) &&
        classified.retryAfterSeconds > 0
          ? Math.max(Math.ceil(classified.retryAfterSeconds), computedBackoff)
          : computedBackoff;
      const safeError = redactBotToken(delivery.error ?? "bilinmeyen gönderim hatası");

      const upd = await pool.query(
        `update public.notification_outbox
            set status = $3,
                attempt_count = $4,
                next_retry_at = now() + ($5::int * interval '1 second'),
                last_error = $6,
                claim_token = null,
                updated_at = now()
          where id = $1 and claim_token = $2::uuid`,
        [row.id, row.claim_token, nextStatus, nextAttempt, backoffSec, safeError],
      );
      if (upd.rowCount !== 1) {
        throw new Error(`Outbox hata güncellemesi claim_token doğrulamasını geçemedi (id=${row.id}).`);
      }
      if (nextStatus === "dead_letter") deadLettered += 1;
      else retried += 1;
    }
  }

  return {
    claimed: claimedRows.length,
    sent,
    retried,
    deadLettered,
    skipped,
    uncertain,
  };
}

/* ── Stateful Operational Incidents (`public.ops_incidents` + JSON fallback) ──────────────── */

export interface OpsSignalInput {
  signal: string;
  severity: OpsIncidentSeverity;
  value: string;
  note?: string;
  threshold?: string;
  snapshotUnavailable?: boolean;
}

export interface OpsIncidentRecord {
  signalKey: string;
  severity: OpsIncidentSeverity;
  state: OpsIncidentState;
  lastValue: string;
  stateFingerprint: string;
  note: string;
  openedAt: string | null;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  suppressedUntil?: string | null;
  suppressionReason?: string | null;
  lastCheckedAt?: string | null;
  lastSuccessAt?: string | null;
  resolutionEvidence?: IncidentResolutionEvidence | null;
  correlationId?: string | null;
  lastNotifiedAt: string | null;
  lastNotifiedState: string | null;
  occurrenceCount: number;
  updatedAt: string;
}

export interface OpsIncidentNotification {
  signalKey: string;
  severity: OpsIncidentSeverity;
  previousState: OpsIncidentState;
  nextState: Exclude<OpsIncidentState, "OK" | "ACKNOWLEDGED" | "SUPPRESSED">;
  value: string;
  note: string;
  openedAt: string | null;
  resolvedAt: string | null;
  durationMs: number | null;
  durationLabel: string | null;
  resolutionEvidence?: IncidentResolutionEvidence | null;
  correlationId?: string | null;
  formattedLine: string;
}

export interface EvaluateOpsIncidentsOptions {
  now?: Date;
  stateFilePath?: string;
  /**
   * When true, `last_notified_at` is NOT stamped immediately during evaluation; caller calls
   * `markOpsIncidentsNotified(...)` once an external transport actually succeeds (`ok: true`).
   * Defaults to `false` (stamps `last_notified_at` immediately for emitted notifications).
   */
  deferNotifiedStamp?: boolean;
  correlationId?: string;
}

export interface OpsIncidentEvaluationResult {
  usedFallbackFile: boolean;
  stateFilePath: string;
  records: OpsIncidentRecord[];
  notifications: OpsIncidentNotification[];
}

export function formatIncidentDurationTr(openedAtISO: string | null, resolvedAt: Date): string {
  if (!openedAtISO) return "<1dk";
  const openedMs = Date.parse(openedAtISO);
  if (!Number.isFinite(openedMs)) return "<1dk";
  const diffSec = Math.max(0, Math.round((resolvedAt.getTime() - openedMs) / 1_000));
  if (diffSec < 60) return `${diffSec}sn`;
  const totalMinutes = Math.floor(diffSec / 60);
  if (totalMinutes < 60) return `${totalMinutes}dk`;
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  if (hours < 24) return mins > 0 ? `${hours}sa ${mins}dk` : `${hours}sa`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}g ${remHours}sa` : `${days}g`;
}

function cooldownMsForSeverity(severity: OpsIncidentSeverity): number {
  if (severity === "P0") return P0_COOLDOWN_MS;
  if (severity === "P1") return P1_COOLDOWN_MS;
  return P2_COOLDOWN_MS;
}

function severityRank(severity: OpsIncidentSeverity): number {
  if (severity === "P0") return 3;
  if (severity === "P1") return 2;
  return 1;
}

function parseResolutionEvidence(raw: unknown): IncidentResolutionEvidence | null {
  if (!raw) return null;
  let obj: unknown = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const r = obj as Record<string, unknown>;
  if (
    typeof r.whatChanged === "string" &&
    typeof r.verifiedByCheck === "string" &&
    typeof r.verifiedAtISO === "string" &&
    typeof r.measuredValue === "string" &&
    typeof r.evidenceSource === "string"
  ) {
    return {
      whatChanged: r.whatChanged,
      verifiedByCheck: r.verifiedByCheck,
      verifiedAtISO: r.verifiedAtISO,
      measuredValue: r.measuredValue,
      evidenceSource: r.evidenceSource,
    };
  }
  return null;
}

function readLocalIncidentMap(filePath: string): Map<string, OpsIncidentRecord> {
  const map = new Map<string, OpsIncidentRecord>();
  try {
    if (!existsSync(filePath)) return map;
    const raw = JSON.parse(readFileSync(filePath, "utf8")) as {
      incidents?: Record<string, OpsIncidentRecord>;
    };
    if (raw && raw.incidents && typeof raw.incidents === "object") {
      for (const [k, v] of Object.entries(raw.incidents)) {
        if (v && typeof v === "object" && typeof v.signalKey === "string") {
          map.set(k, v);
        }
      }
    }
  } catch {
    // Corrupted or missing local state starts fresh without crashing alerting.
  }
  return map;
}

function writeLocalIncidentMapSafe(filePath: string, map: ReadonlyMap<string, OpsIncidentRecord>): void {
  try {
    const resolved = path.resolve(filePath);
    mkdirSync(path.dirname(resolved), { recursive: true });
    const obj: Record<string, OpsIncidentRecord> = {};
    for (const [k, v] of map.entries()) obj[k] = v;
    const tmp = `${resolved}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(
      tmp,
      JSON.stringify({ updatedAt: new Date().toISOString(), incidents: obj }, null, 2) + "\n",
      "utf8",
    );
    renameSync(tmp, resolved);
  } catch {
    // Best-effort local persistence (e.g. unwritable directory test must not throw here).
  }
}

async function loadDbIncidentMap(pool: Pool): Promise<Map<string, OpsIncidentRecord>> {
  const res = await pool.query<{
    signal_key: string;
    severity: OpsIncidentSeverity;
    state: OpsIncidentState;
    last_value: string;
    state_fingerprint: string;
    note: string;
    opened_at: Date | string | null;
    acknowledged_at: Date | string | null;
    resolved_at: Date | string | null;
    suppressed_until?: Date | string | null;
    suppression_reason?: string | null;
    last_checked_at?: Date | string | null;
    last_success_at?: Date | string | null;
    resolution_evidence?: unknown;
    correlation_id?: string | null;
    last_notified_at: Date | string | null;
    last_notified_state: string | null;
    occurrence_count: number;
    updated_at: Date | string;
  }>(`select * from public.ops_incidents`);

  const toIso = (v: Date | string | null | undefined): string | null =>
    v == null ? null : v instanceof Date ? v.toISOString() : new Date(v).toISOString();

  const map = new Map<string, OpsIncidentRecord>();
  for (const r of res.rows) {
    map.set(r.signal_key, {
      signalKey: r.signal_key,
      severity: r.severity,
      state: r.state,
      lastValue: r.last_value,
      stateFingerprint: r.state_fingerprint,
      note: r.note,
      openedAt: toIso(r.opened_at),
      acknowledgedAt: toIso(r.acknowledged_at),
      resolvedAt: toIso(r.resolved_at),
      suppressedUntil: toIso(r.suppressed_until),
      suppressionReason: r.suppression_reason ?? null,
      lastCheckedAt: toIso(r.last_checked_at),
      lastSuccessAt: toIso(r.last_success_at),
      resolutionEvidence: parseResolutionEvidence(r.resolution_evidence),
      correlationId: r.correlation_id ?? null,
      lastNotifiedAt: toIso(r.last_notified_at),
      lastNotifiedState: r.last_notified_state,
      occurrenceCount: Number(r.occurrence_count ?? 0),
      updatedAt: toIso(r.updated_at) ?? new Date().toISOString(),
    });
  }
  return map;
}

async function persistDbIncidentRecords(
  pool: Pool,
  records: readonly OpsIncidentRecord[],
): Promise<void> {
  if (records.length === 0) return;
  for (const rec of records) {
    try {
      await pool.query(
        `insert into public.ops_incidents
           (signal_key, severity, state, last_value, state_fingerprint, note,
            opened_at, acknowledged_at, resolved_at, suppressed_until, suppression_reason,
            last_checked_at, last_success_at, resolution_evidence, correlation_id,
            last_notified_at, last_notified_state, occurrence_count, updated_at)
         values ($1, $2, $3, $4, $5, $6,
                 $7::timestamptz, $8::timestamptz, $9::timestamptz, $10::timestamptz, $11,
                 $12::timestamptz, $13::timestamptz, $14::jsonb, $15,
                 $16::timestamptz, $17, $18, $19::timestamptz)
         on conflict (signal_key) do update
           set severity = excluded.severity,
               state = excluded.state,
               last_value = excluded.last_value,
               state_fingerprint = excluded.state_fingerprint,
               note = excluded.note,
               opened_at = excluded.opened_at,
               acknowledged_at = excluded.acknowledged_at,
               resolved_at = excluded.resolved_at,
               suppressed_until = excluded.suppressed_until,
               suppression_reason = excluded.suppression_reason,
               last_checked_at = excluded.last_checked_at,
               last_success_at = excluded.last_success_at,
               resolution_evidence = excluded.resolution_evidence,
               correlation_id = excluded.correlation_id,
               last_notified_at = excluded.last_notified_at,
               last_notified_state = excluded.last_notified_state,
               occurrence_count = excluded.occurrence_count,
               updated_at = excluded.updated_at`,
        [
          rec.signalKey,
          rec.severity,
          rec.state,
          rec.lastValue,
          rec.stateFingerprint,
          rec.note,
          rec.openedAt,
          rec.acknowledgedAt,
          rec.resolvedAt,
          rec.suppressedUntil ?? null,
          rec.suppressionReason ?? null,
          rec.lastCheckedAt ?? null,
          rec.lastSuccessAt ?? null,
          rec.resolutionEvidence ? JSON.stringify(rec.resolutionEvidence) : null,
          rec.correlationId ?? null,
          rec.lastNotifiedAt,
          rec.lastNotifiedState,
          rec.occurrenceCount,
          rec.updatedAt,
        ],
      );
    } catch {
      const legacyState = rec.state === "SUPPRESSED" ? "OPEN" : rec.state;
      await pool.query(
        `insert into public.ops_incidents
           (signal_key, severity, state, last_value, state_fingerprint, note,
            opened_at, acknowledged_at, resolved_at, last_notified_at, last_notified_state,
            occurrence_count, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz, $9::timestamptz,
                 $10::timestamptz, $11, $12, $13::timestamptz)
         on conflict (signal_key) do update
           set severity = excluded.severity,
               state = excluded.state,
               last_value = excluded.last_value,
               state_fingerprint = excluded.state_fingerprint,
               note = excluded.note,
               opened_at = excluded.opened_at,
               acknowledged_at = excluded.acknowledged_at,
               resolved_at = excluded.resolved_at,
               last_notified_at = excluded.last_notified_at,
               last_notified_state = excluded.last_notified_state,
               occurrence_count = excluded.occurrence_count,
               updated_at = excluded.updated_at`,
        [
          rec.signalKey,
          rec.severity,
          legacyState,
          rec.lastValue,
          rec.stateFingerprint,
          rec.note,
          rec.openedAt,
          rec.acknowledgedAt,
          rec.resolvedAt,
          rec.lastNotifiedAt,
          rec.lastNotifiedState,
          rec.occurrenceCount,
          rec.updatedAt,
        ],
      );
    }
  }
}

/**
 * Evaluates current operational signals against stored incident states (`public.ops_incidents` with
 * automatic fallback to `logs/ops-incident-state.json` when PostgreSQL is unavailable).
 *
 * State machine rules:
 * - `OK/RESOLVED -> OPEN`: emits `[OPEN][P0/P1/P2]`
 * - `OPEN -> OPEN`: suppresses duplicate re-sends within cooldown (`6h` P0, `24h` P1, `72h` P2) unless severity escalates (`P2 -> P1`, `P1 -> P0`)
 * - `SUPPRESSED`: silences notifications while `suppressedUntil` is unset or in the future; resumes normal transitions once expired
 * - `OPEN/ACKNOWLEDGED/UNKNOWN -> RESOLVED`: emits explicit `[RESOLVED]` notification with duration and structured `resolutionEvidence`
 * - Query/probe failure (`value === "?"` or `snapshotUnavailable`): transitions to `UNKNOWN` (NEVER `RESOLVED`) and emits `[UNKNOWN]`
 */
export async function evaluateAndRecordOpsIncidents(
  poolOrNull: Pool | null | undefined,
  signals: readonly OpsSignalInput[],
  opts: EvaluateOpsIncidentsOptions = {},
): Promise<OpsIncidentEvaluationResult> {
  const now = opts.now ?? new Date();
  const nowISO = now.toISOString();
  const nowMs = now.getTime();
  const stateFilePath = opts.stateFilePath ?? DEFAULT_OPS_INCIDENT_STATE_PATH;
  const deferStamp = Boolean(opts.deferNotifiedStamp);

  let usedFallbackFile = !poolOrNull;
  let existingMap: Map<string, OpsIncidentRecord>;

  if (poolOrNull) {
    try {
      existingMap = await loadDbIncidentMap(poolOrNull);
    } catch {
      usedFallbackFile = true;
      existingMap = readLocalIncidentMap(stateFilePath);
    }
  } else {
    existingMap = readLocalIncidentMap(stateFilePath);
  }

  const isBlindSnapshotRun = signals.some(
    (s) => s.snapshotUnavailable === true || s.signal === "telemetry_snapshot_unavailable",
  );

  const incomingByKey = new Map<string, OpsSignalInput>();
  for (const sig of signals) {
    incomingByKey.set(sig.signal, sig);
  }

  const changedRecords: OpsIncidentRecord[] = [];
  const notifications: OpsIncidentNotification[] = [];

  for (const sig of signals) {
    const prev = existingMap.get(sig.signal);
    const prevState: OpsIncidentState = prev?.state ?? "OK";
    const noteText = (sig.note ?? sig.threshold ?? "").trim();
    const isUnknown =
      sig.snapshotUnavailable === true ||
      sig.signal === "telemetry_snapshot_unavailable" ||
      sig.value.trim() === "?";

    const fingerprint = createHash("sha256")
      .update(`${sig.signal}|${sig.severity}|${isUnknown ? "UNKNOWN" : "OPEN"}|${sig.value}`, "utf8")
      .digest("hex")
      .slice(0, 16);

    if (prev?.state === "SUPPRESSED") {
      const stillSuppressed =
        !prev.suppressedUntil ||
        (Number.isFinite(Date.parse(prev.suppressedUntil)) &&
          Date.parse(prev.suppressedUntil) > nowMs);
      if (stillSuppressed) {
        const suppressedRecord: OpsIncidentRecord = {
          ...prev,
          signalKey: sig.signal,
          severity: sig.severity,
          state: "SUPPRESSED",
          lastValue: sig.value,
          stateFingerprint: fingerprint,
          note: noteText || prev.note,
          openedAt: prev.openedAt ?? nowISO,
          suppressedUntil: prev.suppressedUntil ?? null,
          suppressionReason: prev.suppressionReason ?? null,
          lastCheckedAt: nowISO,
          lastSuccessAt: isUnknown ? (prev.lastSuccessAt ?? null) : nowISO,
          resolutionEvidence: null,
          correlationId: opts.correlationId ?? prev.correlationId ?? null,
          occurrenceCount: (prev.occurrenceCount ?? 0) + 1,
          updatedAt: nowISO,
        };
        existingMap.set(sig.signal, suppressedRecord);
        changedRecords.push(suppressedRecord);
        continue;
      }
    }

    if (isUnknown) {
      const openedAt =
        prev &&
        (prev.state === "OPEN" ||
          prev.state === "ACKNOWLEDGED" ||
          prev.state === "UNKNOWN" ||
          prev.state === "SUPPRESSED") &&
        prev.openedAt
          ? prev.openedAt
          : nowISO;

      const lastNotifiedMs = prev?.lastNotifiedAt ? Date.parse(prev.lastNotifiedAt) : Number.NaN;
      const shouldNotify =
        prevState !== "UNKNOWN" ||
        !Number.isFinite(lastNotifiedMs) ||
        prev?.lastNotifiedState !== "UNKNOWN" ||
        nowMs - lastNotifiedMs >= UNKNOWN_COOLDOWN_MS;

      const updated: OpsIncidentRecord = {
        signalKey: sig.signal,
        severity: sig.severity,
        state: "UNKNOWN",
        lastValue: sig.value,
        stateFingerprint: fingerprint,
        note: noteText,
        openedAt,
        acknowledgedAt: null,
        resolvedAt: null,
        suppressedUntil: null,
        suppressionReason: null,
        lastCheckedAt: nowISO,
        lastSuccessAt: prev?.lastSuccessAt ?? null,
        resolutionEvidence: null,
        correlationId: opts.correlationId ?? prev?.correlationId ?? null,
        lastNotifiedAt: shouldNotify && !deferStamp ? nowISO : (prev?.lastNotifiedAt ?? null),
        lastNotifiedState: shouldNotify && !deferStamp ? "UNKNOWN" : (prev?.lastNotifiedState ?? null),
        occurrenceCount: (prev?.occurrenceCount ?? 0) + 1,
        updatedAt: nowISO,
      };
      existingMap.set(sig.signal, updated);
      changedRecords.push(updated);

      if (shouldNotify) {
        const detail = noteText ? ` (${noteText})` : "";
        notifications.push({
          signalKey: sig.signal,
          severity: sig.severity,
          previousState: prevState,
          nextState: "UNKNOWN",
          value: sig.value,
          note: noteText,
          openedAt,
          resolvedAt: null,
          durationMs: null,
          durationLabel: null,
          resolutionEvidence: null,
          correlationId: updated.correlationId ?? null,
          formattedLine: `[UNKNOWN][${sig.severity}] ${sig.signal} = ${sig.value}${detail}`,
        });
      }
      continue;
    }

    // Real firing alert (`value !== "?"` and `!snapshotUnavailable`)
    const escalatedSeverity =
      prev != null &&
      (prevState === "OPEN" || prevState === "ACKNOWLEDGED") &&
      severityRank(sig.severity) > severityRank(prev.severity);
    const nextState: OpsIncidentState =
      prevState === "ACKNOWLEDGED" && !escalatedSeverity ? "ACKNOWLEDGED" : "OPEN";
    const openedAt =
      prev &&
      (prevState === "OPEN" ||
        prevState === "ACKNOWLEDGED" ||
        prevState === "UNKNOWN" ||
        prevState === "SUPPRESSED") &&
      prev.openedAt
        ? prev.openedAt
        : nowISO;

    let shouldNotify = false;
    if (nextState === "OPEN") {
      if (prevState !== "OPEN" || escalatedSeverity) {
        shouldNotify = true;
      } else {
        const lastNotifiedMs = prev?.lastNotifiedAt ? Date.parse(prev.lastNotifiedAt) : Number.NaN;
        const cooldownMs = cooldownMsForSeverity(sig.severity);
        shouldNotify =
          !Number.isFinite(lastNotifiedMs) ||
          prev?.lastNotifiedState !== "OPEN" ||
          nowMs - lastNotifiedMs >= cooldownMs;
      }
    }

    const updated: OpsIncidentRecord = {
      signalKey: sig.signal,
      severity: sig.severity,
      state: nextState,
      lastValue: sig.value,
      stateFingerprint: fingerprint,
      note: noteText,
      openedAt,
      acknowledgedAt: nextState === "ACKNOWLEDGED" ? (prev?.acknowledgedAt ?? nowISO) : null,
      resolvedAt: null,
      suppressedUntil: null,
      suppressionReason: null,
      lastCheckedAt: nowISO,
      lastSuccessAt: nowISO,
      resolutionEvidence: null,
      correlationId: opts.correlationId ?? prev?.correlationId ?? null,
      lastNotifiedAt: shouldNotify && !deferStamp ? nowISO : (prev?.lastNotifiedAt ?? null),
      lastNotifiedState: shouldNotify && !deferStamp ? "OPEN" : (prev?.lastNotifiedState ?? null),
      occurrenceCount: (prev?.occurrenceCount ?? 0) + 1,
      updatedAt: nowISO,
    };
    existingMap.set(sig.signal, updated);
    changedRecords.push(updated);

    if (shouldNotify) {
      const detail = noteText ? ` (${noteText})` : "";
      const escalationSuffix =
        escalatedSeverity && prev ? ` [eskalasyon: ${prev.severity} -> ${sig.severity}]` : "";
      notifications.push({
        signalKey: sig.signal,
        severity: sig.severity,
        previousState: prevState,
        nextState: "OPEN",
        value: sig.value,
        note: noteText,
        openedAt,
        resolvedAt: null,
        durationMs: null,
        durationLabel: null,
        resolutionEvidence: null,
        correlationId: updated.correlationId ?? null,
        formattedLine: `[OPEN][${sig.severity}] ${sig.signal} = ${sig.value}${detail}${escalationSuffix}`,
      });
    }
  }

  // Transition previously active incidents (`OPEN`, `ACKNOWLEDGED`, `UNKNOWN`, or expired `SUPPRESSED`) that cleared -> `RESOLVED`
  if (!isBlindSnapshotRun) {
    for (const [key, prev] of existingMap.entries()) {
      if (incomingByKey.has(key)) continue;
      if (prev.state === "SUPPRESSED") {
        const stillSuppressed =
          !prev.suppressedUntil ||
          (Number.isFinite(Date.parse(prev.suppressedUntil)) &&
            Date.parse(prev.suppressedUntil) > nowMs);
        if (stillSuppressed) continue;
      }
      if (
        prev.state !== "OPEN" &&
        prev.state !== "ACKNOWLEDGED" &&
        prev.state !== "UNKNOWN" &&
        prev.state !== "SUPPRESSED"
      ) {
        continue;
      }

      const durationLabel = formatIncidentDurationTr(prev.openedAt, now);
      const durationMs =
        prev.openedAt && Number.isFinite(Date.parse(prev.openedAt))
          ? Math.max(0, nowMs - Date.parse(prev.openedAt))
          : null;

      const resolutionEvidence: IncidentResolutionEvidence = {
        whatChanged: `${key}: ${prev.lastValue} -> OK`,
        verifiedByCheck: `telemetry:${key}`,
        verifiedAtISO: nowISO,
        measuredValue: "OK",
        evidenceSource: opts.correlationId ? `telemetry:${opts.correlationId}` : "telemetry-snapshot",
      };
      const resolvedCorrelationId = opts.correlationId ?? prev.correlationId ?? null;
      const shouldNotifyResolved = true;

      const resolvedRecord: OpsIncidentRecord = {
        ...prev,
        state: "RESOLVED",
        resolvedAt: nowISO,
        suppressedUntil: null,
        suppressionReason: null,
        lastCheckedAt: nowISO,
        lastSuccessAt: nowISO,
        resolutionEvidence,
        correlationId: resolvedCorrelationId,
        lastNotifiedAt: shouldNotifyResolved && !deferStamp ? nowISO : prev.lastNotifiedAt,
        lastNotifiedState: shouldNotifyResolved && !deferStamp ? "RESOLVED" : prev.lastNotifiedState,
        updatedAt: nowISO,
      };
      existingMap.set(key, resolvedRecord);
      changedRecords.push(resolvedRecord);

      if (shouldNotifyResolved) {
        notifications.push({
          signalKey: key,
          severity: prev.severity,
          previousState: prev.state,
          nextState: "RESOLVED",
          value: "OK",
          note: prev.note,
          openedAt: prev.openedAt,
          resolvedAt: nowISO,
          durationMs,
          durationLabel,
          resolutionEvidence,
          correlationId: resolvedCorrelationId,
          formattedLine: `[RESOLVED][${prev.severity}] ${key} normale döndü (süre: ${durationLabel} · doğrulama: ${resolutionEvidence.verifiedByCheck} -> ${resolutionEvidence.measuredValue})`,
        });
      }
    }
  }

  if (changedRecords.length > 0) {
    if (poolOrNull && !usedFallbackFile) {
      try {
        await persistDbIncidentRecords(poolOrNull, changedRecords);
      } catch {
        usedFallbackFile = true;
      }
    }
    // Always mirror state to local JSON fallback so a subsequent DB outage has up-to-date prior state!
    writeLocalIncidentMapSafe(stateFilePath, existingMap);
  }

  return {
    usedFallbackFile,
    stateFilePath,
    records: [...existingMap.values()],
    notifications,
  };
}

/**
 * Stamps `last_notified_at` and `last_notified_state` after at least one external alert channel
 * (`telegram` / `email`) successfully delivered a deferred notification batch.
 */
export async function markOpsIncidentsNotified(
  poolOrNull: Pool | null | undefined,
  notifications: readonly OpsIncidentNotification[],
  at = new Date(),
  stateFilePath = DEFAULT_OPS_INCIDENT_STATE_PATH,
): Promise<void> {
  if (notifications.length === 0) return;
  const nowISO = at.toISOString();

  if (poolOrNull) {
    try {
      for (const n of notifications) {
        await poolOrNull.query(
          `update public.ops_incidents
              set last_notified_at = $2::timestamptz,
                  last_notified_state = $3,
                  updated_at = $2::timestamptz
            where signal_key = $1`,
          [n.signalKey, nowISO, n.nextState],
        );
      }
    } catch {
      // Fall through to local JSON state mirror.
    }
  }

  const localMap = readLocalIncidentMap(stateFilePath);
  let touched = false;
  for (const n of notifications) {
    const existing = localMap.get(n.signalKey);
    if (existing) {
      localMap.set(n.signalKey, {
        ...existing,
        lastNotifiedAt: nowISO,
        lastNotifiedState: n.nextState,
        updatedAt: nowISO,
      });
      touched = true;
    }
  }
  if (touched) {
    writeLocalIncidentMapSafe(stateFilePath, localMap);
  }
}
