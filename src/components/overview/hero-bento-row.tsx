import { Activity, ArrowLeftRight, ArrowUpRight, ShieldCheck, Wallet } from "lucide-react";
import Link from "@/components/ui/app-link";
import { SparklineDeltaSvg } from "@/components/charts/folio-visuals";
import { Fin03OpeningDrawer } from "@/components/overview/fin03-opening-drawer";
import { Badge } from "@/components/ui/badge";
import { fmtTL } from "@/components/ui/panel";
import type {
  OverviewPrimarySnapshot,
  OverviewSecondarySnapshot,
} from "@/lib/home/overview-snapshot";
import { add, money, sub, sumMoney } from "@/lib/money";

const ym = (iso: string | null) => (iso ? iso.slice(0, 7) : "—");
const addDaysIso = (iso: string, days: number) =>
  new Date(Date.parse(iso) + days * 86_400_000).toISOString().slice(0, 10);

export function splitCurrencyText(formatted: string): { main: string; unit: string | null } {
  const m = formatted.match(/^(.*?)\s+(TL|TRY|USD|EUR|GBP|gün|istisna|aşım|Hesap)$/i);
  if (!m) return { main: formatted, unit: null };
  return { main: m[1], unit: m[2] };
}

export function renderFormattedMetric(
  formatted: string,
  sizeClass = "text-[24px]",
  color = "var(--text-1)",
) {
  const { main, unit } = splitCurrencyText(formatted);
  return (
    <span
      className={`inline-flex items-baseline gap-1 font-bold leading-[1.06] tracking-[-0.025em] tabular-nums ${sizeClass}`}
      style={{ color }}
    >
      <span>{main}</span>
      {unit && (
        <span
          className="font-mono text-[11.5px] font-semibold uppercase tracking-[0.03em]"
          style={{ color: "var(--text-3)" }}
        >
          {unit}
        </span>
      )}
    </span>
  );
}

export interface HeroBentoRowProps {
  primary: OverviewPrimarySnapshot;
  secondary: OverviewSecondarySnapshot;
  spark13wValues: readonly (number | null)[];
  canMutateCashAccounts?: boolean;
}

