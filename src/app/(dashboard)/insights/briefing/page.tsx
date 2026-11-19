import Link from "@/components/ui/app-link";
import { getPool } from "@/lib/db";
import { loadBriefingDashboard } from "@/lib/briefing/engine";
import { DELTA_CATEGORY_LABELS } from "@/lib/briefing/delta-attribution";
import { briefingStatus, renderBriefing } from "@/lib/briefing/rules";
import { loadUnknownOpeningAccountCount } from "@/lib/treasury/engine";
import { istanbulDateISO } from "@/lib/reports/rules";
import { dispatchMorningBriefingAction, generateBriefingAction } from "./actions";
import { Badge, type Tone } from "@/components/ui/badge";
import { Panel, fmtTL } from "@/components/ui/panel";
import { EmptyState, KeyStat, PageHeader } from "@/components/ui/shell";
import { requireRouteAccess } from "@/lib/authz/route-guard";

export const dynamic = "force-dynamic";

// The widget tones and the KeyStat tones are separate vocabularies; mapped once, here.
const TONE: Record<string, "neutral" | "pos" | "neg" | "warn"> = {
  pos: "pos", neg: "neg", warn: "warn", neutral: "neutral",
};
const BADGE: Record<string, Tone> = { pos: "green", neg: "red", warn: "amber", neutral: "neutral" };

interface BriefingPageProps {
  searchParams?: Promise<{ dispatched?: string; dispatchError?: string }>;
}

