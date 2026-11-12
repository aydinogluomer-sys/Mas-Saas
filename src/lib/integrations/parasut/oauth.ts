// Faz 51 (E1) — Paraşüt OAuth 2.0 (https://api.parasut.com/oauth/token) password & refresh_token manager.
//
// Invariants:
//   * Reads PARASUT_* credentials ONLY via readCredential() seam in ../types.ts (zero direct process.env).
//   * Reaches the network ONLY via ctx.http.send() (zero direct fetch()).
//   * 7200s TTL with 120s safety margin + in-memory single-flight refresh mutex per credential fingerprint.
//   * Zero secret logging to console, audit_logs, or DB tables.

import { createHash } from "node:crypto";
import {
  PARASUT_API_ORIGIN,
  readCredential,
  type ConnectorContext,
  type HttpClient,
} from "../types";

export const PARASUT_OAUTH_URL = `${PARASUT_API_ORIGIN}/oauth/token` as const;
const DEFAULT_TOKEN_TTL_SECONDS = 7200;
const EXPIRY_SAFETY_MARGIN_MS = 120_000;

export interface ParasutCredentials {
  companyId: string;
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
}

export interface ParasutTokenState {
  accessToken: string;
  refreshToken: string | null;
  expiresAtMs: number;
}

interface CacheSlot {
  state: ParasutTokenState | null;
  inflight: Promise<{ ok: boolean; accessToken?: string; error?: string; permanent?: boolean }> | null;
}

const tokenCache = new Map<string, CacheSlot>();

export function clearParasutTokenCache(): void {
  tokenCache.clear();
}

/**
 * Resolves Paraşüt credentials from `readCredential("PARASUT_*")` or a JSON string stored in the
 * connection's configured `credential_env_var`. Never reads `process.env` directly.
 */
export function resolveParasutCredentials(ctx: ConnectorContext): {
  ok: true;
  credentials: ParasutCredentials;
} | {
  ok: false;
  error: string;
  permanent: true;
} {
  let parsedJson: Partial<ParasutCredentials> = {};
  if (ctx.credential && ctx.credential.trim().startsWith("{")) {
    try {
      const obj = JSON.parse(ctx.credential) as Record<string, unknown>;
      parsedJson = {
        companyId: typeof obj.companyId === "string" ? obj.companyId.trim() : undefined,
        clientId: typeof obj.clientId === "string" ? obj.clientId.trim() : undefined,
        clientSecret: typeof obj.clientSecret === "string" ? obj.clientSecret.trim() : undefined,
        username: typeof obj.username === "string" ? obj.username.trim() : undefined,
        password: typeof obj.password === "string" ? obj.password : undefined,
      };
    } catch {
      return {
        ok: false,
        error: "Paraşüt kimlik bilgisi JSON biçimi geçersiz.",
        permanent: true,
      };
    }
  }

  const cfgCompanyId =
    typeof ctx.config.companyId === "string" && ctx.config.companyId.trim()
      ? ctx.config.companyId.trim()
      : undefined;

  const companyId = parsedJson.companyId ?? cfgCompanyId ?? readCredential("PARASUT_COMPANY_ID") ?? "";
  const clientId = parsedJson.clientId ?? readCredential("PARASUT_CLIENT_ID") ?? "";
  const clientSecret = parsedJson.clientSecret ?? readCredential("PARASUT_CLIENT_SECRET") ?? "";
  const username = parsedJson.username ?? readCredential("PARASUT_USERNAME") ?? "";
  const password = parsedJson.password ?? readCredential("PARASUT_PASSWORD") ?? (
    ctx.credential && !ctx.credential.trim().startsWith("{") ? ctx.credential : ""
  );

  if (!companyId || !/^\d+$/.test(companyId)) {
    return {
      ok: false,
      error: "PARASUT_COMPANY_ID eksik veya sayısal firma kimliği değil.",
      permanent: true,
    };
  }
  if (!clientId || !clientSecret || !username || !password) {
    return {
      ok: false,
      error: "Paraşüt OAuth 2.0 kimlik bilgileri eksik (PARASUT_CLIENT_ID, PARASUT_CLIENT_SECRET, PARASUT_USERNAME, PARASUT_PASSWORD).",
      permanent: true,
    };
  }

  return {
    ok: true,
    credentials: { companyId, clientId, clientSecret, username, password },
  };
}

