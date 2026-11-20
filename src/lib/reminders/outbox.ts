// Unified Idempotent Notification Outbox & Stateful Ops Incident Engine (Migration 0122 / 0124 / V2 Agent 07).
// BOUNDARY INVARIANT: Zero process.env, zero fetch, zero secret console logging.
// Outbound delivery routes exclusively through `@/lib/reminders/transport`.

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Pool, PoolClient } from "pg";
import type {
  IncidentLifecycleState,
  IncidentResolutionEvidence,
  IncidentSeverityLevel,
  OutboxDurableDispatchPhase,
} from "@/lib/contracts/remediation-contracts";
import { isUnreadableTelemetryValue } from "@/lib/ops/telemetry-alerts";
import {
  redactBotToken,
  transportFor,
  type DeliveryResult,
  type NotificationChannel,
  type Transport,
} from "./transport";

export type { IncidentResolutionEvidence, OutboxDurableDispatchPhase };

export type OutboxQueryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;
type Queryable = OutboxQueryable;

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
  correlationId?: string | null;
}

export interface EnqueueOutboxResult {
  enqueued: boolean;
  id: string | null;
}

/**
 * Idempotently inserts a pending notification into `public.notification_outbox` (`dispatchPhase = 'prepared'`).
 * Duplicate `idempotency_key` inserts return `{ enqueued: false, id: null }` without error.
 */
export async function enqueueOutboxNotification(
  client: Queryable,
  entry: EnqueueOutboxInput,
): Promise<EnqueueOutboxResult> {
  const recipientTarget = (entry.recipientTarget ?? "").trim() || `default:${entry.channel}`;
  const bodyFormat = entry.bodyFormat ?? "plain";
  const maxAttempts = Math.max(1, Math.floor(entry.maxAttempts ?? 5));
  const initialMetadata: Record<string, unknown> = {
    dispatchPhase: "prepared" satisfies OutboxDurableDispatchPhase,
    ...(entry.correlationId ? { correlationId: entry.correlationId } : {}),
    ...(entry.metadata ?? {}),
  };

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
      JSON.stringify(initialMetadata),
      maxAttempts,
      entry.legalEntityId ?? null,
    ],
  );

  if ((res.rowCount ?? 0) === 1 && res.rows[0]?.id) {
    return { enqueued: true, id: res.rows[0].id };
  }
  return { enqueued: false, id: null };
}

/**
 * Durably stamps `metadata.dispatchPhase = 'sending'` BEFORE invoking an external transport (`F-09`).
 * Asserts `(upd.rowCount ?? 0) === 1` on `(id, status = 'claiming', claim_token)` so a worker that
 * lost its claim NEVER initiates an external network send.
 */
export async function markOutboxSendingStarted(
  client: Queryable,
  id: string,
  claimToken: string,
  extraMeta?: Record<string, unknown>,
): Promise<void> {
  const upd = await client.query(
    `update public.notification_outbox
        set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
              'dispatchPhase', 'sending',
              'sendingStartedAt', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
              'sendAttempt', attempt_count + 1
            ) || $3::jsonb,
            updated_at = now()
      where id = $1 and status = 'claiming' and claim_token = $2::uuid`,
    [id, claimToken, JSON.stringify(extraMeta ?? {})],
  );
  if ((upd.rowCount ?? 0) !== 1) {
    throw new Error(
      `Outbox sending fazı başlatılamadı: claim_token doğrulaması başarısız (id=${id}).`,
    );
  }
}

/** Alias exported for Agent 06 (`src/lib/reminders/engine.ts`) pre-send intent fencing. */
export const beginOutboxSending = markOutboxSendingStarted;

export interface PreparedOutboxSendingIntent {
  outboxId: string | null;
  claimToken: string | null;
  alreadyHandled: boolean;
  existingStatus: OutboxStatus | null;
}

/**
 * Durably persists a `notification_outbox` row in `status = 'claiming'` with `metadata.dispatchPhase = 'sending'`
 * BEFORE external transport dispatch (`Agent 06` <-> `Agent 07` V2 handoff contract).
 *
 * If the `idempotencyKey` was already handled (`sent`, `delivery_uncertain`, `claiming`, `skipped`, or `dead_letter`),
 * returns `{ alreadyHandled: true, existingStatus }` so the caller skips external send cleanly.
 */
