import Link from "@/components/ui/app-link";
import { askQuestionAction } from "./actions";
import { getRequestUser } from "@/lib/auth";
import { requireRouteAccess } from "@/lib/authz/route-guard";
import { getPool } from "@/lib/db";
import { listAiResponses } from "@/lib/ai/engine";
import { summarizeConversationWindow } from "@/lib/assistant/context";
import {
  buildFinancialContext,
  isMissingSchemaError,
  listConversations,
} from "@/lib/assistant/engine";
import { answerTelegramQuestion } from "@/lib/telegram/assistant";
import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { EmptyState, KeyStat, PageHeader } from "@/components/ui/shell";

export const dynamic = "force-dynamic";

const samples = [
  "Bugün ne ödenecek?",
  "7 günde ne kadar çıkış var?",
  "Kasa ne zaman negatife düşüyor?",
  "En büyük yoğunlaşma nerede?",
  "Hangi aksiyon öncelikli?",
];

const telegramSamples = [
  "Toplam açık alacak ne kadar?",
  "Toplam açık borç ne kadar?",
  "/cari ",
  "/hareket ",
];

export default async function AskPage({
  searchParams,
}: {
  searchParams?: Promise<{ tg?: string }>;
}) {
  const denied = await requireRouteAccess("/insights/ask");
  if (denied) return denied;
  const session = await getRequestUser();
  const role = session?.role ?? "viewer";
  const sp = searchParams ? await searchParams : {};
  const pool = getPool();
  const todayISO = new Date().toISOString().slice(0, 10);
  const tgQuery = (sp.tg ?? "Toplam açık alacak ne kadar?").trim();

  const [recent, tgResult, conversations, finContext] = await Promise.all([
    listAiResponses(pool, 20).catch((err: unknown) => {
      if (isMissingSchemaError(err)) return [];
      throw err;
    }),
    answerTelegramQuestion(pool, tgQuery, todayISO).catch(() => ({
      kind: "help" as const,
      answer: "Telegram asistanı yanıtı şu anda hesaplanamadı.",
    })),
    listConversations(pool, 10),
    buildFinancialContext(pool, role, todayISO),
  ]);

  const threadSummary = summarizeConversationWindow(conversations);

  return (
    <>
      <PageHeader
        title="Finansal Soru-Cevap"
        subtitle="Hesaplamayı deterministik motor yapar; AI yalnız kanıtlanmış sonuçları açıklar."
        meta={
          <>
            <Badge tone="green">kaynak kanıtlı</Badge>
            <Badge tone="amber">mali mutasyon yok</Badge>
          </>
        }
      />

      <Panel title="Karar sorusu">
        <form action={askQuestionAction} className="space-y-3">
          <textarea
            name="question"
            required
            rows={4}
            className="field-control w-full resize-y p-3"
            placeholder="Önümüzdeki 30 günde çek ve kredi yükü ne kadar?"
          />
          <div className="flex flex-wrap gap-2">
            <button className="button-accent px-3 py-2">Cevapla</button>
            <label className="button-ghost px-3 py-2">
              <input name="forceDeterministic" type="checkbox" /> Yalnız deterministik cevap
            </label>
          </div>
        </form>
        <div className="mt-3 flex flex-wrap gap-2">
          {samples.map((q) => (
            <form key={q} action={askQuestionAction}>
              <input type="hidden" name="question" value={q} />
              <button className="button-ghost px-2 py-1.5">{q}</button>
            </form>
          ))}
        </div>
      </Panel>

      <Panel
        title="ASİSTAN OTURUM GEÇMİŞİ & FİNANSAL BAĞLAM ÖZETİ"
        subtitle="Rol kapsamlı deterministik karar kanıtları (sıfır LLM çağrısı) ve çok-turlu konuşma izi"
        right={<Badge tone="neutral">{`rol: ${finContext.role}`}</Badge>}
      >
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          <KeyStat
            label="Erişilebilir Kanıt"
            value={String(finContext.visibleFactCount)}
            tone="pos"
            sub={`Baz tarih: ${finContext.asOf}`}
          />
          <KeyStat
            label="Gizlenen Kanıt (Rol)"
            value={String(finContext.withheldFactCount)}
            tone={finContext.withheldFactCount > 0 ? "warn" : "neutral"}
            sub={finContext.withheldNoticeText ?? "Rol kapsamında kısıtlama yok"}
          />
          <KeyStat
            label="Kanonik Kaynak Ekran"
            value={String(finContext.sourceRoutes.length)}
            tone="neutral"
            sub={finContext.sourceRoutes.slice(0, 3).join(", ") || "—"}
          />
          <KeyStat
            label="Aktif Oturum / Tur"
            value={`${threadSummary.activeThreads} / ${threadSummary.totalTurns}`}
            tone="neutral"
            sub={`Takip penceresi: son ${threadSummary.followUpWindowTurns} tur`}
          />
        </div>

        {conversations.length === 0 ? (
          <div className="mt-3 border border-dashed border-line p-1">
            <EmptyState>
              Henüz kaydedilmiş çok-turlu asistan oturumu bulunmuyor.
            </EmptyState>
          </div>
        ) : (
          <ul className="mt-3 flex flex-col gap-1 border-t border-line pt-2">
            {conversations.map((c) => (
              <li
                key={c.id}
                className="flex flex-wrap items-center justify-between gap-2 border-b border-line-faint py-1.5 text-xs last:border-0"
              >
                <span className="font-medium">{c.title}</span>
                <span className="flex items-center gap-2 font-mono text-[11px] text-tone-3">
                  <Badge tone={c.status === "active" ? "green" : "neutral"}>
                    {c.status}
                  </Badge>
                  <span>{`${c.turnCount} tur · ${c.updatedAt}`}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        title="TELEGRAM CFO ASİSTANI — HIZLI CARİ / ALACAK / BORÇ SORGULAMA"
        subtitle="Salt-okunur Telegram bot motoru (assistant.ts): kur çevrimi yapmadan TRY toplamlarını ve cari hesap ekstresini anında yanıtlar."
      >
        <form method="get" action="/insights/ask" className="flex flex-wrap gap-2">
          <input
            type="text"
            name="tg"
            defaultValue={tgQuery}
            placeholder="/cari Firma Adı, /hareket Firma Adı veya Toplam açık alacak ne kadar?"
            className="field-control min-w-65 flex-1 px-3 py-1.5 font-mono text-xs"
          />
          <button type="submit" className="button-accent px-3 py-1.5 text-xs">
            Sorgula
          </button>
        </form>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {telegramSamples.map((cmd) => (
            <a
              key={cmd}
              href={`/insights/ask?tg=${encodeURIComponent(cmd)}`}
              className="border border-line bg-surface-2 px-2 py-1 font-mono text-[11px] text-tone-2 hover:border-accent hover:text-tone-1"
            >
              {cmd}
            </a>
          ))}
        </div>
        <div className="mt-3 border border-line bg-ink p-3 font-mono text-xs text-tone-1">
          <div className="mb-1 flex items-center justify-between text-[10px] uppercase text-tone-3">
            <span>Komut: {tgQuery}</span>
            <Badge tone={tgResult.kind === "refused" ? "red" : "blue"}>{tgResult.kind}</Badge>
          </div>
          <pre className="whitespace-pre-wrap leading-relaxed">{tgResult.answer}</pre>
        </div>
      </Panel>

      <Panel title={`Geçmiş cevaplar · ${recent.length}`}>
        {recent.length === 0 ? (
          <EmptyState>Henüz kayıtlı soru-cevap yanıtı yok.</EmptyState>
        ) : (
          recent.map((r) => (
            <Link
              key={r.id}
              href={`/insights/ask/${r.id}`}
              className="grid gap-2 border-b border-line-faint py-2 text-sm sm:grid-cols-[1fr_auto_auto]"
            >
              <span>{r.question}</span>
              <Badge
                tone={
                  r.response_mode === "openai"
                    ? "green"
                    : r.response_mode === "fallback"
                      ? "amber"
                      : "neutral"
                }
              >
                {r.response_mode}
              </Badge>
              <span className="text-tone-3">{r.created_at} →</span>
            </Link>
          ))
        )}
      </Panel>
    </>
  );
}
