import Link from "next/link";
import { getPool } from "@/lib/db";
import { loadBriefingDashboard } from "@/lib/briefing/engine";
import { renderBriefing } from "@/lib/briefing/rules";
import { istanbulDateISO } from "@/lib/reports/rules";
import { generateBriefingAction } from "./actions";
import { Badge, type Tone } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { KeyStat, PageHeader } from "@/components/ui/shell";
import { requireRouteAccess } from "@/lib/authz/route-guard";

export const dynamic = "force-dynamic";

// The widget tones and the KeyStat tones are separate vocabularies; mapped once, here.
const TONE: Record<string, "neutral" | "pos" | "neg" | "warn"> = {
  pos: "pos", neg: "neg", warn: "warn", neutral: "neutral",
};
const BADGE: Record<string, Tone> = { pos: "green", neg: "red", warn: "amber", neutral: "neutral" };

export default async function BriefingPage() {
  // Faz 17-38 denetimi — sayfa seviyesi rol kapisi. Navigasyonun kullandigi AYNI karar
  // (canSeeRoute); ikinci bir liste, ikinci bir fikir ve kacinilmaz bir kayma demekti.
  const denied = await requireRouteAccess("/insights/briefing");
  if (denied) return denied;
  const pool = getPool();
  const today = istanbulDateISO();

  // Both halves of this screen come from ONE gathering step. The tiles a CFO scans and the text
  // that gets mailed cannot show different numbers, because they are the same numbers.
  const { widgets, attention, facts } = await loadBriefingDashboard(pool, today);
  const preview = renderBriefing(facts);

  return (
    <>
      <PageHeader
        title="CFO Sabah Brifingi"
        subtitle="Yönetim kokpiti ve günün özeti — panolardaki rakamların aynısı"
        meta={
          <Badge tone={facts.criticalControls.length > 0 || (facts.liquidityGap7 ?? 0) > 0 ? "red" : "green"} dot>
            {facts.criticalControls.length > 0
              ? `${facts.criticalControls.length} kritik kontrol`
              : (facts.liquidityGap7 ?? 0) > 0 ? "likidite açığı var" : "kritik bulgu yok"}
          </Badge>
        }
        action={
          <form action={generateBriefingAction}>
            <button className="button-accent px-3 py-2 font-mono text-xs uppercase tracking-wider">
              Brifingi üret ve kaydet
            </button>
          </form>
        }
      />

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
