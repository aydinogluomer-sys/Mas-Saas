// Faz 27 — FX rate providers.
//
// SCOPE, STATED PLAINLY: this is the MANUAL / on-demand-fetch half of the TCMB integration. There
// is no scheduler, no background job and no live feed. The plan puts the automatic connection in
// Faz 37/38, and building it here would mean shipping a polling loop nobody asked for against a
// host this environment cannot reach.
//
// It follows the transport pattern Faz 20/25 established: an interface, a real implementation
// that reports an honest failure when the host is unreachable, and a deterministic mock the tests
// and the gate drive. The real one never throws — an unreachable bulletin is a recorded outcome,
// not a crash, exactly as reminder_deliveries' 'failed' status assumes for its own transport.
//
// NO ENVIRONMENT VARIABLES. The endpoint is a parameter with a documented default rather than an
// env read, and that is deliberate: importing @/lib/env at module load is what made
// phase25-verify and phase6b-verify unrunnable under their own documented commands. A rate
// provider has nothing to do with the database, so nothing here should be able to demand one.

import { parseTcmbXml, type TcmbRate } from "./rules";

/** The published daily bulletin. Public, no credential. */
export const TCMB_TODAY_URL = "https://www.tcmb.gov.tr/kurlar/today.xml";

export interface RateFetchResult {
  ok: boolean;
  /** ISO date the bulletin is for; null when the fetch failed. */
  rateDate: string | null;
  rates: TcmbRate[];
  error?: string;
}

export interface RateProvider {
  source: "tcmb" | "manual" | "bank" | "other";
  fetchRates(dateISO: string): Promise<RateFetchResult>;
}

/**
 * Deterministic provider for tests and the gate.
 *
 * Returns exactly what it was given, so a test can assert on known numbers rather than on
 * whatever the market did today. `failWith` exercises the failure path, which is the branch that
 * actually matters — the real provider cannot reach its host from here, so the failure is the
 * behaviour this codebase will see most often.
 */
export function mockRateProvider(
  rates: TcmbRate[],
  opts: { failWith?: string; source?: RateProvider["source"] } = {},
): RateProvider {
  return {
    source: opts.source ?? "tcmb",
    async fetchRates(dateISO: string): Promise<RateFetchResult> {
      if (opts.failWith) {
        return { ok: false, rateDate: null, rates: [], error: opts.failWith };
      }
      return { ok: true, rateDate: dateISO, rates };
    },
  };
}

/**
 * The real TCMB bulletin reader.
 *
 * `url` is a parameter so a caller can point it at an archive path
 * (tcmb.gov.tr/kurlar/YYYYMM/DDMMYYYY.xml) for a historical date, and so tests never have to
 * monkey-patch a constant.
 *
 * The bulletin is not published on weekends and holidays; TCMB answers with an HTML error page
 * rather than a 404, which would parse to zero currencies. That case is reported as a failure
 * with a readable reason instead of silently recording an empty rate set — an empty set would
 * look like a successful fetch that found nothing, and the next revaluation would quietly use a
 * stale rate while believing it was current.
 */
export function tcmbProvider(url: string = TCMB_TODAY_URL): RateProvider {
  return {
    source: "tcmb",
    async fetchRates(dateISO: string): Promise<RateFetchResult> {
      try {
        const res = await fetch(url, { headers: { accept: "application/xml,text/xml" } });
        if (!res.ok) {
          return { ok: false, rateDate: null, rates: [], error: `TCMB HTTP ${res.status}` };
        }
        const xml = await res.text();
        const rates = parseTcmbXml(xml);
        if (rates.length === 0) {
          return {
            ok: false, rateDate: null, rates: [],
            error: "TCMB bülteni boş döndü (tatil/hafta sonu olabilir) — kayıt yapılmadı",
          };
        }
        // The bulletin carries its own date; trust it over the caller's when present, because a
        // weekend request silently serves the last business day's file.
        const published = xml.match(/Date="(\d{2})\.(\d{2})\.(\d{4})"/);
        const rateDate = published
          ? `${published[3]}-${published[2]}-${published[1]}`
          : dateISO;
        return { ok: true, rateDate, rates };
      } catch (e) {
        return { ok: false, rateDate: null, rates: [], error: `TCMB erişilemedi: ${(e as Error).message}` };
      }
    },
  };
}

/** One place that maps a source name to a provider, so a new source cannot be half-wired. */
export function providerFor(source: RateProvider["source"], url?: string): RateProvider {
  return source === "tcmb" ? tcmbProvider(url) : mockRateProvider([], { source });
}
