// Faz 51 (E1) — Paraşüt JSON:API v4 Read-Only Client.
//
// Invariants:
//   * Targets ONLY https://api.parasut.com/v4/{company_id}/...
//   * Compile-time AND runtime guard: ONLY the HTTP GET method is permitted on /v4/ endpoints.
//     Any non-GET attempt throws immediately before touching the network seam.
//   * Supports JSON:API pagination (page[number], page[size]=25), sort=-updated_at, compound
//     document `included` index resolution, and watermark - 24h overlap window.

import { createHash } from "node:crypto";
import { PARASUT_API_ORIGIN, type HttpClient } from "../types";
import { ParasutRateLimiter } from "./rate-limiter";

export type ParasutReadOnlyMethod = "GET";

export type ParasutResourceName =
  | "contacts"
  | "accounts"
  | "transactions"
  | "sales_invoices"
  | "purchase_bills"
  | "bank_fees"
  | "taxes"
  | "salaries";

export interface JsonApiResourceObject {
  id: string;
  type: string;
  attributes: Record<string, unknown>;
  relationships?: Record<
    string,
    {
      data?: { id: string; type: string } | Array<{ id: string; type: string }> | null;
    }
  >;
}

export interface JsonApiPagePayload {
  data: JsonApiResourceObject[];
  included?: JsonApiResourceObject[];
  meta?: {
    current_page?: number;
    total_pages?: number;
    total_count?: number;
  };
}

export interface ParasutFetchedRecord {
  resource: ParasutResourceName;
  item: JsonApiResourceObject;
  includedIndex: Map<string, JsonApiResourceObject>;
  rawJson: Record<string, unknown>;
  payloadSha256: string;
  externalUpdatedAt: string | null;
}

