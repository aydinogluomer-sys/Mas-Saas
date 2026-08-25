// AŞAMA 09 — telemetri uyarılarının GERÇEKTEN bir operatör kanalına ulaşması.
//
// ═══ NEDEN BU DOSYA VAR ═══
//
// Faz 12 altı fail-closed uyarıyı doğru kuruyordu ama teslimatı yoktu: `pnpm ops:telemetry`
// stdout'a yazıp exit 1 veriyordu, o kadar. Rehber §14 bunu açıkça reddediyor:
//
//     "Ama 'script exit 1 veriyor' tek başına production alerting sayılmaz."
//
// Kimsenin bakmadığı bir terminalde kırmızı bir satır, alarm değildir. Bu modül uyarıyı
// KALICI ve MAKİNE OKUNUR bir yere yazar (JSONL alert log) ve — yapılandırıldıysa —
// Telegram/e-posta gibi ek kanallara da iletir.
//
// ═══ NEDEN BİRİNCİL KANAL YEREL DOSYA ═══
//
// Rehber §14 kabul edilebilir kanalları sayarken ilk sırada "local persistent alert log" diyor.
// Bu tesadüf değil: bu makinede TELEGRAM_BOT_TOKEN/EMAIL_API_URL tanımlı DEĞİL ve ortamda dışa
// ağ yok. Ağ kanalını birincil yapmak, alarmın her koşuda "iletilemedi" demesi anlamına gelirdi —
// yani hiç alarm olmaması. Yerel dosya her zaman vardır, atomik append'tir, `jq`/`grep` ile
// okunur ve bir sonraki aşamanın (Aşama 19 real-use telemetry) girdisi olabilir.
//
// ═══ TESLİMAT BAŞARISIZLIĞI DA BİR SİNYALDİR ═══
//
// Rehber §14 kabul kriteri: "Alarm delivery başarısızlığı ayrıca görünür." Sessizce yutulan bir
// gönderim hatası, bu aşamanın var olma sebebinin ta kendisidir — alarm borusunun kırıldığını
// kimse fark etmez ve sistem sağlıklı görünür. Bu yüzden HER kanal denemesinin sonucu
// (başarılı ya da başarısız) log'a `kind:"delivery"` satırı olarak yazılır ve rapor
// `allDelivered=false` döner; çağıran script bunu AYRI bir çıkış koduna (2) çevirir.
//
// ═══ SIR SIZDIRMAMA ═══
//
// Rehber §14 kabul kriteri: "Alert çıktısında secret yok." İki katmanlı korunuyor:
//   1. `redactSecrets()` — bağlantı dizesi parolası, `Bearer …`, `/bot<token>/`, `token=…`
//      gibi ŞEKİLLERİ maskeler (bilinmeyen sırlar için).
//   2. `redactValues` — çağıran, ortamda GERÇEKTEN tanımlı olan değerleri geçirir; tam eşleşme
//      ile maskelenir (şekil tanımayan sırlar için). İkisi birlikte, "şeklini bilmediğim ama
//      değerini bildiğim" ve "değerini bilmediğim ama şeklini bildiğim" sızıntıyı kapatır.
//
// Bu modül `process.env`'e HİÇ dokunmaz ve ağa HİÇ çıkmaz: yol/kanal/sır listesi parametredir,
// ağ çıkışı `@/lib/reminders/transport`'un incelenmiş seam'inden geçer. Faz 15 sınır kapısı
// (`pnpm boundary:verify`) tam olarak bunu iddia ediyor.

import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { transportFor, type Transport } from "@/lib/reminders/transport";

/** Rehber §31 sınıflandırması. Her uyarı bir severity TAŞIMAK zorunda — "önemli mi" sorusunun
 *  cevabı alarmın kendisiyle birlikte gelmezse, alarmı okuyan kişi onu her seferinde yeniden
 *  türetir ve er geç yanlış türetir. */
export type AlertSeverity = "P0" | "P1" | "P2";

/** Uyarıya dönüşmüş tek bir telemetri sinyali. */
export interface TelemetryAlert {
  signal: string;
  /** RUNTIME | DB | APP — snapshot'ın stdout bölümleriyle aynı. */
  section: string;
  value: string;
  /** İnsan okunur eşik açıklaması ("eşik 36s"). Sayı değil metin: her sinyalin eşiği farklı tipte. */
  threshold: string;
  severity: AlertSeverity;
  message: string;
}

