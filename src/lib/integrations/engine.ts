// Faz 37 — integration engine: schedule, run, record.
//
// Scheduling is Faz 33's `background_jobs` queue, used as-is. This module enqueues and completes
// jobs through that engine's own functions — it does not write job rows itself, does not
// implement retry, and does not own a dead-letter concept. All three already exist and work.

import type { Pool } from "pg";
import { audit } from "@/lib/audit";
import { istanbulDateISO } from "@/lib/reports/rules";
import { completeJob, enqueueJob, failJob } from "@/lib/jobs/queue";
import { connectorFor } from "./connectors";
import {
  SYNC_JOB_TYPE, createConnectionSchema, readCredential,
  type HttpClient, type IntegrationKind, type SyncOutcome,
} from "./types";

export interface ConnectionRow {
  id: string;
  integrationKind: IntegrationKind;
  name: string;
  provider: string | null;
  status: string;
  credentialEnvVar: string | null;
  config: Record<string, unknown>;
  syncIntervalMinutes: number | null;
  lastSyncAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  isOverdue: boolean;
  minutesSinceSuccess: number | null;
  deadLetterCount: number;
}

const mapRow = (x: Record<string, unknown>): ConnectionRow => ({
  id: x.id as string,
  integrationKind: x.integration_kind as IntegrationKind,
  name: x.name as string,
  provider: (x.provider as string | null) ?? null,
  status: x.status as string,
  credentialEnvVar: (x.credential_env_var as string | null) ?? null,
  config: (x.config ?? {}) as Record<string, unknown>,
  syncIntervalMinutes: x.sync_interval_minutes == null ? null : Number(x.sync_interval_minutes),
  lastSyncAt: (x.last_sync_at as string | null) ?? null,
  lastSuccessAt: (x.last_success_at as string | null) ?? null,
  lastError: (x.last_error as string | null) ?? null,
  isOverdue: Boolean(x.is_overdue),
  // Null, not 0: "never synced successfully" is not "synced 0 minutes ago".
  minutesSinceSuccess: x.minutes_since_success == null ? null : Number(x.minutes_since_success),
  deadLetterCount: Number(x.dead_letter_count ?? 0),
});

export async function listConnections(pool: Pool): Promise<ConnectionRow[]> {
  const res = await pool.query(
    `select h.*, c.credential_env_var, c.config
       from public.integration_health h
       join public.integration_connections c on c.id = h.id
      order by h.integration_kind, h.name`);
  return res.rows.map(mapRow);
}

export async function createConnection(
  pool: Pool, raw: unknown, actorId: string | null,
): Promise<string> {
  const input = createConnectionSchema.parse(raw);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const res = await client.query(
      `insert into public.integration_connections
         (integration_kind, name, provider, credential_env_var, config,
          sync_interval_minutes, created_by)
       values ($1,$2,$3,$4,$5::jsonb,$6,$7) returning id`,
      [input.integrationKind, input.name, input.provider ?? null,
       input.credentialEnvVar ?? null, JSON.stringify(input.config),
       input.syncIntervalMinutes, actorId]);
    const id = res.rows[0].id as string;
    await audit(client, {
      actor: actorId, action: "create_integration_connection",
      entityTable: "integration_connections", entityId: id,
      after: {
        integrationKind: input.integrationKind, name: input.name,
        provider: input.provider ?? null,
        // Recorded explicitly so an audit reader can see the credential itself was never stored.
        credentialEnvVar: input.credentialEnvVar ?? null, credentialStored: false,
      },
    });
    await client.query("commit");
    return id;
  } catch (e) {
    await client.query("rollback"); throw e;
  } finally { client.release(); }
}

/**
 * Enqueue a sync for one connection.
 *
 * The dedupe key is the connection id plus the business date, so a scheduler that fires twice —
 * or an operator clicking "sync now" while one is already queued — produces ONE job. Faz 33's
 * partial unique index on live jobs does the work; nothing here re-implements it.
 */
export async function enqueueSync(
  pool: Pool, connectionId: string, actorId: string | null, asOfISO = istanbulDateISO(),
): Promise<{ jobId: string; created: boolean } | null> {
  const res = await pool.query(
    `select id, integration_kind, status from public.integration_connections where id = $1`,
    [connectionId]);
  const row = res.rows[0];
  if (!row) return null;
  // Only an enabled connection may be scheduled. A disabled or revoked one silently queuing work
  // is how a withdrawn credential keeps getting used.
  if (row.status !== "enabled") return null;

  const kind = row.integration_kind as IntegrationKind;
  const { job, created } = await enqueueJob(pool, {
    jobType: SYNC_JOB_TYPE[kind],
    payload: { connectionId, asOfISO, integrationKind: kind },
    dedupeKey: `sync:${connectionId}:${asOfISO}`,
    priority: 50,
  }, actorId);
  return { jobId: job.id, created };
}

