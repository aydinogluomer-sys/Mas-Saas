// Faz 27, Faz 40 (A2) & Faz 46 (C3) — FX rate providers.
//
// NO ENVIRONMENT VARIABLES AT MODULE SCOPE. Keeping this module free of `@/lib/env` lets
// verify gates and pure tests import `mockRateProvider` / `tcmbProvider` without a database.

import { parseTcmbBulletinDate, parseTcmbXml, type TcmbRate } from "./rules";

/** The published daily bulletin. Public, no credential. */
export const TCMB_TODAY_URL = "https://www.tcmb.gov.tr/kurlar/today.xml";
const TCMB_TIMEOUT_MS = 15_000;

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
        const res = await fetch(url, {
          headers: { accept: "application/xml,text/xml" },
          signal: AbortSignal.timeout(TCMB_TIMEOUT_MS),
        });
        if (!res.ok) {
          return {
            ok: false,
            rateDate: null,
            bulletinDate: null,
            queriedDate: dateISO,
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
            queriedDate: dateISO,
            rates: [],
            error: "TCMB bülteni boş döndü (tatil/hafta sonu olabilir) — kayıt yapılmadı",
          };
        }
        const bulletinDate = parseTcmbBulletinDate(xml);
        const rateDate = bulletinDate ?? dateISO;
        return { ok: true, rateDate, bulletinDate, queriedDate: dateISO, rates };
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