export async function prepareOutboxSendingIntent(
  client: Queryable,
  entry: EnqueueOutboxInput & { claimToken?: string },
): Promise<PreparedOutboxSendingIntent> {
  const claimToken = entry.claimToken ?? randomUUID();
  const sendingMeta: Record<string, unknown> = {
    ...(entry.correlationId ? { correlationId: entry.correlationId } : {}),
    ...(entry.metadata ?? {}),
    dispatchPhase: "sending" satisfies OutboxDurableDispatchPhase,
    sendingStartedAt: new Date().toISOString(),
  };

  const existingRes = await client.query<{ id: string; status: OutboxStatus }>(
    `select id::text as id, status
       from public.notification_outbox
      where idempotency_key = $1
      limit 1`,
    [entry.idempotencyKey],
  );

  if ((existingRes.rowCount ?? 0) > 0 && existingRes.rows[0]) {
    const existing = existingRes.rows[0];
    if (
      existing.status === "sent" ||
      existing.status === "delivery_uncertain" ||
      existing.status === "claiming" ||
      existing.status === "skipped" ||
      existing.status === "dead_letter"
    ) {
      return {
        outboxId: existing.id,
        claimToken: null,
        alreadyHandled: true,
        existingStatus: existing.status,
      };
    }

    const claimUpd = await client.query<{ id: string }>(
      `update public.notification_outbox
          set status = 'claiming',
              claim_token = $2::uuid,
              claimed_at = now(),
              metadata = coalesce(metadata, '{}'::jsonb) || $3::jsonb,
              updated_at = now()
        where id = $1
          and status in ('pending', 'failed_retryable')`,
      [existing.id, claimToken, JSON.stringify(sendingMeta)],
    );
    if ((claimUpd.rowCount ?? 0) === 1) {
      return {
        outboxId: existing.id,
        claimToken,
        alreadyHandled: false,
        existingStatus: existing.status,
      };
    }
    return {
      outboxId: existing.id,
      claimToken: null,
      alreadyHandled: true,
      existingStatus: "claiming",
    };
  }

  const enqueued = await enqueueOutboxNotification(client, {
    ...entry,
    metadata: sendingMeta,
  });

  if (!enqueued.enqueued || !enqueued.id) {
    const raceWinner = await client.query<{ id: string; status: OutboxStatus }>(
      `select id::text as id, status
         from public.notification_outbox
        where idempotency_key = $1
        limit 1`,
      [entry.idempotencyKey],
    );
    const winner = raceWinner.rows[0];
    return {
      outboxId: winner?.id ?? null,
      claimToken: null,
      alreadyHandled: true,
      existingStatus: winner?.status ?? "claiming",
    };
  }

  const claimUpd = await client.query<{ id: string }>(
    `update public.notification_outbox
        set status = 'claiming',
            claim_token = $2::uuid,
            claimed_at = now(),
            metadata = coalesce(metadata, '{}'::jsonb) || $3::jsonb,
            updated_at = now()
      where id = $1
        and status in ('pending', 'failed_retryable')`,
    [enqueued.id, claimToken, JSON.stringify(sendingMeta)],
  );

  if ((claimUpd.rowCount ?? 0) !== 1) {
    return {
      outboxId: enqueued.id,
      claimToken: null,
      alreadyHandled: true,
      existingStatus: "claiming",
    };
  }

  return {
    outboxId: enqueued.id,
    claimToken,
    alreadyHandled: false,
    existingStatus: null,
  };
}

export interface StaleOutboxRecoverySummary {
  uncertainCount: number;
  preSendRetryableCount: number;
}

/**
 * Safely recovers stale `claiming` rows (`F-09`):
 * 1. Rows where external send ALREADY started (`metadata->>'dispatchPhase' = 'sending'`) transition
 *    atomically to `delivery_uncertain` (`requiresOperatorReconciliation = true`) — NEVER auto-requeued!
 * 2. Rows where the worker crashed BEFORE `markOutboxSendingStarted` (`dispatchPhase <> 'sending'`)
 *    recover safely to `failed_retryable`.
 */