export type AlertChannel = "log" | "telegram" | "email";

/** Bir kanala yapılan tek deneme. `attempted=false` = kanal yapılandırılmadığı için hiç denenmedi
 *  (bu bir BAŞARISIZLIK değildir; denenip düşmekten ayrı tutulur). */
export interface ChannelOutcome {
  channel: AlertChannel;
  attempted: boolean;
  ok: boolean;
  error?: string;
}

export interface AlertLogEntry {
  ts: string;
  runId: string;
  kind: "alert" | "heartbeat" | "delivery";
  message: string;
  signal?: string;
  section?: string;
  severity?: AlertSeverity;
  value?: string;
  threshold?: string;
  channel?: AlertChannel;
  ok?: boolean;
  error?: string;
}

export interface DeliveryReport {
  runId: string;
  alertCount: number;
  logPath: string;
  outcomes: ChannelOutcome[];
  /** Denenen HER kanal başarılıysa true. Denenmemiş kanal bunu bozmaz. */
  allDelivered: boolean;
}

/* ── sır maskeleme ───────────────────────────────────────────────────────────────────────── */

/** Bilinen sır ŞEKİLLERİ. Sıra önemli: bağlantı dizesi önce, çünkü içinde `:` ve `@` var ve
 *  daha genel anahtar=değer kalıbı onu yarım maskeleyebilir. */