export function HeroBentoRow({
  primary,
  secondary,
  spark13wValues,
  canMutateCashAccounts,
}: HeroBentoRowProps) {
  const { heroPrimary, runwayFact, projection, weekOutflow, overdueOutflow, maturities, today } =
    primary;
  const { heroSecondary } = secondary;

  /* ── Tile 1: Serbest Kasa & Hareket Neti (compact FIN-03 safe, zero tall empty box) ── */
  const hasKnownFreeCash = heroPrimary.freeCashConsolidatedTry != null;
  const latestKnownMonth = [...projection.series]
    .reverse()
    .find((m) => m.delta != null || m.closing != null);
  const knownMovementTry =
    heroPrimary.netFlow13wTry ??
    latestKnownMonth?.delta ??
    (heroPrimary.fxCashTryEquivalent > 0 ? heroPrimary.fxCashTryEquivalent : null);

  const accountTotalCount = Math.max(
    heroPrimary.activeAccountCount,
    heroPrimary.unknownOpeningCount,
  );
  const tile1PrimaryText = hasKnownFreeCash
    ? fmtTL(heroPrimary.freeCashConsolidatedTry)
    : knownMovementTry != null && knownMovementTry !== 0
      ? `${knownMovementTry > 0 ? "+" : ""}${fmtTL(knownMovementTry)}`
      : `FIN-03 · ${accountTotalCount} Hesap`;

  const tile1Accent = !hasKnownFreeCash
    ? "var(--warn)"
    : (heroPrimary.freeCashConsolidatedTry ?? 0) < 0
      ? "var(--neg)"
      : "var(--pos)";
  const tile1ValueColor = !hasKnownFreeCash
    ? knownMovementTry != null && knownMovementTry < 0
      ? "var(--neg)"
      : "var(--warn)"
    : (heroPrimary.freeCashConsolidatedTry ?? 0) < 0
      ? "var(--neg)"
      : "var(--text-1)";

  /* ── Tile 2: 13H Likidite Dip Noktası + Compact Inline SparklineDeltaSvg (height=36) ── */
  const effectiveMin13 = heroPrimary.minCash13wTry ?? projection.worstBalance;
  const min13Text = effectiveMin13 != null ? fmtTL(effectiveMin13) : "Hesaplanıyor";
  const min13IsNeg = effectiveMin13 != null && effectiveMin13 < 0;
  const tile2Accent = min13IsNeg ? "var(--neg)" : "var(--pos)";
  const tile2ValueColor =
    effectiveMin13 == null ? "var(--text-2)" : min13IsNeg ? "var(--neg)" : "var(--pos)";

  /* ── Tile 3: Açık Alacak vs Ticari Borç Neti (live AR − AP or short-term inflows − payables) ── */
  const hasInvoiceArAp =
    (heroSecondary.receivablesOpenTry != null && heroSecondary.receivablesOpenTry > 0) ||
    (heroSecondary.payablesOpenTry != null && heroSecondary.payablesOpenTry > 0);

  const liveInflowSideTry = hasInvoiceArAp
    ? money(heroSecondary.receivablesOpenTry ?? 0)
    : money(heroPrimary.checkPortfolioInflowTry);
  const livePayableSideTry = hasInvoiceArAp
    ? money(heroSecondary.payablesOpenTry ?? 0)
    : sumMoney([overdueOutflow.total, weekOutflow.total, heroPrimary.checkIssuedOutflowTry]);

  const netReceivablePayableTry = money(sub(liveInflowSideTry, livePayableSideTry));
  const effectiveCcc = heroSecondary.cccDays ?? heroSecondary.cycleExclInventoryDays;
  const tile3Accent = netReceivablePayableTry < 0 ? "var(--warn)" : "var(--info)";
  const tile3ValueColor = netReceivablePayableTry < 0 ? "var(--warn)" : "var(--text-1)";

  /* ── Tile 4: 30 Günlük Çıkış & Borç Yükü (live 7G outflow + 30G check/loan + covenant status) ── */
  const next30Iso = addDaysIso(today, 30);
  const next30OutflowMaturities = maturities.filter(
    (m) => m.dueDate >= today && m.dueDate <= next30Iso && m.direction === "outflow" && m.amount != null,
  );
  const debtService30dTry = sumMoney(next30OutflowMaturities.map((m) => m.amount));
  const totalShortBurdenTry = money(add(weekOutflow.total, debtService30dTry));
  const hasCovenantBreach = heroSecondary.covenantBreachedCount > 0;
  const hasFacilityHeadroom =
    heroSecondary.facilityAvailableTry != null &&
    heroSecondary.facilityLimitTry != null &&
    heroSecondary.facilityLimitTry > 0;

  const tile4Accent = hasCovenantBreach
    ? "var(--neg)"
    : totalShortBurdenTry > 0
      ? "var(--warn)"
      : "var(--pos)";
  const tile4ValueColor = hasCovenantBreach
    ? "var(--neg)"
    : totalShortBurdenTry > 0
      ? "var(--text-1)"
      : "var(--pos)";

  return (
    <section
      aria-label="Ana finansal göstergeler"
      className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4"
    >
      {/* Tile 1: Serbest Kasa & Hareket Neti */}
      <article
        className="card-hover command-surface flex min-w-0 flex-col justify-between border px-3.5 py-2.5"
        style={{
          borderColor: "var(--line-card)",
          borderTop: `2.5px solid ${tile1Accent}`,
          borderRadius: "var(--radius-md)",
        }}
      >
        <div className="flex items-center justify-between gap-2">
          <Link
            href={hasKnownFreeCash ? "/finance/treasury" : "/finance/bank"}
            className="inline-flex min-w-0 items-center gap-1.5 hover:underline"
          >
            <Wallet size={13.5} strokeWidth={1.8} style={{ color: tile1Accent }} aria-hidden />
            <span
              className="text-[12.5px] font-bold leading-tight tracking-[-0.01em] text-tone-1"
              style={{ fontFamily: "var(--font-editorial)" }}
            >
              Serbest Kasa
            </span>
          </Link>
          <Badge tone={heroPrimary.unknownOpeningCount > 0 ? "amber" : "green"}>
            {heroPrimary.unknownOpeningCount > 0 ? "FIN-03" : "Konsolide ₺"}
          </Badge>
        </div>

        <div className="mt-1.5">
          <Link href={hasKnownFreeCash ? "/finance/treasury" : "/finance/bank"}>
            {renderFormattedMetric(tile1PrimaryText, "text-[23px] sm:text-[24px]", tile1ValueColor)}
          </Link>
        </div>

        <div className="mt-1.5 flex items-center justify-between gap-2 border-t border-line-faint pt-1.5 text-[11px] leading-tight text-tone-3">
          {heroPrimary.unknownOpeningCount > 0 ? (
            <>
              <span className="truncate tabular-nums">
                {hasKnownFreeCash
                  ? `TRY ${heroPrimary.freeCashTryOnly != null ? fmtTL(heroPrimary.freeCashTryOnly) : "—"}`
                  : `${heroPrimary.unknownOpeningCount} hesap açılış bekliyor`}
              </span>
              <Fin03OpeningDrawer
                unknownCount={heroPrimary.unknownOpeningCount}
                canMutate={Boolean(canMutateCashAccounts)}
              />
            </>
          ) : hasKnownFreeCash ? (
            <span className="truncate tabular-nums">
              TRY {heroPrimary.freeCashTryOnly != null ? fmtTL(heroPrimary.freeCashTryOnly) : "—"} · YP{" "}
              {fmtTL(heroPrimary.fxCashTryEquivalent)} ({heroPrimary.activeAccountCount} hesap)
            </span>
          ) : (
            <>
              <span className="truncate tabular-nums">Açılış bakiyesi bekleniyor</span>
              <Link
                href="/finance/bank"
                className="inline-flex shrink-0 items-center gap-0.5 font-semibold text-warn underline underline-offset-2"
              >
                Açılış Gir →
              </Link>
            </>
          )}
        </div>
      </article>

      {/* Tile 2: 13H Likidite Dip Noktası + Inline SparklineDeltaSvg (height=36) */}
      <article
        className="card-hover command-surface flex min-w-0 flex-col justify-between border px-3.5 py-2.5"
        style={{
          borderColor: "var(--line-card)",
          borderTop: `2.5px solid ${tile2Accent}`,
          borderRadius: "var(--radius-md)",
        }}
      >
        <div className="flex items-center justify-between gap-2">
          <Link
            href="/cashflow"
            className="inline-flex min-w-0 items-center gap-1.5 hover:underline"
          >
            <Activity size={13.5} strokeWidth={1.8} style={{ color: tile2Accent }} aria-hidden />
            <span
              className="text-[12.5px] font-bold leading-tight tracking-[-0.01em] text-tone-1"
              style={{ fontFamily: "var(--font-editorial)" }}
            >
              13H Dip Nakit
            </span>
          </Link>
          <Badge
            tone={
              min13IsNeg
                ? "red"
                : runwayFact.severity === "critical" || runwayFact.severity === "high"
                  ? "amber"
                  : "green"
            }
          >
            Runway {runwayFact.value}
          </Badge>
        </div>

        <div className="mt-1.5 flex items-center justify-between gap-2.5">
          <Link href="/cashflow" className="min-w-0">
            {renderFormattedMetric(min13Text, "text-[23px] sm:text-[24px]", tile2ValueColor)}
          </Link>
          <div className="w-[92px] shrink-0">
            <SparklineDeltaSvg
              values={spark13wValues}
              referenceValue={0}
              width={92}
              height={36}
              label="13 haftalık serbest nakit ufku"
              className="w-full"
            />
          </div>
        </div>

        <div className="mt-1.5 flex items-center justify-between gap-2 border-t border-line-faint pt-1.5 text-[11px] leading-tight text-tone-3">
          <span className="truncate tabular-nums">
            Dip: <span className="font-mono">{heroPrimary.minCash13wDate ?? ym(projection.worstMonth)}</span>
            {projection.firstNegativeMonth
              ? ` · İlk eksi ${ym(projection.firstNegativeMonth)}`
              : " · Eksi ay yok"}
          </span>
        </div>
      </article>

      {/* Tile 3: Açık Alacak vs Ticari Borç Neti */}
      <article
        className="card-hover command-surface flex min-w-0 flex-col justify-between border px-3.5 py-2.5"
        style={{
          borderColor: "var(--line-card)",
          borderTop: `2.5px solid ${tile3Accent}`,
          borderRadius: "var(--radius-md)",
        }}
      >
        <div className="flex items-center justify-between gap-2">
          <Link
            href="/finance/receivables"
            className="inline-flex min-w-0 items-center gap-1.5 hover:underline"
          >
            <ArrowLeftRight size={13.5} strokeWidth={1.8} style={{ color: tile3Accent }} aria-hidden />
            <span
              className="truncate text-[12.5px] font-bold tracking-[-0.01em] text-tone-1"
              style={{ fontFamily: "var(--font-editorial)" }}
            >
              Alacak − Ticari Borç
            </span>
          </Link>
          <Badge tone={effectiveCcc != null && effectiveCcc > 60 ? "amber" : "neutral"}>
            {effectiveCcc != null ? `CCC ${effectiveCcc}g` : hasInvoiceArAp ? "Cari Net" : "Açık Net"}
          </Badge>
        </div>

        <div className="mt-1.5">
          <Link href="/finance/receivables">
            {renderFormattedMetric(
              fmtTL(netReceivablePayableTry),
              "text-[23px] sm:text-[24px]",
              tile3ValueColor,
            )}
          </Link>
        </div>

        <div className="mt-1.5 flex items-center justify-between gap-2 border-t border-line-faint pt-1.5 text-[11px] leading-tight text-tone-3">
          <span className="truncate tabular-nums">
            Alacak {fmtTL(liveInflowSideTry)} · Borç {fmtTL(livePayableSideTry)}
          </span>
          <Link
            href="/finance/receivables"
            className="inline-flex shrink-0 items-center gap-0.5 font-semibold text-tone-2 hover:underline"
          >
            Yaşlandırma
            <ArrowUpRight size={11} strokeWidth={1.8} aria-hidden />
          </Link>
        </div>
      </article>

      {/* Tile 4: 30 Günlük Çıkış & Borç Yükü */}
      <article
        className="card-hover command-surface flex min-w-0 flex-col justify-between border px-3.5 py-2.5"
        style={{
          borderColor: "var(--line-card)",
          borderTop: `2.5px solid ${tile4Accent}`,
          borderRadius: "var(--radius-md)",
        }}
      >
        <div className="flex items-center justify-between gap-2">
          <Link
            href="/finance"
            className="inline-flex min-w-0 items-center gap-1.5 hover:underline"
          >
            <ShieldCheck size={13.5} strokeWidth={1.8} style={{ color: tile4Accent }} aria-hidden />
            <span
              className="truncate text-[12.5px] font-bold tracking-[-0.01em] text-tone-1"
              style={{ fontFamily: "var(--font-editorial)" }}
            >
              30G Çıkış &amp; Borç Yükü
            </span>
          </Link>
          <Badge tone={hasCovenantBreach ? "red" : totalShortBurdenTry > 0 ? "amber" : "green"}>
            {hasCovenantBreach
              ? `${heroSecondary.covenantBreachedCount} İhlal`
              : heroSecondary.covenantActiveCount > 0
                ? `${heroSecondary.covenantActiveCount} Uyumlu`
                : `${weekOutflow.count + next30OutflowMaturities.length} Vade`}
          </Badge>
        </div>

        <div className="mt-1.5">
          <Link href="/finance">
            {renderFormattedMetric(
              fmtTL(totalShortBurdenTry),
              "text-[23px] sm:text-[24px]",
              tile4ValueColor,
            )}
          </Link>
        </div>

        <div className="mt-1.5 flex items-center justify-between gap-2 border-t border-line-faint pt-1.5 text-[11px] leading-tight text-tone-3">
          <span className="truncate tabular-nums">
            {hasFacilityHeadroom
              ? `Boşluk ${fmtTL(heroSecondary.facilityAvailableTry)} · 7G ${fmtTL(weekOutflow.total)}`
              : `7G ${fmtTL(weekOutflow.total)} · Çek/Kredi ${fmtTL(debtService30dTry)}`}
          </span>
          <Link
            href="/finance"
            className="inline-flex shrink-0 items-center gap-0.5 font-semibold text-tone-2 hover:underline"
          >
            Hazine →
          </Link>
        </div>
      </article>
    </section>
  );
}