export async function recoverStaleOutboxClaims(
  client: Queryable,
  staleMinutes = 10,
): Promise<StaleOutboxRecoverySummary> {
  const clampedMinutes = Math.max(1, Math.floor(staleMinutes));

  const uncertainRes = await client.query(
    `update public.notification_outbox
        set status = 'delivery_uncertain',
            uncertain_at = coalesce(uncertain_at, now()),
            claim_token = null,
            last_error = coalesce(last_error, 'stale_claim_after_sending_started: operator_reconciliation_required'),
            metadata = coalesce(metadata, '{}'::jsonb) || '{"dispatchPhase":"delivery_uncertain","requiresOperatorReconciliation":true}'::jsonb,
            updated_at = now()
      where status = 'claiming'
        and claimed_at < now() - ($1::int * interval '1 minute')
        and coalesce(metadata->>'dispatchPhase', '') = 'sending'`,
    [clampedMinutes],
  );

  const preSendRes = await client.query(
    `update public.notification_outbox
        set status = 'failed_retryable',
            claim_token = null,
            last_error = coalesce(last_error, 'stale_pre_send_claim_recovered'),
            metadata = coalesce(metadata, '{}'::jsonb) || '{"dispatchPhase":"failed_retryable"}'::jsonb,
            updated_at = now()
      where status = 'claiming'
        and claimed_at < now() - ($1::int * interval '1 minute')
        and coalesce(metadata->>'dispatchPhase', '') <> 'sending'`,
    [clampedMinutes],
  );

  return {
    uncertainCount: uncertainRes.rowCount ?? 0,
    preSendRetryableCount: preSendRes.rowCount ?? 0,
  };
}

/**
 * Classifies an uncaught exception thrown by `transport.send()` after `dispatchPhase = 'sending'`
 * was committed. Any timeout, abort, socket reset, or indeterminate post-send exception where
 * external delivery cannot be ruled out maps to `uncertainOutcome: true` (`delivery_uncertain`).
 */
export function classifyThrownTransportError(err: unknown): DeliveryResult {
  const errObj = err as {
    name?: unknown;
    code?: unknown;
    message?: unknown;
    uncertainOutcome?: unknown;
  } | null;
  const errName = typeof errObj?.name === "string" ? errObj.name : "";
  const errCode = typeof errObj?.code === "string" ? errObj.code : "";
  const rawMsg =
    typeof errObj?.message === "string" ? errObj.message : String(err ?? "unknown transport error");
  const safeMsg = redactBotToken(rawMsg);

  if (errObj?.uncertainOutcome === false) {
    return {
      ok: false,
      uncertainOutcome: false,
      failureKind: "temporary_infra_failure",
      error: `outbox transport threw: ${safeMsg}`,
    };
  }

  const definitelyPreConnect =
    /^(?:ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ERR_INVALID_URL)$/i.test(errCode) ||
    /\b(?:ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ERR_INVALID_URL)\b/i.test(rawMsg);

  if (definitelyPreConnect && errObj?.uncertainOutcome !== true) {
    return {
      ok: false,
      uncertainOutcome: false,
      failureKind: "temporary_infra_failure",
      error: `outbox transport threw: ${safeMsg}`,
    };
  }

  const isTimeout =
    errName === "TimeoutError" ||
    errName === "AbortError" ||
    /^(?:ETIMEDOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT)$/i.test(errCode) ||
    /timeout|aborted/i.test(rawMsg);

  return {
    ok: false,
    uncertainOutcome: true,
    failureKind: isTimeout ? "timeout" : "unknown_outcome",
    error: `outbox transport threw: ${safeMsg}`,
  };
}

function extractProviderMessageIds(
  delivery: DeliveryResult & {
    providerMessageId?: string | number | null;
    messageIds?: readonly (string | number)[];
  },
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const pushId = (val: unknown) => {
    if (typeof val === "number" && Number.isFinite(val)) {
      const s = String(val);
      if (!seen.has(s)) {
        seen.add(s);
        out.push(s);
      }
    } else if (typeof val === "string" && val.trim() !== "") {
      const s = val.trim();
      if (!seen.has(s)) {
        seen.add(s);
        out.push(s);
      }
    }
  };

  if (Array.isArray(delivery.providerMessageIds)) {
    for (const id of delivery.providerMessageIds) pushId(id);
  }
  if (Array.isArray(delivery.messageIds)) {
    for (const id of delivery.messageIds) pushId(id);
  }
  if (delivery.providerMessageId !== undefined && delivery.providerMessageId !== null) {
    pushId(delivery.providerMessageId);
  }
  return out;
}

function computeRetryBackoffSeconds(nextAttemptCount: number): number {
  const exp = Math.min(7, Math.max(0, nextAttemptCount - 1));
  return Math.min(3600, 30 * 2 ** exp);
}

export interface FinalizeOutboxSendingOutcomeParams {
  outboxId: string;
  claimToken: string;
  idempotencyKey?: string;
  attemptCount?: number;
  maxAttempts?: number;
  delivery: DeliveryResult & {
    uncertainOutcome?: boolean;
    retryAfterSeconds?: number | null;
    providerMessageId?: string | number | null;
    messageIds?: readonly (string | number)[];
  };
}

