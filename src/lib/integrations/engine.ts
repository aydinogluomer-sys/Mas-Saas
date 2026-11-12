// Faz 37 & Faz 40 (A2) — integration engine: schedule, run, record.

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
        credentialEnvVar: input.credentialEnvVar ?? null, credentialStored: false,
      },
    });
    await client.query("commit");
    return id;
  } catch (e) {
    await client.query("rollback"); throw e;
  } finally { client.release(); }
}

export async function enqueueSync(
  pool: Pool, connectionId: string, actorId: string | null, asOfISO = istanbulDateISO(),
): Promise<{ jobId: string; created: boolean } | null> {
  const res = await pool.query(
    `select id, integration_kind, status from public.integration_connections where id = $1`,
    [connectionId]);
  const row = res.rows[0];
  if (!row) return null;
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
    connectionId: connection.id, config: connection.config,
    credential: readCredential(connection.credentialEnvVar),
    http,
    asOfISO,
  };

  const auth = await connector.authenticate(ctx);
  if (!auth.ok) {
    await markFailure(pool, connectionId, auth.error ?? "Kimlik doğrulama başarısız", actorId);
    await failJob(pool, job.id, auth.error ?? "Kimlik doğrulama başarısız", actorId, auth.permanent ?? false);
    return { ok: false, imported: null, skipped: null, error: auth.error, permanent: auth.permanent };
  }

  // Faz 40 (A2): protect outer transactional callers with `SAVEPOINT connector_exec` so an
  // aborted SQL statement inside a connector never leaves the connection in 25P02 when recording
  // failure state and audit evidence.
  let savepointArmed = false;
  try {
    const txProbe = await pool.query<{ xid: string | null }>(
      `select pg_current_xact_id_if_assigned()::text as xid`,
    );
    if (txProbe.rows[0]?.xid != null) {
      await pool.query("SAVEPOINT connector_exec");
      savepointArmed = true;
    }
  } catch {
    savepointArmed = false;
  }

  let outcome: SyncOutcome;
  try {
    outcome = await connector.sync(ctx, pool, actorId);
    if (savepointArmed) {
      await pool.query("RELEASE SAVEPOINT connector_exec").catch(() => undefined);
    }
  } catch (e) {
    if (savepointArmed) {
      await pool.query("ROLLBACK TO SAVEPOINT connector_exec").catch(() => undefined);
      await pool.query("RELEASE SAVEPOINT connector_exec").catch(() => undefined);
    }
    outcome = {
      ok: false,
      imported: null,
      skipped: null,
      error: (e as Error).message || "Konnektör çalışma hatası",
    };
  }

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
        liveEndpointTested: false,
      },
    });
    await client.query("commit");
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw e;
  } finally { client.release(); }

  return outcome;
}

async function markSuccess(pool: Pool, connectionId: string): Promise<void> {
  await pool.query(
    `update public.integration_connections
        set last_sync_at = now(), last_success_at = now(), last_error = null
      where id = $1`, [connectionId]);
}

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
