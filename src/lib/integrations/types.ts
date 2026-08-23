// Faz 37 — the integration contract, and the SINGLE network seam.
//
// ═══ THIS ENVIRONMENT HAS NO OUTBOUND NETWORK, AND NOTHING HERE PRETENDS OTHERWISE ═══
//
// src/lib/reminders/transport.ts established the pattern in Faz 6: write the REAL client logic,
// put it behind an interface, and drive the interface with a mock in tests and gates. The real
// implementation is genuine code that will work on a deployment with network access; in THIS
// environment it can only ever be exercised through the mock, and its failure path is the branch
// that actually runs.
//
// Every outbound call in this subtree goes through `HttpClient`. That is not decoration — it is
// what lets phase37:verify assert, structurally, that no integration can reach the network on its
// own, and it is why the gate can run with no risk of firing a real request at a bank.
//
// NOTHING IN THIS PHASE HAS BEEN TESTED AGAINST A LIVE ENDPOINT. Any claim otherwise would be
// false, and the commit message says so in as many words.

import { z } from "zod";

export const INTEGRATION_KINDS = ["bank_api", "einvoice", "fx_rate", "accounting"] as const;
export type IntegrationKind = (typeof INTEGRATION_KINDS)[number];

/** Job types this phase adds to Faz 33's queue — one per integration, no second queue. */
export const SYNC_JOB_TYPE: Record<IntegrationKind, string> = {
  bank_api: "bank_api_sync",
  einvoice: "einvoice_sync",
  fx_rate: "fx_rate_sync",
  accounting: "accounting_sync",
};

/* ── the network seam ───────────────────────────────────────────────────────────────────── */

export interface HttpRequest {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export interface HttpResponse {
  ok: boolean;
  status: number;
  body: string;
  /** Populated instead of throwing when the request could not be made at all. */
  error?: string;
}

export interface HttpClient {
  send(request: HttpRequest): Promise<HttpResponse>;
}

/**
 * The real client. Genuine fetch logic — timeout, status handling, no thrown exceptions.
 *
 * It is never constructed by the gate or by tests. On this machine every call it makes fails with
 * a DNS or connect error, which `send` reports as a result rather than an exception, because a
 * failed integration must degrade to "sync did not run" and never crash the request that
 * triggered it.
 */
export function realHttpClient(): HttpClient {
  return {
    async send(request: HttpRequest): Promise<HttpResponse> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? 20_000);
      try {
        const res = await fetch(request.url, {
          method: request.method ?? "GET",
          headers: request.headers,
          body: request.body,
          signal: controller.signal,
        });
        const body = await res.text();
        return { ok: res.ok, status: res.status, body };
      } catch (e) {
        // Includes the abort. Never rethrown: see above.
        return { ok: false, status: 0, body: "", error: (e as Error).message };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Deterministic client for tests and the gate.
 *
 * Records every request it was asked to make, so a test can assert on the URL, headers and body
 * an integration WOULD have sent — which is the only honest way to verify request construction
 * from an environment that cannot send it.
 */
export function mockHttpClient(
  responses: Record<string, HttpResponse> | ((req: HttpRequest) => HttpResponse),
): HttpClient & { requests: HttpRequest[] } {
  const requests: HttpRequest[] = [];
  return {
    requests,
    async send(request: HttpRequest): Promise<HttpResponse> {
      requests.push(request);
      if (typeof responses === "function") return responses(request);
      return responses[request.url]
        ?? { ok: false, status: 404, body: "", error: "mock: tanımsız URL" };
    },
  };
}

/* ── the connector contract ─────────────────────────────────────────────────────────────── */

export interface SyncOutcome {
  ok: boolean;
  /** Records created. Never a guess — a connector that cannot count reports null. */
  imported: number | null;
  /** Records the source offered that were already present. */
  skipped: number | null;
  error?: string;
  /**
   * True when retrying cannot help (bad credentials, malformed contract).
   *
   * Passed to Faz 33's failJob(permanent) so the queue dead-letters immediately instead of
   * burning five attempts on something that will fail identically each time.
   */
  permanent?: boolean;
}

export interface ConnectorContext {
  /** Non-secret configuration from integration_connections.config. */
  config: Record<string, unknown>;
  /**
   * The credential, already read from the environment by the caller.
   *
   * Passed in rather than read here so a connector never touches process.env — which is what
   * makes it testable, and what stops a token being logged by a connector that "just" wanted to
   * debug its own configuration.
   */
  credential: string | null;
  http: HttpClient;
  /** Business date the sync is for. */
  asOfISO: string;
}

/**
 * What every integration implements.
 *
 * `authenticate` is separate from `sync` because the failures are different: bad credentials are
 * permanent and must dead-letter immediately, while a sync failure is usually transient. Folding
 * them together would make the queue retry a wrong password five times.
 */
export interface IntegrationConnector {
  kind: IntegrationKind;
  /** Vendor/provider label, purely descriptive. */
  provider: string;
  /** Verify the credential without pulling data. */
  authenticate(ctx: ConnectorContext): Promise<{ ok: boolean; error?: string; permanent?: boolean }>;
  /** Pull data and write it through the owning phase's existing engine. */
  sync(ctx: ConnectorContext, pool: import("pg").Pool, actorId: string | null): Promise<SyncOutcome>;
}

/* ── boundary validation ────────────────────────────────────────────────────────────────── */

export const connectionConfigSchema = z.object({
  baseUrl: z.string().url().optional(),
  accountIds: z.array(z.string().trim().min(1)).max(50).optional(),
  currencies: z.array(z.string().regex(/^[A-Z]{3}$/)).max(20).optional(),
  sinceDays: z.number().int().min(1).max(365).optional(),
}).passthrough();

export const createConnectionSchema = z.object({
  integrationKind: z.enum(INTEGRATION_KINDS),
  name: z.string().trim().min(1).max(120),
  provider: z.string().trim().min(1).max(80).optional(),
  credentialEnvVar: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
  config: connectionConfigSchema.default({}),
  syncIntervalMinutes: z.number().int().min(5).max(10_080).nullable().default(null),
});
export type CreateConnectionInput = z.infer<typeof createConnectionSchema>;

/**
 * Read a credential by the NAME stored on the connection.
 *
 * The database holds the variable's name; the value never leaves the process environment. Returns
 * null rather than throwing when unset, so a misconfigured connection degrades to a clean
 * "authentication failed" instead of a crash — and the value is never included in any error text.
 */
export function readCredential(envVarName: string | null): string | null {
  if (!envVarName) return null;
  const value = process.env[envVarName];
  return value && value.length > 0 ? value : null;
}
