// Faz 27, Faz 40 (A2), Faz 46 (C3) & Faz 60 (M-64) — FX rate providers with TCMB archive fallback.
//
// NO ENVIRONMENT VARIABLES AT MODULE SCOPE. Keeping this module free of `@/lib/env` lets
// verify gates and pure tests import `mockRateProvider` / `tcmbProvider` without a database.

import { parseTcmbBulletinDate, parseTcmbXml, type TcmbRate } from "./rules";

/** The published daily bulletin. Public, no credential. */
export const TCMB_TODAY_URL = "https://www.tcmb.gov.tr/kurlar/today.xml";
const TCMB_TIMEOUT_MS = 15_000;
const MAX_HOLIDAY_LOOKBACK_DAYS = 7;

export function isAllowedTcmbUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) return false;
  const host = parsed.hostname.toLowerCase();
  return host === "www.tcmb.gov.tr" || host === "tcmb.gov.tr";
}

/**
 * Builds the official TCMB historical bulletin URL (`https://www.tcmb.gov.tr/kurlar/YYYYMM/DDMMYYYY.xml`)
 * for a given `YYYY-MM-DD` date.
 */
export function buildTcmbArchiveUrl(dateISO: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateISO.trim());
  if (!m) return null;
  const [, yyyy, mm, dd] = m;
  return `https://www.tcmb.gov.tr/kurlar/${yyyy}${mm}/${dd}${mm}${yyyy}.xml`;
}

function stepBackDaysISO(dateISO: string, daysBack: number): string | null {
  const ms = Date.parse(`${dateISO}T00:00:00Z`);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms - daysBack * 86_400_000).toISOString().slice(0, 10);
}

export interface RateFetchResult {
  ok: boolean;
  /** Published bulletin date (`YYYY-MM-DD`) when available; falls back to queried date only on mocks. */
  rateDate: string | null;
  /** TCMB's own published bulletin date (`Tarih` / `Date` attribute on `<Tarih_Date>`). */
  bulletinDate?: string | null;
  /** Date requested by the caller (`dateISO`) — preserved separately when querying on weekends/holidays. */
  queriedDate?: string | null;
  rates: TcmbRate[];
  error?: string;
}

export interface RateProvider {
  source: "tcmb" | "manual" | "bank" | "other";
  fetchRates(dateISO: string): Promise<RateFetchResult>;
}

export function mockRateProvider(
  rates: TcmbRate[],
  opts: { failWith?: string; source?: RateProvider["source"]; bulletinDate?: string } = {},
): RateProvider {
  return {
    source: opts.source ?? "tcmb",
    async fetchRates(dateISO: string): Promise<RateFetchResult> {
      if (opts.failWith) {
        return { ok: false, rateDate: null, bulletinDate: null, queriedDate: dateISO, rates: [], error: opts.failWith };
      }
      const bulletinDate = opts.bulletinDate ?? dateISO;
      return { ok: true, rateDate: bulletinDate, bulletinDate, queriedDate: dateISO, rates };
    },
  };
}

async function fetchSingleTcmbXml(
  targetUrl: string,
  queriedDate: string,
): Promise<RateFetchResult> {
  const res = await fetch(targetUrl, {
    headers: { accept: "application/xml,text/xml" },
    signal: AbortSignal.timeout(TCMB_TIMEOUT_MS),
  });
  if (!res.ok) {
    return {
      ok: false,
      rateDate: null,
      bulletinDate: null,
      queriedDate,
      rates: [],
      error: `TCMB HTTP ${res.status}`,
    };
  }
  const xml = await res.text();
  const rates = parseTcmbXml(xml);
  if (rates.length === 0) {
    return {
      ok: false,
      rateDate: null,
      bulletinDate: null,
      queriedDate,
      rates: [],
      error: "TCMB bülteni boş döndü (tatil/hafta sonu olabilir) — kayıt yapılmadı",
    };
  }
  const bulletinDate = parseTcmbBulletinDate(xml);
  const rateDate = bulletinDate ?? queriedDate;
  return { ok: true, rateDate, bulletinDate, queriedDate, rates };
}

export function tcmbProvider(url: string = TCMB_TODAY_URL): RateProvider {
  return {
    source: "tcmb",
    async fetchRates(dateISO: string): Promise<RateFetchResult> {
      if (!isAllowedTcmbUrl(url)) {
        return {
          ok: false,
          rateDate: null,
          bulletinDate: null,
          queriedDate: dateISO,
          rates: [],
          error: "TCMB adresi yalnız 'https://www.tcmb.gov.tr' alan adını kullanabilir.",
        };
      }
      try {
        const primary = await fetchSingleTcmbXml(url, dateISO);
        if (primary.ok) {
          return primary;
        }

        // M-64: Official weekend / public-holiday archive fallback (`kurlar/YYYYMM/DDMMYYYY.xml`)
        // Only runs when using the canonical `TCMB_TODAY_URL` endpoint.
        if (url === TCMB_TODAY_URL && /^\d{4}-\d{2}-\d{2}$/.test(dateISO)) {
          for (let back = 0; back <= MAX_HOLIDAY_LOOKBACK_DAYS; back++) {
            const candidateDate = stepBackDaysISO(dateISO, back);
            if (!candidateDate) continue;
            const archiveUrl = buildTcmbArchiveUrl(candidateDate);
            if (!archiveUrl || !isAllowedTcmbUrl(archiveUrl)) continue;
            const fallbackRes = await fetchSingleTcmbXml(archiveUrl, dateISO);
            if (fallbackRes.ok) {
              return fallbackRes;
            }
          }
        }

        return primary;
      } catch (e) {
        return {
          ok: false,
          rateDate: null,
          bulletinDate: null,
          queriedDate: dateISO,
          rates: [],
          error: `TCMB erişilemedi: ${(e as Error).message}`,
        };
      }
    },
  };
}

export function providerFor(source: RateProvider["source"], url?: string): RateProvider {
  return source === "tcmb" ? tcmbProvider(url) : mockRateProvider([], { source });
}