/**
 * Finalizes a claimed `'sending'` outbox row to `sent`, `skipped`, `delivery_uncertain`,
 * `failed_retryable`, or `dead_letter`, recording `providerMessageIds` and verifying `claim_token`.
 */
export async function finalizeOutboxSendingOutcome(
  client: Queryable,
  params: FinalizeOutboxSendingOutcomeParams,
): Promise<OutboxStatus> {
  const { outboxId, claimToken, idempotencyKey, delivery } = params;
  const providerMessageIds = extractProviderMessageIds(delivery);

  if (delivery.ok) {
    const sentMeta = JSON.stringify({
      dispatchPhase: "sent" satisfies OutboxDurableDispatchPhase,
      ...(providerMessageIds.length > 0 ? { providerMessageIds } : {}),
    });
    let upd = await client.query(
      `update public.notification_outbox
          set status = 'sent',
              sent_at = now(),
              attempt_count = attempt_count + 1,
              last_error = null,
              claim_token = null,
              provider_message_ids = case when cardinality($4::text[]) > 0 then $4::text[] else provider_message_ids end,
              metadata = coalesce(metadata, '{}'::jsonb) || $3::jsonb,
              updated_at = now()
        where id = $1 and claim_token = $2::uuid`,
      [outboxId, claimToken, sentMeta, providerMessageIds],
    );
    if ((upd.rowCount ?? 0) === 0 && idempotencyKey) {
      upd = await client.query(
        `update public.notification_outbox
            set status = 'sent',
                sent_at = now(),
                attempt_count = attempt_count + 1,
                last_error = null,
                claim_token = null,
                provider_message_ids = case when cardinality($3::text[]) > 0 then $3::text[] else provider_message_ids end,
                metadata = coalesce(metadata, '{}'::jsonb) || $2::jsonb,
                updated_at = now()
          where idempotency_key = $1 and status = 'claiming' and claim_token is null`,
        [idempotencyKey, sentMeta, providerMessageIds],
      );
    }
    if ((upd.rowCount ?? 0) !== 1) {
      throw new Error(`Outbox sent güncellemesi claim_token doğrulamasını geçemedi (id=${outboxId}).`);
    }
    return "sent";
  }

  if (delivery.skippedUnconfigured) {
    const safeError = redactBotToken(delivery.error ?? "skipped_unconfigured");
    const skippedMeta = JSON.stringify({
      dispatchPhase: "skipped" satisfies OutboxDurableDispatchPhase,
    });
    let upd = await client.query(
      `update public.notification_outbox
          set status = 'skipped',
              attempt_count = attempt_count + 1,
              last_error = $3,
              claim_token = null,
              metadata = coalesce(metadata, '{}'::jsonb) || $4::jsonb,
              updated_at = now()
        where id = $1 and claim_token = $2::uuid`,
      [outboxId, claimToken, safeError, skippedMeta],
    );
    if ((upd.rowCount ?? 0) === 0 && idempotencyKey) {
      upd = await client.query(
        `update public.notification_outbox
            set status = 'skipped',
                attempt_count = attempt_count + 1,
                last_error = $2,
                claim_token = null,
                metadata = coalesce(metadata, '{}'::jsonb) || $3::jsonb,
                updated_at = now()
          where idempotency_key = $1 and status = 'claiming' and claim_token is null`,
        [idempotencyKey, safeError, skippedMeta],
      );
    }
    if ((upd.rowCount ?? 0) !== 1) {
      throw new Error(`Outbox skipped güncellemesi claim_token doğrulamasını geçemedi (id=${outboxId}).`);
    }
    return "skipped";
  }

  if (delivery.uncertainOutcome === true) {
    const safeError = redactBotToken(
      delivery.error ?? "delivery_uncertain: gönderim sonrası yanıt doğrulanamadı",
    );
    const uncertainMeta = JSON.stringify({
      dispatchPhase: "delivery_uncertain" satisfies OutboxDurableDispatchPhase,
      requiresOperatorReconciliation: true,
      ...(providerMessageIds.length > 0 ? { providerMessageIds } : {}),
    });
    let upd = await client.query(
      `update public.notification_outbox
          set status = 'delivery_uncertain',
              uncertain_at = coalesce(uncertain_at, now()),
              attempt_count = attempt_count + 1,
              last_error = $3,
              claim_token = null,
              provider_message_ids = case when cardinality($5::text[]) > 0 then $5::text[] else provider_message_ids end,
              metadata = coalesce(metadata, '{}'::jsonb) || $4::jsonb,
              updated_at = now()
        where id = $1 and claim_token = $2::uuid`,
      [outboxId, claimToken, safeError, uncertainMeta, providerMessageIds],
    );
    if ((upd.rowCount ?? 0) === 0 && idempotencyKey) {
      upd = await client.query(
        `update public.notification_outbox
            set status = 'delivery_uncertain',
                uncertain_at = coalesce(uncertain_at, now()),
                attempt_count = attempt_count + 1,
                last_error = $2,
                claim_token = null,
                provider_message_ids = case when cardinality($4::text[]) > 0 then $4::text[] else provider_message_ids end,
                metadata = coalesce(metadata, '{}'::jsonb) || $3::jsonb,
                updated_at = now()
          where idempotency_key = $1 and status = 'claiming' and claim_token is null`,
        [idempotencyKey, safeError, uncertainMeta, providerMessageIds],
      );
    }
    if ((upd.rowCount ?? 0) !== 1) {
      throw new Error(
        `Outbox delivery_uncertain güncellemesi claim_token doğrulamasını geçemedi (id=${outboxId}).`,
      );
    }
    return "delivery_uncertain";
  }

  let baseAttempt = params.attemptCount;
  let baseMaxAttempts = params.maxAttempts;
  if (baseAttempt === undefined || baseMaxAttempts === undefined) {
    try {
      const rowRes = await client.query<{ attempt_count: number; max_attempts: number }>(
        `select attempt_count, max_attempts
           from public.notification_outbox
          where id = $1`,
        [outboxId],
      );
      baseAttempt = baseAttempt ?? Number(rowRes.rows[0]?.attempt_count ?? 0);
      baseMaxAttempts = baseMaxAttempts ?? Number(rowRes.rows[0]?.max_attempts ?? 5);
    } catch {
      baseAttempt = baseAttempt ?? 0;
      baseMaxAttempts = baseMaxAttempts ?? 5;
    }
  }

  const nextAttempt = Number(baseAttempt) + 1;
  const maxAttempts = Math.max(1, Number(baseMaxAttempts));
  const nextStatus: OutboxStatus = nextAttempt >= maxAttempts ? "dead_letter" : "failed_retryable";
  const computedBackoff = computeRetryBackoffSeconds(nextAttempt);
  const backoffSec =
    typeof delivery.retryAfterSeconds === "number" &&
    Number.isFinite(delivery.retryAfterSeconds) &&
    delivery.retryAfterSeconds > 0
      ? Math.max(Math.ceil(delivery.retryAfterSeconds), computedBackoff)
      : computedBackoff;
  const safeError = redactBotToken(delivery.error ?? "bilinmeyen gönderim hatası");
  const retryMeta = JSON.stringify({
    dispatchPhase: nextStatus satisfies OutboxDurableDispatchPhase,
  });

  let upd = await client.query(
    `update public.notification_outbox
        set status = $3,
            attempt_count = $4,
            next_retry_at = now() + ($5::int * interval '1 second'),
            last_error = $6,
            claim_token = null,
            metadata = coalesce(metadata, '{}'::jsonb) || $7::jsonb,
            updated_at = now()
      where id = $1 and claim_token = $2::uuid`,
    [outboxId, claimToken, nextStatus, nextAttempt, backoffSec, safeError, retryMeta],
  );
  if ((upd.rowCount ?? 0) === 0 && idempotencyKey) {
    upd = await client.query(
      `update public.notification_outbox
          set status = $2,
              attempt_count = $3,
              last_error = $4,
              next_retry_at = now() + ($5::int * interval '1 second'),
              claim_token = null,
              metadata = coalesce(metadata, '{}'::jsonb) || $6::jsonb,
              updated_at = now()
        where idempotency_key = $1 and status = 'claiming' and claim_token is null`,
      [idempotencyKey, nextStatus, nextAttempt, safeError, backoffSec, retryMeta],
    );
  }
  if ((upd.rowCount ?? 0) !== 1) {
    throw new Error(`Outbox hata güncellemesi claim_token doğrulamasını geçemedi (id=${outboxId}).`);
  }
  return nextStatus;
}