export default async function BriefingPage({ searchParams }: BriefingPageProps) {
  // Faz 17-38 denetimi — sayfa seviyesi rol kapisi. Navigasyonun kullandigi AYNI karar
  // (canSeeRoute); ikinci bir liste, ikinci bir fikir ve kacinilmaz bir kayma demekti.
  const denied = await requireRouteAccess("/insights/briefing");
  if (denied) return denied;
  const sp = (await searchParams) ?? {};
  const pool = getPool();
  const today = istanbulDateISO();

  // Both halves of this screen come from ONE gathering step. The tiles a CFO scans and the text
  // that gets mailed cannot show different numbers, because they are the same numbers.
  const [{ widgets, attention, facts }, unknownOpening] = await Promise.all([
    loadBriefingDashboard(pool, today),
    loadUnknownOpeningAccountCount(pool),
  ]);
  const preview = renderBriefing(facts);
  // Bilinmeyen 7 günlük likidite açığı artık "kritik bulgu yok" (yeşil) okunmaz — kural ve
  // gerekçesi briefingStatus()'ta, birim testli.
  const status = briefingStatus(facts);
  const delta = facts.overnightDelta;
  const provenance = facts.provenance;
  const staleWorkbookWarning =
    provenance?.workbookStaleDays != null && provenance.workbookStaleDays > 30;
  const schemaBadgeText =
    provenance?.migrationCount != null && provenance.schemaVersion
      ? `${provenance.migrationCount}/${provenance.schemaVersion}`
      : provenance?.schemaVersion ?? "—";

  return (
    <>
      <PageHeader
        title="CFO Sabah Brifingi"
        subtitle="Yönetim kokpiti ve günün özeti — panolardaki rakamların aynısı"
        meta={<Badge tone={BADGE[status.tone] ?? "neutral"} dot>{status.text}</Badge>}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <form action={dispatchMorningBriefingAction} className="flex items-center gap-1.5">
              <select
                name="channel"
                defaultValue="telegram"
                aria-label="Brifing gönderim kanalı"
                style={{
                  background: "var(--surface-1)",
                  border: "1px solid var(--line)",
                  color: "var(--text-1)",
                }}
                className="px-2 py-2 font-mono text-[10px] uppercase tracking-wider"
              >
                <option value="telegram">Telegram</option>
                <option value="email">E-posta</option>
              </select>
              <button
                type="submit"
                style={{
                  background: "var(--surface-2)",
                  border: "1px solid var(--line)",
                  color: "var(--text-1)",
                }}
                className="px-3 py-2 font-mono text-xs uppercase tracking-wider hover:opacity-85"
              >
                Brifingi Kanallara Gönder
              </button>
            </form>
            <form action={generateBriefingAction}>
              <button className="button-accent px-3 py-2 font-mono text-xs uppercase tracking-wider">
                Brifingi üret ve kaydet
              </button>
            </form>
          </div>
        }
      />

      {sp.dispatched ? (
        <div
          role="status"
          style={{
            background: "var(--surface-2)",
            border: "1px solid var(--line)",
            color: "var(--text-1)",
          }}
          className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs"
        >
          <Badge tone="green" dot>Gönderildi</Badge>
          <span>
            {`Sabah brifingi ${sp.dispatched === "email" ? "E-posta" : "Telegram"} kanalına iletildi.`}
          </span>
        </div>
      ) : null}

      {sp.dispatchError ? (
        <div
          role="alert"
          style={{
            background: "var(--surface-2)",
            border: "1px solid var(--line)",
            color: "var(--text-1)",
          }}
          className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs"
        >
          <Badge tone="amber" dot>Kanal Uyarısı</Badge>
          <span>{sp.dispatchError}</span>
        </div>
      ) : null}

      {provenance ? (
        <div
          role="region"
          aria-label="Veri Kaynağı ve Güncellik Kanıtı"
          style={{
            background: "var(--surface-2)",
            border: "1px solid var(--line)",
            color: "var(--text-2)",
          }}
          className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs"
        >
          <div className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
            <Badge tone={staleWorkbookWarning ? "amber" : "green"} dot>
              Veri Kaynağı &amp; Güncellik Kanıtı
            </Badge>
            <span>{`as_of: ${provenance.asOfDate}`}</span>
            <span className="text-tone-4">·</span>
            <span title={provenance.snapshotId}>{`snapshot_id: ${provenance.snapshotId.slice(0, 8)}`}</span>
            <span className="text-tone-4">·</span>
            <span>{`şema: ${schemaBadgeText}`}</span>
            <span className="text-tone-4">·</span>
            <span>{`son ekstre: ${provenance.lastBankTxAt ?? "banka ekstresi yok"}`}</span>
          </div>
          <div className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
            {provenance.workbookStaleDays != null ? (
              <Badge tone={staleWorkbookWarning ? "amber" : "neutral"} dot={staleWorkbookWarning}>
                {`son Excel ithalatı: ${provenance.workbookStaleDays} gün eski`}
              </Badge>
            ) : (
              <Badge tone="neutral">son Excel ithalatı: kayıt yok</Badge>
            )}
          </div>
        </div>
      ) : null}

      {unknownOpening.totalUnknown > 0 ? (
        <div
          role="status"
          style={{
            background: "var(--surface-2)",
            border: "1px solid var(--line)",
            color: "var(--text-2)",
          }}
          className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs"
        >
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="amber" dot>FIN-03</Badge>
            <span>{`Açılış bakiyesi tanımsız ${unknownOpening.totalUnknown} aktif hesap var — kullanılabilir nakit ve likidite açığı doğrulanana kadar Bilinmiyor (FIN-03) olarak işaretlendi.`}</span>
          </div>
          {unknownOpening.byCurrency.length > 0 ? (
            <span className="font-mono text-[11px]">
              {unknownOpening.byCurrency.map((c) => `${c.currency}: ${c.count}`).join(" · ")}
            </span>
          ) : null}
        </div>
      ) : null}

      <Panel title="YÖNETİM KOKPİTİ">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {widgets.map((w) => (
            <KeyStat
              key={w.key}
              label={w.label}
              value={w.value}
              tone={TONE[w.tone] ?? "neutral"}
              sub={w.note}
              href={w.href}
            />
          ))}
        </div>
        <p className="mt-2 font-mono text-[10px] text-tone-4">
          {/* Stated on the screen, not only in the code: a dash is missing data, not zero. */}
          &ldquo;—&rdquo; hesaplanamayan değeri gösterir; sıfır anlamına gelmez.
        </p>
      </Panel>

      <Panel
        title="ÇOKLU DÖVİZ KONSOLİDASYONU (TCMB KUR ÇEVRİMİ)"
        subtitle={
          facts.fxRatesAsOf
            ? `fx_rate_snapshots (${facts.fxRatesAsOf}) üzerinden TRY karşılığına çevrilen kasa ve yükümlülükler`
            : "TCMB döviz kurları ile konsolide kasa ve yükümlülük özeti"
        }
        right={
          <Badge tone={(facts.unconvertibleForeignCount ?? 0) === 0 ? "green" : "amber"} dot>
            {(facts.unconvertibleForeignCount ?? 0) === 0
              ? `TCMB ${facts.fxRatesAsOf ?? "güncel"}`
              : `${facts.unconvertibleForeignCount} kur eksik`}
          </Badge>
        }
      >
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <KeyStat
            label="Konsolide Kasa (TCMB TL)"
            value={facts.consolidatedCashTry == null ? "—" : fmtTL(facts.consolidatedCashTry)}
            tone={facts.consolidatedCashTry == null ? "neutral" : "pos"}
            sub={`Saf TRY Kasa: ${facts.availableCash == null ? "—" : fmtTL(facts.availableCash)}`}
            href="/treasury"
          />
          <KeyStat
            label="Konsolide 7G Açık (TCMB TL)"
            value={facts.consolidatedGap7Try == null ? "—" : fmtTL(facts.consolidatedGap7Try)}
            tone={
              facts.consolidatedGap7Try == null
                ? "neutral"
                : facts.consolidatedGap7Try > 0
                  ? "neg"
                  : "pos"
            }
            sub={`Saf TRY 7G Açık: ${facts.liquidityGap7 == null ? "—" : fmtTL(facts.liquidityGap7)}`}
            href="/treasury"
          />
          <KeyStat
            label="Bugün Konsolide Çıkış"
            value={fmtTL(facts.todayConsolidatedOutflowTry ?? facts.todayOutflowKnown)}
            tone={(facts.todayConsolidatedOutflowTry ?? facts.todayOutflowKnown) > 0 ? "warn" : "neutral"}
            sub={`Saf TRY: ${fmtTL(facts.todayOutflowKnown)} · Döviz: ${facts.todayForeignCurrencyCount} kalem`}
            href="/payments"
          />
          <KeyStat
            label="Gecikmiş Konsolide Çıkış"
            value={fmtTL(facts.overdueConsolidatedOutflowTry ?? facts.overdueKnownOutflow)}
            tone={facts.overdueCount > 0 ? "neg" : "pos"}
            sub={`Saf TRY: ${fmtTL(facts.overdueKnownOutflow)} · Döviz: ${facts.overdueForeignCurrencyCount} kalem`}
            href="/payments"
          />
        </div>
        {(facts.currencyPositions ?? []).length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-2 border-t border-line pt-2 font-mono text-[11px] text-tone-2">
            {(facts.currencyPositions ?? []).map((p) => (
              <span
                key={p.currency}
                style={{ background: "var(--surface-2)", border: "1px solid var(--line)" }}
                className="px-2 py-1"
              >
                <strong>{p.currency}:</strong>{" "}
                {p.availableNow == null
                  ? "—"
                  : new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 2 }).format(p.availableNow)}
                {p.currency !== "TRY"
                  ? ` × ${p.rateToTry == null ? "kur yok" : p.rateToTry.toFixed(4)} = ${p.tryEquivalent == null ? "—" : fmtTL(p.tryEquivalent)}`
                  : ""}
              </span>
            ))}
          </div>
        ) : null}
      </Panel>

      <Panel
        title="DÜNDEN BUGÜNE DEĞİŞİM ATFI (DELTA)"
        subtitle={
          delta
            ? `Önceki brifing: ${delta.fromDateISO} → ${delta.toDateISO} · 5 deterministik bileşen`
            : "Önceki brifing anlık görüntüsü ile kasa ve 7 günlük likidite açığı karşılaştırması"
        }
        right={
          delta ? (
            delta.deltaAvailableCash === null ||
            delta.previousAvailableCash === null ||
            delta.currentAvailableCash === null ? (
              <Badge tone="amber" dot>
                Mutabakat ölçülemez · FIN-03
              </Badge>
            ) : delta.identityUnmeasurable || !delta.hasVerifiedBankFeed ? (
              <Badge tone="amber" dot>
                Mutabakat ölçülemez · Ekstre yok
              </Badge>
            ) : (
              <Badge tone={delta.cashDeltaIdentityBalanced ? "green" : "amber"} dot>
                {delta.cashDeltaIdentityBalanced ? "kuruş özdeşliği tam" : "fark var"}
              </Badge>
            )
          ) : undefined
        }
      >
        {!delta || !delta.hasPriorSnapshot ? (
          <div className="mb-3 border border-dashed border-line p-1">
            <EmptyState>
              Önceki güne ait kaydedilmiş brifing anlık görüntüsü bulunamadı — dünün kapanışı ile tam
              karşılaştırma için brifingi üretip kaydedin.
            </EmptyState>
          </div>
        ) : null}

        {delta ? (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
              <KeyStat
                label="Δ Kullanılabilir Nakit"
                value={
                  delta.deltaAvailableCash == null
                    ? "Bilinmiyor (FIN-03 açılış eksik)"
                    : fmtTL(delta.deltaAvailableCash)
                }
                tone={
                  delta.deltaAvailableCash == null
                    ? "warn"
                    : delta.deltaAvailableCash >= 0
                      ? "pos"
                      : "neg"
                }
                sub={`Önceki (${delta.fromDateISO}): ${
                  delta.previousAvailableCash == null
                    ? "Bilinmiyor (FIN-03 açılış eksik)"
                    : fmtTL(delta.previousAvailableCash)
                }`}
              />
              <KeyStat
                label="① Banka Tahsilatları (+)"
                value={
                  delta.realizedBankInflows == null
                    ? !delta.hasVerifiedBankFeed
                      ? "Bilinmiyor (banka ekstresi yok)"
                      : "Bilinmiyor (FIN-03 açılış eksik)"
                    : fmtTL(delta.realizedBankInflows)
                }
                tone={delta.realizedBankInflows == null ? "neutral" : "pos"}
              />
              <KeyStat
                label="② Banka Ödemeleri (-)"
                value={
                  delta.realizedBankOutflows == null
                    ? !delta.hasVerifiedBankFeed
                      ? "Bilinmiyor (banka ekstresi yok)"
                      : "Bilinmiyor (FIN-03 açılış eksik)"
                    : fmtTL(delta.realizedBankOutflows)
                }
                tone={
                  delta.realizedBankOutflows != null && delta.realizedBankOutflows < 0
                    ? "neg"
                    : "neutral"
                }
              />
              <KeyStat
                label="③ 7G Pencereye Yeni Giren"
                value={fmtTL(delta.newlyEntered7dObligations)}
                tone={delta.newlyEntered7dObligations > 0 ? "warn" : "neutral"}
              />
              <KeyStat
                label="④ Kayan Söz / Geciken AR"
                value={fmtTL(delta.slippedPromisesAndOverdueAr)}
                tone={delta.slippedPromisesAndOverdueAr > 0 ? "neg" : "neutral"}
              />
              <KeyStat
                label="⑤ Kur & Düzeltme · ΔGap7"
                value={
                  delta.fxAndAdjustmentImpact == null
                    ? delta.previousAvailableCash == null || delta.currentAvailableCash == null
                      ? "Bilinmiyor (FIN-03 açılış eksik)"
                      : "Bilinmiyor (banka ekstresi yok)"
                    : fmtTL(delta.fxAndAdjustmentImpact)
                }
                tone="neutral"
                sub={`7G Açık Δ: ${
                  delta.deltaLiquidityGap7 == null
                    ? "Bilinmiyor (FIN-03 açılış eksik)"
                    : fmtTL(delta.deltaLiquidityGap7)
                }`}
              />
            </div>

            {delta.items.length > 0 ? (
              <ul className="mt-3 flex flex-col gap-1 border-t border-line pt-2">
                {delta.items.slice(0, 8).map((item, idx) => (
                  <li
                    key={`${item.category}-${item.sourceId ?? idx}`}
                    className="flex flex-wrap items-center justify-between gap-2 border-b border-line-faint py-1 text-xs last:border-0"
                  >
                    <span className="flex flex-wrap items-center gap-2">
                      <Badge
                        tone={
                          item.amountSigned > 0
                            ? "green"
                            : item.amountSigned < 0
                              ? "red"
                              : "neutral"
                        }
                      >
                        {DELTA_CATEGORY_LABELS[item.category]}
                      </Badge>
                      <span>{item.label}</span>
                      {item.counterpartyName ? (
                        <span className="text-tone-3">· {item.counterpartyName}</span>
                      ) : null}
                    </span>
                    <span className="font-mono text-xs text-tone-2">
                      {item.eventDate} · {fmtTL(item.amountSigned)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        ) : null}
      </Panel>

      {attention.length > 0 && (
        <Panel title="DİKKAT GEREKTİRENLER">
          <ul className="flex flex-col gap-1">
            {attention.map((w) => (
              <li key={w.key} className="flex items-center justify-between gap-2 border-b border-line-faint py-1.5 last:border-0">
                <span className="flex items-center gap-2">
                  <Badge tone={BADGE[w.tone] ?? "neutral"} dot>{w.tone === "neg" ? "kritik" : "izle"}</Badge>
                  <Link href={w.href} className="text-sm underline underline-offset-2">{w.label}</Link>
                </span>
                <span className="font-mono text-xs text-tone-2">{w.value} · {w.note}</span>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <Panel
        title="BUGÜNÜN BRİFİNGİ"
        right={<span className="font-mono text-[10px] uppercase text-tone-4">{today} · önizleme</span>}
      >
        {/* Rendered from the same facts the tiles above use, so the preview cannot drift from
            the stored document that the button produces. */}
        <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-tone-1">
          {preview}
        </pre>
        <p className="mt-2 font-mono text-[10px] text-tone-4">
          Rakamlar hazine, işletme sermayesi, kontrol ve radar panolarından okunur; burada yeniden
          hesaplanmaz. Yapay zekâ kullanılmaz.
        </p>
      </Panel>
    </>
  );
}