export function assertParasutV4GetOnly(url: string, method: ParasutReadOnlyMethod = "GET"): void {
  if (method !== "GET") {
    throw new Error(`Paraşüt v4 güvenlik ihlali: yalnız GET metoduna izin verilir (istenen: ${String(method)}).`);
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Paraşüt v4 geçersiz URL: ${url}`);
  }
  if (parsed.origin !== PARASUT_API_ORIGIN) {
    throw new Error(`Paraşüt v4 yalnız ${PARASUT_API_ORIGIN} adresine bağlanabilir (reddedilen: ${parsed.origin}).`);
  }
  if (!/^\/v4\/\d+\//.test(parsed.pathname)) {
    throw new Error(`Paraşüt v4 yolu /v4/{company_id}/... biçiminde olmalıdır (${parsed.pathname}).`);
  }
}

/**
 * Computes the incremental sync overlap window (`watermark - 24 hours`) so late-indexed
 * Paraşüt documents are never missed across sync boundaries.
 */
export function computeWatermarkOverlapFrom(
  lastWatermarkISO: string | null | undefined,
  fallbackAsOfISO: string,
  sinceDays = 30,
): string {
  if (lastWatermarkISO) {
    const parsedMs = Date.parse(lastWatermarkISO);
    if (Number.isFinite(parsedMs)) {
      return new Date(parsedMs - 24 * 3600 * 1000).toISOString();
    }
  }
  const baseMs = Date.parse(`${fallbackAsOfISO.slice(0, 10)}T00:00:00Z`);
  const safeBase = Number.isFinite(baseMs) ? baseMs : Date.now();
  return new Date(safeBase - sinceDays * 86_400_000).toISOString();
}

export function buildIncludedIndex(included: JsonApiResourceObject[] | undefined): Map<string, JsonApiResourceObject> {
  const map = new Map<string, JsonApiResourceObject>();
  if (!Array.isArray(included)) return map;
  for (const inc of included) {
    if (inc && typeof inc.type === "string" && typeof inc.id === "string") {
      map.set(`${inc.type}:${inc.id}`, inc);
    }
  }
  return map;
}

export function resolveIncludedRelation(
  item: JsonApiResourceObject,
  relationName: string,
  includedIndex: Map<string, JsonApiResourceObject>,
): JsonApiResourceObject | null {
  const rel = item.relationships?.[relationName]?.data;
  if (!rel || Array.isArray(rel)) return null;
  if (typeof rel.type !== "string" || typeof rel.id !== "string") return null;
  return includedIndex.get(`${rel.type}:${rel.id}`) ?? null;
}

export function resolveIncludedRelationList(
  item: JsonApiResourceObject,
  relationName: string,
  includedIndex: Map<string, JsonApiResourceObject>,
): JsonApiResourceObject[] {
  const rel = item.relationships?.[relationName]?.data;
  if (!Array.isArray(rel)) return [];
  const out: JsonApiResourceObject[] = [];
  for (const ref of rel) {
    if (ref && typeof ref.type === "string" && typeof ref.id === "string") {
      const found = includedIndex.get(`${ref.type}:${ref.id}`);
      if (found) out.push(found);
    }
  }
  return out;
}

export function canonicalPayloadSha256(raw: unknown): string {
  return createHash("sha256").update(JSON.stringify(raw)).digest("hex");
}

export interface FetchCollectionOptions {
  http: HttpClient;
  limiter: ParasutRateLimiter;
  companyId: string;
  accessToken: string;
  resource: ParasutResourceName;
  pathSuffix?: string;
  include?: string[];
  filters?: Record<string, string>;
  pageSize?: number;
  maxPages?: number;
  watermarkFromISO?: string | null;
}

export async function fetchParasutResourcePages(
  opts: FetchCollectionOptions,
): Promise<{ ok: boolean; records: ParasutFetchedRecord[]; maxUpdatedAtISO: string | null; error?: string; permanent?: boolean }> {
  const pageSize = Math.min(25, Math.max(1, opts.pageSize ?? 25));
  const maxPages = Math.min(200, Math.max(1, opts.maxPages ?? 50));
  const cutoffMs = opts.watermarkFromISO ? Date.parse(opts.watermarkFromISO) : NaN;

  const records: ParasutFetchedRecord[] = [];
  let maxUpdatedMs = NaN;

  for (let page = 1; page <= maxPages; page++) {
    const params = new URLSearchParams();
    params.set("page[number]", String(page));
    params.set("page[size]", String(pageSize));
    params.set("sort", "-updated_at");
    if (opts.include && opts.include.length > 0) {
      params.set("include", opts.include.join(","));
    }
    if (opts.filters) {
      for (const [k, v] of Object.entries(opts.filters)) {
        params.set(k, v);
      }
    }

    const endpointPath = opts.pathSuffix ?? opts.resource;
    const url = `${PARASUT_API_ORIGIN}/v4/${opts.companyId}/${endpointPath}?${params.toString()}`;
    assertParasutV4GetOnly(url, "GET");

    const res = await opts.limiter.send(opts.http, {
      url,
      method: "GET",
      headers: {
        authorization: `Bearer ${opts.accessToken}`,
        accept: "application/json",
      },
    });

    if (!res.ok) {
      const permanent = res.status === 401 || res.status === 403 || res.status === 404;
      return {
        ok: false,
        records,
        maxUpdatedAtISO: Number.isFinite(maxUpdatedMs) ? new Date(maxUpdatedMs).toISOString() : null,
        error: `Paraşüt GET /v4/${opts.companyId}/${endpointPath} hatası (${res.status || "ağ"})${res.error ? `: ${res.error}` : ""}`,
        permanent,
      };
    }

    let parsed: JsonApiPagePayload;
    try {
      const rawObj = JSON.parse(res.body) as Record<string, unknown>;
      const dataArr = Array.isArray(rawObj.data) ? (rawObj.data as JsonApiResourceObject[]) : [];
      const includedArr = Array.isArray(rawObj.included) ? (rawObj.included as JsonApiResourceObject[]) : undefined;
      const metaObj = rawObj.meta && typeof rawObj.meta === "object" ? (rawObj.meta as JsonApiPagePayload["meta"]) : undefined;
      parsed = { data: dataArr, included: includedArr, meta: metaObj };
    } catch {
      return {
        ok: false,
        records,
        maxUpdatedAtISO: null,
        error: `Paraşüt /v4/${opts.companyId}/${endpointPath} yanıtı geçerli JSON:API değil.`,
        permanent: true,
      };
    }

    if (parsed.data.length === 0) break;

    const includedIndex = buildIncludedIndex(parsed.included);
    let reachedOlderThanCutoff = false;

    for (const item of parsed.data) {
      if (!item || typeof item.id !== "string") continue;
      const attrs = (item.attributes ?? {}) as Record<string, unknown>;
      const updatedRaw =
        typeof attrs.updated_at === "string"
          ? attrs.updated_at
          : typeof attrs.created_at === "string"
            ? attrs.created_at
            : null;
      const updatedMs = updatedRaw ? Date.parse(updatedRaw) : NaN;
      if (Number.isFinite(updatedMs)) {
        if (!Number.isFinite(maxUpdatedMs) || updatedMs > maxUpdatedMs) {
          maxUpdatedMs = updatedMs;
        }
        if (Number.isFinite(cutoffMs) && updatedMs < cutoffMs) {
          reachedOlderThanCutoff = true;
          continue;
        }
      }

      const envelope = {
        id: item.id,
        type: item.type,
        attributes: attrs,
        relationships: item.relationships ?? null,
      };

      records.push({
        resource: opts.resource,
        item: {
          id: item.id,
          type: item.type ?? opts.resource,
          attributes: attrs,
          relationships: item.relationships,
        },
        includedIndex,
        rawJson: envelope,
        payloadSha256: canonicalPayloadSha256(envelope),
        externalUpdatedAt: Number.isFinite(updatedMs) ? new Date(updatedMs).toISOString() : null,
      });
    }

    const totalPages = parsed.meta?.total_pages ?? 1;
    if (page >= totalPages || reachedOlderThanCutoff) {
      break;
    }
  }

  return {
    ok: true,
    records,
    maxUpdatedAtISO: Number.isFinite(maxUpdatedMs) ? new Date(maxUpdatedMs).toISOString() : null,
  };
}