export interface ClaimAndDispatchOutboxOptions {
  batchSize?: number;
  stream?: OutboxStream;
  channel?: NotificationChannel;
  transportResolver?: (channel: NotificationChannel) => Transport;
  staleClaimMinutes?: number;
  incidentStateFilePath?: string;
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

async function recordStaleSendingUncertainIncidentBestEffort(
  pool: Pool,
  uncertainCount: number,
  incidentStateFilePath?: string,
): Promise<void> {
  const signal = {
    signal: "outbox_delivery_uncertain",
    severity: "P1" as const,
    value: String(uncertainCount),
    note: "sending fazında yarım kalan bildirim delivery_uncertain durumuna alındı; operatör mutabakatı gerekli",
    threshold: "0 belirsiz bildirim",
  };

  if (incidentStateFilePath) {
    await evaluateAndRecordOpsIncidents(pool, [signal], {
      stateFilePath: incidentStateFilePath,
      deferNotifiedStamp: true,
    }).catch(() => undefined);
    return;
  }

  try {
    const nowISO = new Date().toISOString();
    const existing = await loadDbIncidentMap(pool);
    const prev = existing.get(signal.signal);
    const fingerprint = createHash("sha256")
      .update(`${signal.signal}|P1|OPEN|${signal.value}`, "utf8")
      .digest("hex")
      .slice(0, 16);
    const rec: OpsIncidentRecord = {
      signalKey: signal.signal,
      severity: "P1",
      state: "OPEN",
      lastValue: signal.value,
      stateFingerprint: fingerprint,
      note: signal.note,
      openedAt: prev?.openedAt ?? nowISO,
      acknowledgedAt: null,
      resolvedAt: null,
      suppressedUntil: null,
      suppressionReason: null,
      lastCheckedAt: nowISO,
      lastSuccessAt: nowISO,
      resolutionEvidence: null,
      correlationId: prev?.correlationId ?? null,
      lastNotifiedAt: prev?.lastNotifiedAt ?? null,
      lastNotifiedState: prev?.lastNotifiedState ?? null,
      occurrenceCount: (prev?.occurrenceCount ?? 0) + 1,
      updatedAt: nowISO,
    };
    await persistDbIncidentRecords(pool, [rec]);
  } catch {
    // Non-fatal on minimal unit-test mock pools that do not implement `public.ops_incidents`.
  }
}

/**
 * Atomically recovers stale claims (`recoverStaleOutboxClaims`), claims due outbox rows
 * (`FOR UPDATE SKIP LOCKED` + `claim_token = gen_random_uuid()` + `dispatchPhase = 'claimed'`),
 * commits durable `dispatchPhase = 'sending'` BEFORE `transport.send()`, and finalizes status
 * asserting `claim_token`.
 */
export async function claimAndDispatchOutbox(
  pool: Pool,
  opts: ClaimAndDispatchOutboxOptions = {},
): Promise<OutboxDispatchSummary> {
  const batchSize = Math.max(1, Math.min(100, Math.floor(opts.batchSize ?? 25)));
  const staleMinutes = Math.max(1, Math.floor(opts.staleClaimMinutes ?? 10));
  const resolveTransport = opts.transportResolver ?? transportFor;

  let claimedRows: ClaimedOutboxRow[] = [];
  let staleRecovery: StaleOutboxRecoverySummary = { uncertainCount: 0, preSendRetryableCount: 0 };

  const client = await pool.connect();
  try {
    await client.query("begin");
    staleRecovery = await recoverStaleOutboxClaims(client, staleMinutes);

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
              metadata = jsonb_set(coalesce(o.metadata, '{}'::jsonb), '{dispatchPhase}', '"claimed"', true),
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
  let uncertain = staleRecovery.uncertainCount;

  if (staleRecovery.uncertainCount > 0) {
    await recordStaleSendingUncertainIncidentBestEffort(
      pool,
      staleRecovery.uncertainCount,
      opts.incidentStateFilePath,
    );
  }

  for (const row of claimedRows) {
    // Persist durable `dispatchPhase = 'sending'` BEFORE invoking external transport (`F-09`).
    await markOutboxSendingStarted(pool, row.id, row.claim_token);

    const transport = resolveTransport(row.channel);
    let delivery: DeliveryResult;
    try {
      delivery = await transport.send(row.body_text, {
        ...(row.body_format === "html" && row.channel === "telegram" ? { parseMode: "HTML" as const } : {}),
        ...(row.subject ? { subject: row.subject } : {}),
      });
    } catch (err) {
      delivery = classifyThrownTransportError(err);
    }

    const finalStatus = await finalizeOutboxSendingOutcome(pool, {
      outboxId: row.id,
      claimToken: row.claim_token,
      idempotencyKey: row.idempotency_key,
      attemptCount: row.attempt_count,
      maxAttempts: row.max_attempts,
      delivery,
    });

    if (finalStatus === "sent") sent += 1;
    else if (finalStatus === "skipped") skipped += 1;
    else if (finalStatus === "delivery_uncertain") uncertain += 1;
    else if (finalStatus === "dead_letter") deadLettered += 1;
    else retried += 1;
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
  value: string | null | undefined;
  note?: string;
  threshold?: string;
  snapshotUnavailable?: boolean;
  unreadable?: boolean;
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
  /**
   * Optional per-signal explicit `IncidentResolutionEvidence`. If provided for a clearing signal
   * with `null` or invalid/incomplete fields, the `RESOLVED` transition is REJECTED (`RG-08` / `F-20`).
   */
  resolutionEvidenceBySignal?: Readonly<Record<string, Partial<IncidentResolutionEvidence> | null | undefined>>;
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

/**
 * Strictly validates structured `IncidentResolutionEvidence` (`F-20`, `RG-08`).
 * Requires non-empty `whatChanged`, `verifiedByCheck`, `verifiedAtISO` (valid ISO timestamp),
 * `measuredValue` (must NOT be unreadable `?`/`UNKNOWN`), and `evidenceSource`.
 */
export function isValidIncidentResolutionEvidence(
  raw: unknown,
): raw is IncidentResolutionEvidence {
  return parseResolutionEvidence(raw) !== null;
}

export function assertValidIncidentResolutionEvidence(
  raw: unknown,
  signalKey?: string,
): IncidentResolutionEvidence {
  const parsed = parseResolutionEvidence(raw);
  if (!parsed) {
    throw new Error(
      `Doğrulanmamış olay çözümü reddedildi${signalKey ? ` (${signalKey})` : ""}: ` +
        "eksiksiz ve geçerli IncidentResolutionEvidence (whatChanged, verifiedByCheck, verifiedAtISO, measuredValue, evidenceSource) zorunludur.",
    );
  }
  return parsed;
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
    typeof r.whatChanged !== "string" ||
    typeof r.verifiedByCheck !== "string" ||
    typeof r.verifiedAtISO !== "string" ||
    typeof r.measuredValue !== "string" ||
    typeof r.evidenceSource !== "string"
  ) {
    return null;
  }
  const whatChanged = r.whatChanged.trim();
  const verifiedByCheck = r.verifiedByCheck.trim();
  const verifiedAtISO = r.verifiedAtISO.trim();
  const measuredValue = r.measuredValue.trim();
  const evidenceSource = r.evidenceSource.trim();

  if (!whatChanged || !verifiedByCheck || !verifiedAtISO || !measuredValue || !evidenceSource) {
    return null;
  }
  if (!Number.isFinite(Date.parse(verifiedAtISO))) {
    return null;
  }
  if (isUnreadableTelemetryValue(measuredValue) || /^unknown$/i.test(measuredValue)) {
    return null;
  }
  return {
    whatChanged,
    verifiedByCheck,
    verifiedAtISO,
    measuredValue,
    evidenceSource,
  };
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

export interface ResolveOpsIncidentVerifiedParams {
  signalKey: string;
  evidence: unknown;
  now?: Date;
  stateFilePath?: string;
  correlationId?: string;
  deferNotifiedStamp?: boolean;
}

/**
 * Transitions an active operational incident (`OPEN`, `ACKNOWLEDGED`, `UNKNOWN`, or `SUPPRESSED`)
 * to `RESOLVED` ONLY when verified `IncidentResolutionEvidence` is supplied (`F-20`, `RG-08`).
 * Rejects unverified resolutions by throwing without mutating DB or local state.
 */
export async function resolveOpsIncidentVerified(
  poolOrNull: Pool | null | undefined,
  params: ResolveOpsIncidentVerifiedParams,
): Promise<{ record: OpsIncidentRecord; notification: OpsIncidentNotification }> {
  const verifiedEvidence = assertValidIncidentResolutionEvidence(params.evidence, params.signalKey);
  const now = params.now ?? new Date();
  const nowISO = now.toISOString();
  const nowMs = now.getTime();
  const stateFilePath = params.stateFilePath ?? DEFAULT_OPS_INCIDENT_STATE_PATH;
  const deferStamp = Boolean(params.deferNotifiedStamp);

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

  const prev = existingMap.get(params.signalKey);
  if (!prev) {
    throw new Error(`Çözümlenecek açık olay bulunamadı: ${params.signalKey}`);
  }

  const durationLabel = formatIncidentDurationTr(prev.openedAt, now);
  const durationMs =
    prev.openedAt && Number.isFinite(Date.parse(prev.openedAt))
      ? Math.max(0, nowMs - Date.parse(prev.openedAt))
      : null;
  const resolvedCorrelationId = params.correlationId ?? prev.correlationId ?? null;

  const resolvedRecord: OpsIncidentRecord = {
    ...prev,
    state: "RESOLVED",
    resolvedAt: nowISO,
    suppressedUntil: null,
    suppressionReason: null,
    lastCheckedAt: nowISO,
    lastSuccessAt: nowISO,
    resolutionEvidence: verifiedEvidence,
    correlationId: resolvedCorrelationId,
    lastNotifiedAt: !deferStamp ? nowISO : prev.lastNotifiedAt,
    lastNotifiedState: !deferStamp ? "RESOLVED" : prev.lastNotifiedState,
    updatedAt: nowISO,
  };
  existingMap.set(params.signalKey, resolvedRecord);

  if (poolOrNull && !usedFallbackFile) {
    try {
      await persistDbIncidentRecords(poolOrNull, [resolvedRecord]);
    } catch {
      usedFallbackFile = true;
    }
  }
  writeLocalIncidentMapSafe(stateFilePath, existingMap);

  const notification: OpsIncidentNotification = {
    signalKey: params.signalKey,
    severity: prev.severity,
    previousState: prev.state,
    nextState: "RESOLVED",
    value: verifiedEvidence.measuredValue,
    note: prev.note,
    openedAt: prev.openedAt,
    resolvedAt: nowISO,
    durationMs,
    durationLabel,
    resolutionEvidence: verifiedEvidence,
    correlationId: resolvedCorrelationId,
    formattedLine: `[RESOLVED][${prev.severity}] ${params.signalKey} normale döndü (süre: ${durationLabel} · doğrulama: ${verifiedEvidence.verifiedByCheck} -> ${verifiedEvidence.measuredValue})`,
  };

  return { record: resolvedRecord, notification };
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
 * - Query/probe/parse failure (`value === "?"` / `null` / empty / `BOZUK KOŞU KAYDI` / `snapshotUnavailable`): transitions to `UNKNOWN` (NEVER `RESOLVED` or `OK`) and emits `[UNKNOWN]`
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
      sig.unreadable === true ||
      sig.signal === "telemetry_snapshot_unavailable" ||
      isUnreadableTelemetryValue(sig.value);
    const normalizedValue =
      typeof sig.value === "string" && sig.value.trim() !== "" ? sig.value : "?";

    const fingerprint = createHash("sha256")
      .update(`${sig.signal}|${sig.severity}|${isUnknown ? "UNKNOWN" : "OPEN"}|${normalizedValue}`, "utf8")
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
          lastValue: normalizedValue,
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
        lastValue: normalizedValue,
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
          value: normalizedValue,
          note: noteText,
          openedAt,
          resolvedAt: null,
          durationMs: null,
          durationLabel: null,
          resolutionEvidence: null,
          correlationId: updated.correlationId ?? null,
          formattedLine: `[UNKNOWN][${sig.severity}] ${sig.signal} = ${normalizedValue}${detail}`,
        });
      }
      continue;
    }

