// Faz 37, Faz 40 (A2) & Faz 51 (E1) — the integration contract, and the SINGLE network seam.

import { z } from "zod";

export const INTEGRATION_KINDS = ["bank_api", "einvoice", "fx_rate", "accounting"] as const;
export type IntegrationKind = (typeof INTEGRATION_KINDS)[number];

export const SYNC_JOB_TYPE: Record<IntegrationKind, string> = {
  bank_api: "bank_api_sync",
  einvoice: "einvoice_sync",
  fx_rate: "fx_rate_sync",
  accounting: "accounting_sync",
};

export const PARASUT_API_ORIGIN = "https://api.parasut.com" as const;

export const DEFAULT_ALLOWED_INTEGRATION_HOSTS = [
  "api.parasut.com",
  "www.tcmb.gov.tr",
] as const;

export function isBlockedIntegrationHost(hostname: string): boolean {
  const h = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!h) return true;
  if (
    h === "localhost" ||
    h === "0.0.0.0" ||
    h === "::1" ||
    h.endsWith(".localhost") ||
    h.endsWith(".local") ||
    h.endsWith(".internal")
  ) {
    return true;
  }
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) {
    return true;
  }
  const m172 = h.match(/^172\.(\d{1,3})\./);
  if (m172) {
    const second = Number(m172[1]);
    if (second >= 16 && second <= 31) return true;
  }
  if (/^(fc|fd|fe80):/i.test(h)) return true;
  return false;
}

export function allowedIntegrationHosts(): Set<string> {
  const extra = (process.env.MAS_ALLOWED_INTEGRATION_HOSTS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return new Set<string>([...DEFAULT_ALLOWED_INTEGRATION_HOSTS, ...extra]);
}

export function validateIntegrationEndpointUrl(
  rawUrl: string,
  options: { enforceAllowlist: boolean },
): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return "Geçersiz entegrasyon URL'i.";
  }
  if (parsed.protocol !== "https:") {
    return "Entegrasyon URL'i yalnız 'https://' protokolünü kullanabilir.";
  }
  if (parsed.username || parsed.password) {
    return "Entegrasyon URL'i kullanıcı adı veya parola içeremez.";
  }
  const host = parsed.hostname.toLowerCase();
  if (isBlockedIntegrationHost(host)) {
    return `Entegrasyon URL'i yerel/özel ağ adresine işaret edemez (${host}).`;
  }
  if (options.enforceAllowlist && !allowedIntegrationHosts().has(host)) {
    return `Entegrasyon alan adı beyaz listede değil (${host}).`;
  }
  return null;
}

export function isAllowedCredentialEnvVar(name: string): boolean {
  if (/^(MAS_INTEGRATION_|PARASUT_)[A-Z0-9_]+$/.test(name)) return true;
  if (process.env.NODE_ENV !== "production" && /^P37_[A-Z0-9_]+$/.test(name)) return true;
  return false;
}

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
  headers?: Record<string, string>;
  error?: string;
}

export interface HttpClient {
  send(request: HttpRequest): Promise<HttpResponse>;
}

const DEFAULT_INTEGRATION_TIMEOUT_MS = 15_000;

export function realHttpClient(): HttpClient {
  return {
    async send(request: HttpRequest): Promise<HttpResponse> {
      const urlErr = validateIntegrationEndpointUrl(request.url, { enforceAllowlist: true });
      if (urlErr) {
        return { ok: false, status: 0, body: "", headers: {}, error: urlErr };
      }
      const timeoutMs = Math.min(30_000, Math.max(500, request.timeoutMs ?? DEFAULT_INTEGRATION_TIMEOUT_MS));
      try {
        const res = await fetch(request.url, {
          method: request.method ?? "GET",
          headers: request.headers,
          body: request.body,
          signal: AbortSignal.timeout(timeoutMs),
        });
        const headers: Record<string, string> = {};
        res.headers.forEach((value, key) => {
          headers[key.toLowerCase()] = value;
        });
        const body = await res.text();
        return { ok: res.ok, status: res.status, body, headers };
      } catch (e) {
        return { ok: false, status: 0, body: "", headers: {}, error: (e as Error).message };
      }
    },
  };
}

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
        ?? { ok: false, status: 404, body: "", headers: {}, error: "mock: tanımsız URL" };
    },
  };
}

/* ── the connector contract ─────────────────────────────────────────────────────────────── */

export interface SyncOutcome {
  ok: boolean;
  imported: number | null;
  skipped: number | null;
  stagedParties?: number;
  syncRunId?: string;
  error?: string;
  permanent?: boolean;
}

export interface ConnectorContext {
  connectionId?: string;
  config: Record<string, unknown>;
  credential: string | null;
  http: HttpClient;
  asOfISO: string;
}

export interface IntegrationConnector {
  kind: IntegrationKind;
  provider: string;
  authenticate(ctx: ConnectorContext): Promise<{ ok: boolean; error?: string; permanent?: boolean }>;
  sync(ctx: ConnectorContext, pool: import("pg").Pool, actorId: string | null): Promise<SyncOutcome>;
}

/* ── boundary validation ────────────────────────────────────────────────────────────────── */

export const connectionConfigSchema = z.object({
  baseUrl: z
    .string()
    .url()
    .refine(
      (u) => validateIntegrationEndpointUrl(u, { enforceAllowlist: false }) === null,
      "baseUrl yalnız harici 'https://' adresi olabilir (loopback/RFC1918/metadata engelli).",
    )
    .optional(),
  companyId: z.string().trim().regex(/^\d+$/).optional(),
  accountIds: z.array(z.string().trim().min(1)).max(50).optional(),
  currencies: z.array(z.string().regex(/^[A-Z]{3}$/)).max(20).optional(),
  sinceDays: z.number().int().min(1).max(365).optional(),
}).passthrough();

export const createConnectionSchema = z.object({
  integrationKind: z.enum(INTEGRATION_KINDS),
  name: z.string().trim().min(1).max(120),
  provider: z.string().trim().min(1).max(80).optional(),
  credentialEnvVar: z
    .string()
    .refine(
      isAllowedCredentialEnvVar,
      "credentialEnvVar yalnız MAS_INTEGRATION_* veya PARASUT_* önekli olabilir.",
    )
    .optional(),
  config: connectionConfigSchema.default({}),
  syncIntervalMinutes: z.number().int().min(5).max(10_080).nullable().default(null),
});
export type CreateConnectionInput = z.infer<typeof createConnectionSchema>;

export function readCredential(envVarName: string | null): string | null {
  if (!envVarName || !isAllowedCredentialEnvVar(envVarName)) return null;
  const value = process.env[envVarName];
  return value && value.length > 0 ? value : null;
}
