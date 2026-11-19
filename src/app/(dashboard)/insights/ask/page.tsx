import Link from "@/components/ui/app-link";
import { askQuestionAction } from "./actions";
import { getRequestUser } from "@/lib/auth";
import { requireRouteAccess } from "@/lib/authz/route-guard";
import { getPool } from "@/lib/db";
import { listAiResponses, loadAiResponse } from "@/lib/ai/engine";
import type { ToolEvidenceRecord } from "@/lib/ai/tools";
import { summarizeConversationWindow } from "@/lib/assistant/context";
import {
  buildFinancialContext,
  isMissingSchemaError,
  listConversations,
  loadConversationDetail,
} from "@/lib/assistant/engine";
import { istanbulDateISO } from "@/lib/reports/rules";
import { answerTelegramQuestion } from "@/lib/telegram/assistant";
import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { EmptyState, KeyStat, PageHeader } from "@/components/ui/shell";

export const dynamic = "force-dynamic";

const samples = [
  "Gecikmiş açık satış ve alış faturaları ne kadar?",
  "13 haftalık likidite ve kasa projeksiyonu nedir?",
  "TDHP 102 mizan bakiyesi ve yönetim EBITDA tutarı nedir?",
  "Son 30 günlük banka hareketleri ve eşleşmemiş ekstre satırları neler?",
  "Cari bakiye ve çek yoğunlaşması en yüksek firmalar hangileri?",
  "Üretim parça marjları, tarife kartları ve OEE durumu nedir?",
  "Aktif kredi kovenant ve DSCR boşluğu ne durumda?",
];