function cacheKeyFor(creds: ParasutCredentials): string {
  return createHash("sha256")
    .update(`${creds.companyId}|${creds.clientId}|${creds.username}|${creds.password}`)
    .digest("hex");
}

async function requestOAuthToken(
  http: HttpClient,
  params: Record<string, string>,
): Promise<{ ok: boolean; state?: ParasutTokenState; error?: string; permanent?: boolean }> {
  const body = new URLSearchParams(params).toString();
  const res = await http.send({
    url: PARASUT_OAUTH_URL,
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body,
  });

  if (!res.ok) {
    const permanent = res.status === 400 || res.status === 401 || res.status === 403;
    return {
      ok: false,
      error: `Paraşüt OAuth hatası (${res.status || "ağ"})${res.error ? `: ${res.error}` : ""}`,
      permanent,
    };
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(res.body) as Record<string, unknown>;
  } catch {
    return { ok: false, error: "Paraşüt OAuth yanıtı geçerli JSON değil.", permanent: true };
  }

  const accessToken = typeof data.access_token === "string" ? data.access_token.trim() : "";
  if (!accessToken) {
    return { ok: false, error: "Paraşüt OAuth yanıtında access_token bulunamadı.", permanent: true };
  }
  const refreshToken = typeof data.refresh_token === "string" ? data.refresh_token.trim() : null;
  const expiresInSec =
    typeof data.expires_in === "number" && Number.isFinite(data.expires_in) && data.expires_in > 0
      ? data.expires_in
      : DEFAULT_TOKEN_TTL_SECONDS;

  return {
    ok: true,
    state: {
      accessToken,
      refreshToken,
      expiresAtMs: Date.now() + expiresInSec * 1000,
    },
  };
}

/**
 * Acquires a valid Paraşüt OAuth 2.0 access token, refreshing with `refresh_token` if available
 * or falling back to `password` grant under a single-flight per-account lock.
 */
export async function acquireParasutAccessToken(
  ctx: ConnectorContext,
  options: { forceRefresh?: boolean; nowMs?: number } = {},
): Promise<{ ok: boolean; accessToken?: string; companyId?: string; error?: string; permanent?: boolean }> {
  const resolved = resolveParasutCredentials(ctx);
  if (!resolved.ok) return resolved;

  const { credentials } = resolved;
  const key = cacheKeyFor(credentials);
  const now = options.nowMs ?? Date.now();

  let slot = tokenCache.get(key);
  if (!slot) {
    slot = { state: null, inflight: null };
    tokenCache.set(key, slot);
  }

  if (
    !options.forceRefresh &&
    slot.state &&
    slot.state.expiresAtMs - EXPIRY_SAFETY_MARGIN_MS > now
  ) {
    return {
      ok: true,
      accessToken: slot.state.accessToken,
      companyId: credentials.companyId,
    };
  }

  if (slot.inflight) {
    const shared = await slot.inflight;
    return { ...shared, companyId: credentials.companyId };
  }

  const refreshCandidate = slot.state?.refreshToken ?? null;
  slot.inflight = (async () => {
    try {
      if (refreshCandidate) {
        const refreshed = await requestOAuthToken(ctx.http, {
          grant_type: "refresh_token",
          client_id: credentials.clientId,
          client_secret: credentials.clientSecret,
          refresh_token: refreshCandidate,
        });
        if (refreshed.ok && refreshed.state) {
          slot!.state = refreshed.state;
          return { ok: true, accessToken: refreshed.state.accessToken };
        }
      }

      const fresh = await requestOAuthToken(ctx.http, {
        grant_type: "password",
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        username: credentials.username,
        password: credentials.password,
        redirect_uri: "urn:ietf:wg:oauth:2.0:oob",
      });
      if (!fresh.ok || !fresh.state) {
        slot!.state = null;
        return {
          ok: false,
          error: fresh.error ?? "Paraşüt OAuth jetonu alınamadı.",
          permanent: fresh.permanent,
        };
      }
      slot!.state = fresh.state;
      return { ok: true, accessToken: fresh.state.accessToken };
    } finally {
      slot!.inflight = null;
    }
  })();

  const outcome = await slot.inflight;
  return { ...outcome, companyId: credentials.companyId };
}