const SECRET_SHAPES: ReadonlyArray<{ re: RegExp; to: string }> = Object.freeze([
  // postgres://kullanici:PAROLA@host/db  →  postgres://kullanici:***@host/db
  { re: /([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s@/]*@/gi, to: "$1:***@" },
  // https://api.telegram.org/bot123456:ABC…/sendMessage  →  /bot***/
  { re: /\/bot\d+:[A-Za-z0-9_-]+/g, to: "/bot***" },
  // Authorization: Bearer eyJ…  →  Bearer ***
  { re: /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, to: "Bearer ***" },
  // token=… / password: … / api_key=… / chat_id=…
  {
    re: /\b(bot_?token|api[_-]?key|apikey|access[_-]?token|token|password|passwd|secret|chat[_-]?id)\b(\s*[:=]\s*)("?)[^\s"',;]+\3/gi,
    to: "$1$2***",
  },
]);

/**
 * Bir metni operatör kanalına yazmadan önce maskeler.
 *
 * `extraValues`: ortamda gerçekten tanımlı olan sır DEĞERLERİ. Şekil tabanlı kurallar bir sırrı
 * tanıyamazsa (ör. serbest metin içinde çıplak bir chat id), tam-değer eşleşmesi yakalar.
 * Çok kısa değerler (<4 karakter) BİLEREK atlanır: "1" gibi bir değeri maskelemek metnin her
 * yerini yıldıza çevirir ve alarmı okunmaz kılar — okunmayan alarm da alarm değildir.
 */
export function redactSecrets(text: string, extraValues: readonly string[] = []): string {
  let out = text;
  for (const { re, to } of SECRET_SHAPES) out = out.replace(re, to);
  for (const raw of extraValues) {
    const v = raw?.trim();
    if (!v || v.length < 4) continue;
    out = out.split(v).join("***");
  }
  return out;
}

/**
 * Maskelemenin kaçırdığı bir sır kaldı mı? Doğrulama kapısı (`ops:telemetry:alerting:verify`)
 * alert log'unun ve stdout'un TAMAMINI bundan geçirir.
 *
 * DİKKAT — bu `redactSecrets`'ın aynadaki hâli DEĞİL, bilerek daha PARANOYAK: maskelenmiş
 * çıktıda `postgres://user:***@host` gibi kalıntılar kalabildiği için, "maskelenmiş" formu
 * (`***`) sır saymaz ama maskelenmemiş her şekli sır sayar.
 */
export function looksLikeSecret(text: string, extraValues: readonly string[] = []): string[] {
  const hits: string[] = [];
  const probes: ReadonlyArray<{ name: string; re: RegExp }> = [
    { name: "bağlantı dizesi parolası", re: /[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:(?!\*\*\*)[^\s@/]+@/i },
    { name: "telegram bot token", re: /\/bot\d+:(?!\*\*\*)[A-Za-z0-9_-]{10,}/ },
    { name: "Bearer token", re: /\bBearer\s+(?!\*\*\*)[A-Za-z0-9._~+/=-]{8,}/i },
    {
      name: "anahtar=değer sırrı",
      re: /\b(bot_?token|api[_-]?key|apikey|access[_-]?token|token|password|passwd|secret|chat[_-]?id)\b\s*[:=]\s*"?(?!\*\*\*)[^\s"',;]{4,}/i,
    },
  ];
  for (const p of probes) if (p.re.test(text)) hits.push(p.name);
  for (const raw of extraValues) {
    const v = raw?.trim();
    if (v && v.length >= 4 && text.includes(v)) hits.push(`yapılandırılmış sır değeri açıkta`);
  }
  return hits;
}

/* ── kanal listesi ───────────────────────────────────────────────────────────────────────── */

const KNOWN_CHANNELS: readonly AlertChannel[] = Object.freeze(["log", "telegram", "email"]);

/**
 * `MAS_ALERT_CHANNELS` değerini ayrıştırır.
 *
 * "log" HER ZAMAN listededir, kullanıcı yazmasa da: yerel kalıcı log bu tasarımın fail-safe
 * tabanı ve onu kapatabilmek, alarmı sessizce kapatabilmek demektir.
 *
 * Bilinmeyen bir jeton SESSİZCE ATILMAZ, `unknown` içinde geri döner. "telegran" yazım hatası
 * yüzünden teslimatın kapanması, bu aşamanın önlemek için var olduğu hatanın ta kendisidir.
 */
export function parseAlertChannels(raw: string | undefined): { channels: AlertChannel[]; unknown: string[] } {
  const tokens = (raw ?? "").split(",").map((t) => t.trim().toLowerCase()).filter((t) => t !== "");
  const unknown: string[] = [];
  const channels: AlertChannel[] = ["log"];
  for (const t of tokens) {
    if (!KNOWN_CHANNELS.includes(t as AlertChannel)) { unknown.push(t); continue; }
    if (!channels.includes(t as AlertChannel)) channels.push(t as AlertChannel);
  }
  return { channels, unknown };
}

/* ── biçimlendirme ───────────────────────────────────────────────────────────────────────── */

/** Ağ kanalına (Telegram/e-posta) gidecek tek gövde. Kısa tutulur: bir bildirimde okunmalı. */
export function formatAlertMessage(runId: string, alerts: readonly TelemetryAlert[]): string {
  if (alerts.length === 0) return `MAS Nakit Radar telemetri: ALL CLEAR (run ${runId})`;
  const worst = alerts.some((a) => a.severity === "P0") ? "P0"
    : alerts.some((a) => a.severity === "P1") ? "P1" : "P2";
  const lines = alerts.map((a) => `- [${a.severity}] ${a.signal} = ${a.value} (${a.threshold})`);
  return [
    `MAS Nakit Radar TELEMETRI ALARMI — ${alerts.length} sinyal, en yuksek ${worst}`,
    `run ${runId}`,
    ...lines,
  ].join("\n");
}

/** Uyarıları log satırlarına çevirir. Saf: dosya sistemi yok, test edilebilir. */
export function buildLogEntries(
  runId: string,
  alerts: readonly TelemetryAlert[],
  at: Date,
  redactValues: readonly string[] = [],
): AlertLogEntry[] {
  const ts = at.toISOString();
  if (alerts.length === 0) {
    return [{
      ts, runId, kind: "heartbeat",
      message: redactSecrets("telemetri tamam — uyaran sinyal yok", redactValues),
    }];
  }
  return alerts.map((a) => ({
    ts, runId, kind: "alert" as const,
    signal: a.signal,
    section: a.section,
    severity: a.severity,
    value: redactSecrets(a.value, redactValues),
    threshold: redactSecrets(a.threshold, redactValues),
    message: redactSecrets(a.message, redactValues),
  }));
}

/* ── kalıcı log ──────────────────────────────────────────────────────────────────────────── */

/**
 * JSONL append. `daily-runs.jsonl` (Aşama 07) ile AYNI desen — yeni bir kayıt formatı
 * icat edilmiyor, çünkü iki farklı operasyon günlüğü formatı iki farklı okuyucu demektir.
 *
 * Fırlatabilir: yazılamayan bir alert log'u SESSİZCE geçilemez, çağıran onu bir teslimat
 * başarısızlığı olarak raporlar.
 */
export function appendAlertLog(logPath: string, entries: readonly AlertLogEntry[]): void {
  if (entries.length === 0) return;
  mkdirSync(path.dirname(path.resolve(logPath)), { recursive: true });
  appendFileSync(logPath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
}

/* ── teslimat ────────────────────────────────────────────────────────────────────────────── */

export interface DeliverOptions {
  runId: string;
  alerts: readonly TelemetryAlert[];
  logPath: string;
  /** "log" dışındakiler yalnız açıkça istendiğinde denenir. */
  channels: readonly AlertChannel[];
  /** Testler/doğrulama için enjekte edilebilir taşıyıcılar (mockTransport). */
  transports?: Partial<Record<Exclude<AlertChannel, "log">, Transport>>;
  redactValues?: readonly string[];
  now?: Date;
  /** Uyarı yokken de bir "heartbeat" satırı yaz. Varsayılan: evet — sessiz bir log,
   *  "sorun yok" ile "toplayıcı çalışmadı"yı ayırt edemez. */
  heartbeat?: boolean;
}

export async function deliverAlerts(opts: DeliverOptions): Promise<DeliveryReport> {
  const at = opts.now ?? new Date();
  const redactValues = opts.redactValues ?? [];
  const heartbeat = opts.heartbeat ?? true;
  const outcomes: ChannelOutcome[] = [];

  const entries = opts.alerts.length === 0 && !heartbeat
    ? []
    : buildLogEntries(opts.runId, opts.alerts, at, redactValues);

  /* 1 — birincil kanal: yerel kalıcı log. */
  try {
    appendAlertLog(opts.logPath, entries);
    outcomes.push({ channel: "log", attempted: true, ok: true });
  } catch (e) {
    outcomes.push({
      channel: "log", attempted: true, ok: false,
      error: redactSecrets((e as Error).message ?? String(e), redactValues),
    });
  }

  /* 2 — ek kanallar. Yalnız GERÇEK bir uyarı varken denenir: her koşuda "her şey yolunda"
   *     bildirimi göndermek, kanalı sessize alınacak hâle getirir. */
  const extra = opts.channels.filter((c): c is Exclude<AlertChannel, "log"> => c !== "log");
  const body = redactSecrets(formatAlertMessage(opts.runId, opts.alerts), redactValues);
  for (const channel of extra) {
    if (opts.alerts.length === 0) {
      outcomes.push({ channel, attempted: false, ok: true });
      continue;
    }
    const transport = opts.transports?.[channel] ?? transportFor(channel);
    try {
      const res = await transport.send(body);
      outcomes.push({
        channel, attempted: true, ok: res.ok,
        error: res.ok ? undefined : redactSecrets(res.error ?? "bilinmeyen hata", redactValues),
      });
    } catch (e) {
      // Taşıyıcı sözleşmesi fırlatmamayı vaat ediyor; yine de fırlatırsa bu bir teslimat
      // başarısızlığıdır, bir çökme değil.
      outcomes.push({
        channel, attempted: true, ok: false,
        error: redactSecrets((e as Error).message ?? String(e), redactValues),
      });
    }
  }

  /* 3 — teslimat sonuçlarının KENDİSİ log'a yazılır. Rehber §14: teslimat başarısızlığı
   *     ayrıca görünür olmalı; sonucu yalnız süreç çıkışında bırakmak "ayrıca görünür" değil. */
  const deliveryRows: AlertLogEntry[] = outcomes.map((o) => ({
    ts: at.toISOString(), runId: opts.runId, kind: "delivery" as const,
    channel: o.channel, ok: o.ok,
    message: o.attempted
      ? `kanal ${o.channel}: ${o.ok ? "iletildi" : "İLETİLEMEDİ"}`
      : `kanal ${o.channel}: denenmedi (uyarı yok)`,
    error: o.error,
  }));
  try {
    appendAlertLog(opts.logPath, deliveryRows);
  } catch {
    // Log zaten yazılamıyor; bunu 1. adımdaki outcome hâlihazırda ok:false olarak taşıyor.
  }

  const allDelivered = outcomes.every((o) => !o.attempted || o.ok);
  return { runId: opts.runId, alertCount: opts.alerts.length, logPath: opts.logPath, outcomes, allDelivered };
}