const telegramSamples = [
  "Toplam açık alacak ne kadar?",
  "Toplam açık borç ne kadar?",
  "/cari ",
  "/hareket ",
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function AskPage({
  searchParams,
}: {
  searchParams?: Promise<{
    tg?: string;
    conversationId?: string;
    responseId?: string;
    error?: string;
  }>;
}) {
  const denied = await requireRouteAccess("/insights/ask");
  if (denied) return denied;
  const session = await getRequestUser();
  const role = session?.role ?? "viewer";
  const sp = searchParams ? await searchParams : {};
  const pool = getPool();
  const todayISO = istanbulDateISO();
  const tgQuery = (sp.tg ?? "Toplam açık alacak ne kadar?").trim();
  const requestedConversationId =
    sp.conversationId && UUID_RE.test(sp.conversationId.trim())
      ? sp.conversationId.trim()
      : null;

  const requestedResponseId =
    sp.responseId && UUID_RE.test(sp.responseId.trim()) ? sp.responseId.trim() : null;

  const [recent, tgResult, conversations, finContext, selectedConversation, selectedResponse] = await Promise.all([
    listAiResponses(pool, 20).catch((err: unknown) => {
      if (isMissingSchemaError(err)) return [];
      throw err;
    }),
    answerTelegramQuestion(pool, tgQuery, todayISO).catch(() => ({
      kind: "help" as const,
      answer: "Telegram asistanı yanıtı şu anda hesaplanamadı.",
    })),
    listConversations(pool, 25),
    buildFinancialContext(pool, role, todayISO),
    requestedConversationId ? loadConversationDetail(pool, requestedConversationId) : Promise.resolve(null),
    requestedResponseId ? loadAiResponse(pool, requestedResponseId).catch(() => undefined) : Promise.resolve(undefined),
  ]);

  const activeToolEvidence: ToolEvidenceRecord[] = Array.isArray(selectedResponse?.meta?.toolEvidence)
    ? (selectedResponse?.meta?.toolEvidence as ToolEvidenceRecord[])
    : [];

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

      {sp.error ? (
        <div
          className="mb-3 rounded border p-2 text-xs"
          style={{
            borderColor: "color-mix(in srgb, var(--neg) 40%, var(--line))",
            background: "color-mix(in srgb, var(--neg) 10%, var(--surface-1))",
            color: "var(--neg)",
          }}
        >
          {sp.error}
        </div>
      ) : null}

      <Panel
        title={
          selectedConversation
            ? `Karar sorusu · Oturum: ${selectedConversation.title}`
            : "Karar sorusu (Yeni Oturum)"
        }
        right={
          selectedConversation ? (
            <Link
              href="/insights/ask"
              className="rounded border px-2.5 py-1 font-mono text-xs"
              style={{
                borderColor: "var(--line)",
                background: "var(--surface-2)",
                color: "var(--text-1)",
              }}
            >
              + Yeni Oturum Başlat
            </Link>
          ) : undefined
        }
      >
        {selectedConversation && selectedConversation.turns.length > 0 ? (
          <div
            className="mb-4 space-y-2.5 rounded border p-3"
            style={{
              borderColor: "var(--line)",
              background: "var(--surface-2)",
            }}
          >
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs" style={{ color: "var(--text-2)" }}>
              <span className="font-mono font-semibold">
                Oturum Geçmişi ({selectedConversation.turns.length} tur) · Son güncelleme: {selectedConversation.updatedAt}
              </span>
              <Badge tone="green">Çok-turlu bağlam aktif</Badge>
            </div>
            <div className="space-y-2">
              {selectedConversation.turns.map((turn) => (
                <div
                  key={turn.responseId}
                  className="rounded border p-2.5 text-xs"
                  style={{
                    borderColor:
                      sp.responseId === turn.responseId ? "var(--accent, var(--line))" : "var(--line-faint)",
                    background: "var(--surface-1)",
                    color: "var(--text-1)",
                  }}
                >
                  <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                    <span className="font-mono font-semibold">
                      Tur #{turn.turnIndex}: {turn.question}
                    </span>
                    <div className="flex items-center gap-2">
                      <Badge
                        tone={
                          turn.responseMode === "openai"
                            ? "green"
                            : turn.responseMode === "fallback"
                              ? "amber"
                              : "neutral"
                        }
                      >
                        {turn.responseMode}
                      </Badge>
                      <Link
                        href={`/insights/ask/${turn.responseId}`}
                        className="font-mono text-[11px] underline"
                        style={{ color: "var(--text-2)" }}
                      >
                        Kanıt detayı →
                      </Link>
                    </div>
                  </div>
                  <div className="whitespace-pre-wrap leading-relaxed" style={{ color: "var(--text-2)" }}>
                    {turn.answerMd}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {activeToolEvidence.length > 0 ? (
          <div
            className="mb-4 rounded border p-3 text-xs"
            style={{
              borderColor: "var(--line)",
              background: "var(--surface-2)",
              color: "var(--text-1)",
            }}
          >
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <span className="font-semibold">Salt-Okunur SQL Araç Kanıt İzi ({activeToolEvidence.length} sorgu çalıştırıldı)</span>
              <Badge tone="green">SELECT-only parametrik kanıt</Badge>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {activeToolEvidence.map((ev) => (
                <div
                  key={`${ev.tool}-${ev.table}`}
                  className="rounded border p-2"
                  style={{ borderColor: "var(--line-faint)", background: "var(--surface-1)" }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono font-semibold">{ev.tool}</span>
                    <Link href={ev.sourceHref} className="font-mono text-[11px] underline" style={{ color: "var(--info)" }}>
                      {ev.sourceHref} →
                    </Link>
                  </div>
                  <div className="mt-1 font-mono text-[11px]" style={{ color: "var(--text-3)" }}>
                    Tablo: {ev.table} · Kayıt: {ev.count} · Baz: {ev.asOf}
                  </div>
                  <div className="mt-1" style={{ color: "var(--text-2)" }}>
                    {ev.headline}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <form action={askQuestionAction} className="space-y-3">
          {selectedConversation ? (
            <input type="hidden" name="conversationId" value={selectedConversation.id} />
          ) : null}
          <textarea
            name="question"
            required
            rows={4}
            className="field-control w-full resize-y p-3"
            placeholder={
              selectedConversation
                ? "Bu oturuma takip sorusu yazın (örn. Peki 30 günlük ufukta ne kadar?)..."
                : "Önümüzdeki 30 günde çek ve kredi yükü ne kadar?"
            }
          />
          <div className="flex flex-wrap gap-2">
            <button className="button-accent px-3 py-2">
              {selectedConversation ? "Oturumda Cevapla" : "Cevapla"}
            </button>
            <label className="button-ghost px-3 py-2">
              <input name="forceDeterministic" type="checkbox" /> Yalnız deterministik cevap
            </label>
          </div>
        </form>
        <div className="mt-3 flex flex-wrap gap-2">
          {samples.map((q) => (
            <form key={q} action={askQuestionAction}>
              {selectedConversation ? (
                <input type="hidden" name="conversationId" value={selectedConversation.id} />
              ) : null}
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
          <div className="mt-3 border border-dashed p-1" style={{ borderColor: "var(--line)" }}>
            <EmptyState>
              Henüz kaydedilmiş çok-turlu asistan oturumu bulunmuyor. Yukarıdan ilk sorunuzu sorduğunuzda kalıcı oturum otomatik oluşturulur.
            </EmptyState>
          </div>
        ) : (
          <ul className="mt-3 flex flex-col gap-1 border-t pt-2" style={{ borderColor: "var(--line)" }}>
            {conversations.map((c) => {
              const isSelected = selectedConversation?.id === c.id;
              return (
                <li
                  key={c.id}
                  className="flex flex-wrap items-center justify-between gap-2 border-b py-1.5 px-2 text-xs last:border-0"
                  style={{
                    borderColor: "var(--line-faint)",
                    background: isSelected ? "var(--surface-2)" : "transparent",
                  }}
                >
                  <Link
                    href={`/insights/ask?conversationId=${encodeURIComponent(c.id)}`}
                    className="font-medium underline-offset-2 hover:underline"
                    style={{ color: "var(--text-1)" }}
                  >
                    {c.title}
                  </Link>
                  <span className="flex items-center gap-2 font-mono text-[11px]" style={{ color: "var(--text-3)" }}>
                    <Badge tone={c.status === "active" ? "green" : "neutral"}>
                      {c.status}
                    </Badge>
                    <span>{`${c.turnCount} tur · ${c.updatedAt}`}</span>
                    <Link
                      href={`/insights/ask?conversationId=${encodeURIComponent(c.id)}`}
                      className="rounded border px-2 py-0.5 font-mono text-[10px]"
                      style={{
                        borderColor: "var(--line)",
                        background: "var(--surface-1)",
                        color: "var(--text-1)",
                      }}
                    >
                      {isSelected ? "Açık" : "Devam et →"}
                    </Link>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      <Panel
        title="TELEGRAM CFO ASİSTANI — HIZLI CARİ / ALACAK / BORÇ SORGULAMA"
        subtitle="Salt-okunur Telegram bot motoru (assistant.ts): kur çevrimi yapmadan TRY toplamlarını ve cari hesap ekstresini anında yanıtlar."
      >
        <form method="get" action="/insights/ask" className="flex flex-wrap gap-2">
          {selectedConversation ? (
            <input type="hidden" name="conversationId" value={selectedConversation.id} />
          ) : null}
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
              href={`/insights/ask?tg=${encodeURIComponent(cmd)}${
                selectedConversation ? `&conversationId=${encodeURIComponent(selectedConversation.id)}` : ""
              }`}
              className="border px-2 py-1 font-mono text-[11px]"
              style={{
                borderColor: "var(--line)",
                background: "var(--surface-2)",
                color: "var(--text-2)",
              }}
            >
              {cmd}
            </a>
          ))}
        </div>
        <div
          className="mt-3 border p-3 font-mono text-xs"
          style={{
            borderColor: "var(--line)",
            background: "var(--surface-2)",
            color: "var(--text-1)",
          }}
        >
          <div className="mb-1 flex items-center justify-between text-[10px] uppercase" style={{ color: "var(--text-3)" }}>
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
              className="grid gap-2 border-b py-2 text-sm sm:grid-cols-[1fr_auto_auto]"
              style={{ borderColor: "var(--line-faint)", color: "var(--text-1)" }}
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
              <span style={{ color: "var(--text-3)" }}>{r.created_at} →</span>
            </Link>
          ))
        )}
      </Panel>
    </>
  );
}