/** Every enabled connection whose schedule has elapsed. */
export async function enqueueDueSyncs(
  pool: Pool, actorId: string | null, asOfISO = istanbulDateISO(),
): Promise<{ enqueued: number; skipped: number }> {
  const due = await pool.query(
    `select id from public.integration_health
      where status = 'enabled' and is_overdue`);
  let enqueued = 0, skipped = 0;
  for (const row of due.rows) {
    const result = await enqueueSync(pool, row.id as string, actorId, asOfISO);
    if (result?.created) enqueued++; else skipped++;
  }
  return { enqueued, skipped };
}

/**
 * Run one claimed sync job.
 *
 * `http` is injected. This function has no way to reach the network on its own, which is what
 * lets the gate run the whole path with a mock and be certain nothing left the machine.
 */
export async function runSyncJob(
  pool: Pool,
  job: { id: string; payload: Record<string, unknown> },
  http: HttpClient,
  actorId: string | null,
): Promise<SyncOutcome> {
  const connectionId = String(job.payload.connectionId ?? "");
  const asOfISO = String(job.payload.asOfISO ?? istanbulDateISO());
  const res = await pool.query(
    `select * from public.integration_connections where id = $1`, [connectionId]);
  const row = res.rows[0];
  if (!row) {
    const outcome: SyncOutcome = {
      ok: false, imported: null, skipped: null,
      error: "Bağlantı bulunamadı", permanent: true,
    };
    await failJob(pool, job.id, outcome.error as string, actorId, true);
    return outcome;
  }

  const connection = mapRow({ ...row, is_overdue: false, minutes_since_success: null, dead_letter_count: 0 });
  const connector = connectorFor(connection.integrationKind, connection.provider ?? undefined);
  if (!connector) {
    await failJob(pool, job.id, "Bilinmeyen entegrasyon türü", actorId, true);
    return { ok: false, imported: null, skipped: null, error: "Bilinmeyen entegrasyon türü", permanent: true };
  }

  const ctx = {
    config: connection.config,
    credential: readCredential(connection.credentialEnvVar),
    http,
    asOfISO,
  };

  // Authenticate first. A bad credential is permanent, and separating it stops the queue retrying
  // a wrong password five times behind every other job.
  const auth = await connector.authenticate(ctx);
  if (!auth.ok) {
    await markFailure(pool, connectionId, auth.error ?? "Kimlik doğrulama başarısız", actorId);
    await failJob(pool, job.id, auth.error ?? "Kimlik doğrulama başarısız", actorId, auth.permanent ?? false);
    return { ok: false, imported: null, skipped: null, error: auth.error, permanent: auth.permanent };
  }

  const outcome = await connector.sync(ctx, pool, actorId);
  if (outcome.ok) {
    await markSuccess(pool, connectionId);
    await completeJob(pool, job.id, actorId);
  } else {
    await markFailure(pool, connectionId, outcome.error ?? "Senkron başarısız", actorId);
    await failJob(pool, job.id, outcome.error ?? "Senkron başarısız", actorId, outcome.permanent ?? false);
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    await audit(client, {
      actor: actorId, action: "integration_sync",
      entityTable: "integration_connections", entityId: connectionId,
      after: {
        integrationKind: connection.integrationKind, provider: connector.provider,
        ok: outcome.ok, imported: outcome.imported, skipped: outcome.skipped,
        error: outcome.error ?? null, asOfISO,
        // The honest label: nothing in this phase has been exercised against a live endpoint.
        liveEndpointTested: false,
      },
    });
    await client.query("commit");
  } finally { client.release(); }

  return outcome;
}

async function markSuccess(pool: Pool, connectionId: string): Promise<void> {
  await pool.query(
    `update public.integration_connections
        set last_sync_at = now(), last_success_at = now(), last_error = null
      where id = $1`, [connectionId]);
}

/**
 * Record a failure, and move the connection to 'error' only from a state the guard allows.
 *
 * `status = 'enabled'` in the WHERE is not defensive noise: 0086's transition guard refuses
 * `disabled -> error`, and an unconditional update would raise inside a sync and turn a reported
 * failure into an unhandled one.
 */
async function markFailure(
  pool: Pool, connectionId: string, message: string, actorId: string | null,
): Promise<void> {
  await pool.query(
    `update public.integration_connections
        set last_sync_at = now(), last_error = $2,
            status = case when status = 'enabled' then 'error' else status end
      where id = $1`, [connectionId, message.slice(0, 2000)]);
  void actorId;
}