    // Real firing alert (`!isUnknown`)
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
      lastValue: normalizedValue,
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
        value: normalizedValue,
        note: noteText,
        openedAt,
        resolvedAt: null,
        durationMs: null,
        durationLabel: null,
        resolutionEvidence: null,
        correlationId: updated.correlationId ?? null,
        formattedLine: `[OPEN][${sig.severity}] ${sig.signal} = ${normalizedValue}${detail}${escalationSuffix}`,
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

      const hasExplicitOverride =
        opts.resolutionEvidenceBySignal != null &&
        Object.prototype.hasOwnProperty.call(opts.resolutionEvidenceBySignal, key);

      const candidateEvidence = hasExplicitOverride
        ? opts.resolutionEvidenceBySignal![key]
        : ({
            whatChanged: `${key}: ${prev.lastValue} -> OK`,
            verifiedByCheck: `telemetry:${key}`,
            verifiedAtISO: nowISO,
            measuredValue: "OK",
            evidenceSource: opts.correlationId ? `telemetry:${opts.correlationId}` : "telemetry-snapshot",
          } satisfies IncidentResolutionEvidence);

      const resolutionEvidence = parseResolutionEvidence(candidateEvidence);
      if (!resolutionEvidence) {
        // Reject unverified resolution (`RG-08` / `F-20`) — keep active state intact.
        continue;
      }

      const durationLabel = formatIncidentDurationTr(prev.openedAt, now);
      const durationMs =
        prev.openedAt && Number.isFinite(Date.parse(prev.openedAt))
          ? Math.max(0, nowMs - Date.parse(prev.openedAt))
          : null;

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
          value: resolutionEvidence.measuredValue,
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
