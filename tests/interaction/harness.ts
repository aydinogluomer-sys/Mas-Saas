/**
 * ETKİLEŞİM KAPISI — ortak altyapı.
 *
 * ═══ BU KAPININ CEVAPLADIĞI SORU ═══
 *
 * "UI'da kullanıcıya gösterilen bir kontrole tıklandığında, vaat ettiği iş GERÇEKTEN oldu mu?"
 *
 * Ve bunun cevabı olarak KABUL EDİLMEYEN şeyler (hepsi bu repoda daha önce "PASS" sayılmıştı,
 * bkz. `.testsprite/button-action-audit.mjs` — o script bir aksiyonu yalnız "konsola hata
 * düşmedi" diye geçmiş sayıyor):
 *
 *   · butonda onClick/formAction bulunması        → kod var demek, iş oldu demek değil
 *   · rotanın 200 dönmesi                          → sunucu cevap verdi demek
 *   · toast görünmesi                              → istemci bir şey çizdi demek
 *   · URL'nin değişmesi                            → gezinme oldu demek
 *   · form submit'in hata vermemesi                → sessiz başarısızlığın ta kendisi
 *   · DOM'un değişmesi                             → optimistic render buna yeter
 *
 * KABUL EDİLEN: mutation'lar için VERİTABANINDAN, uygulamadan BAĞIMSIZ bir bağlantıyla okunan
 * before/after farkı; ayrıca kalıcılık (reload) ve — varsa — audit izi.
 *
 * ═══ NEDEN AYRI BİR VERİTABANI BAĞLANTISI ═══
 *
 * "Sayfayı yenileyince hâlâ ödendi görünüyor" bir kanıt gibi durur ama değildir: aynı önbelleği,
 * aynı sorguyu, aynı hatayı ikinci kez okumuş olabiliriz. `db()` uygulamanın havuzunu DEĞİL, ayrı
 * bir `pg.Client` açar ve tabloyu doğrudan okur. Uygulama satırı yazmadıysa burada görünmez.
 *
 * Bağlantı OWNER (postgres) olarak açılır — bilerek. Katman rolüyle okumak RLS yüzünden yazılmış
 * bir satırı GÖRMEYEBİLİR ve test "yazılmamış" diye yanlış FAIL verirdi. Doğrulayıcının görüşü
 * uygulamanınkinden geniş olmalı; dar olmamalı.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { ROLE_STATE_FILES, statePathFor, type SeededRole } from "../visual/global-setup";
import { databaseNameFromUrl, isDisposableDatabaseName } from "../../scripts/db/owner-url";

export { ROLE_STATE_FILES, statePathFor };
export type { SeededRole };

export const ALL_ROLES = Object.keys(ROLE_STATE_FILES) as SeededRole[];

/**
 * Doğrulayıcının bağlantı dizesi.
 *
 * `MAS_E2E_DATABASE_URL` uygulamanın konuştuğu veritabanını gösterir; doğrulama da AYNI
 * veritabanına bakmak zorundadır, yoksa "yazılmamış" sonucu anlamsız olur. Owner'a yükseltme
 * yalnız KULLANICI ADINDA yapılır: aynı host/port/db, farklı rol.
 */
function verifierUrl(): string {
  const raw = process.env.MAS_E2E_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
  if (!raw) {
    throw new Error(
      "MAS_E2E_DATABASE_URL tanımlı değil. Etkileşim kapısı DB'den before/after okur; " +
        "hedefi tahmin etmesi kasıtlı olarak engellendi.",
    );
  }
  const name = databaseNameFromUrl(raw);
  // Bu kapı satır YAZAN akışları tetikler (ödendi, arşivle, oluştur…). Hedefin harcanabilir
  // olduğunu ADIYLA söylemesi şart — `scripts/db/owner-url.ts` ile aynı sözlük, aynı reflek.
  if (!isDisposableDatabaseName(name)) {
    throw new Error(
      `GÜVENLİK DURDURMASI: '${name ?? "(okunamadı)"}' disposable görünmüyor. ` +
        "Etkileşim kapısı gerçek mutation tetikler; gerçek veritabanına ASLA çalıştırılmaz.",
    );
  }
  const url = new URL(raw);
  if (process.env.MAS_E2E_VERIFIER_URL) return process.env.MAS_E2E_VERIFIER_URL;
  url.username = "postgres";
  url.password = "postgres";
  return url.toString();
}

/** Tek seferlik, kısa ömürlü doğrulama bağlantısı. Havuz YOK: testler sıralı çalışır. */
export async function db<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: verifierUrl() });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Tek satırlık skaler okuma — before/after karşılaştırmalarının çoğu bu biçimde. */
export async function scalar<T = string | null>(sql: string, params: unknown[] = []): Promise<T> {
  return db(async (c) => {
    const r = await c.query(sql, params);
    if (r.rowCount === 0) return null as T;
    return Object.values(r.rows[0])[0] as T;
  });
}

export async function rows<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return db(async (c) => (await c.query<T>(sql, params)).rows);
}

/* ── Kanıt kaydı ─────────────────────────────────────────────────────────────────────────── */

export type Verdict = "PASS" | "FAIL" | "EXPECTED_DISABLED" | "EXTERNAL_NOT_LIVE_VERIFIABLE" | "UNTESTED";

export interface Evidence {
  /** Envanterle eşleşen kimlik: rota + kontrol imzası. */
  route: string;
  control: string;
  role: SeededRole | "n/a";
  verdict: Verdict;
  /** Neyin kanıtlandığı — "kod var" değil, ÖLÇÜLEN şey. */
  proof: string[];
  error?: string;
}

const EVIDENCE: Evidence[] = [];

export function record(e: Evidence): void {
  EVIDENCE.push(e);
}

export function evidenceSoFar(): readonly Evidence[] {
  return EVIDENCE;
}

/* ── Tarayıcı yardımcıları ───────────────────────────────────────────────────────────────── */

export interface RoleSession {
  context: BrowserContext;
  page: Page;
  /** Bu sayfada BİRİKEN istemci hataları — testin sonunda sıfır olmalı. */
  clientErrors: string[];
  /** Bu sayfanın gördüğü 5xx yanıtlar. */
  serverErrors: string[];
}

/**
 * Bir rol için oturum aç.
 *
 * storageState `tests/visual/global-setup.ts`'in GERÇEK /login formundan ürettiği çerezdir —
 * elle yazılmış session satırı değil, QA bypass değil. Bypass ayrıca reddedilir (aşağıda),
 * çünkü bu paketin bütün konusu rol farkıdır ve bypass tek bir hesaba düzleştirirdi.
 */
export async function openAs(browser: import("@playwright/test").Browser, role: SeededRole): Promise<RoleSession> {
  if (process.env.MAS_QA_BYPASS_AUTH) {
    throw new Error("MAS_QA_BYPASS_AUTH ayarlı — etkileşim kapısı rol farkını ölçer, bypass ile anlamsızdır.");
  }
  const context = await browser.newContext({
    storageState: statePathFor(role),
    viewport: { width: 1440, height: 950 },
  });
  const page = await context.newPage();
  const clientErrors: string[] = [];
  const serverErrors: string[] = [];
  page.on("pageerror", (e) => clientErrors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") clientErrors.push(`console: ${m.text()}`);
  });
  page.on("response", (r) => {
    if (r.status() >= 500) serverErrors.push(`${r.status()} ${new URL(r.url()).pathname}`);
  });
  return { context, page, clientErrors, serverErrors };
}

/** Oturumun temiz kapandığını doğrula: sıfır istemci hatası, sıfır 5xx. */
export function assertClean(session: RoleSession, where: string): void {
  const client = [...new Set(session.clientErrors)];
  const server = [...new Set(session.serverErrors)];
  expect(client, `${where}: istemci hatası (console.error / pageerror) sıfır olmalı`).toEqual([]);
  expect(server, `${where}: HTTP 5xx sıfır olmalı`).toEqual([]);
}

/**
 * Sunucu aksiyonunun BİTTİĞİNİ bekle.
 *
 * Next server action'ı bir POST'tur ve ardından RSC yükü gelir. `waitForLoadState("networkidle")`
 * tek başına yetmez: aksiyon henüz BAŞLAMADAN "idle" olabilir ve test, mutation'dan ÖNCEKİ
 * durumu okur — bu tam olarak yanlış-yeşil üretir. Bu yüzden önce POST yanıtı beklenir.
 */
export async function clickAndSettle(page: Page, click: () => Promise<void>): Promise<void> {
  const post = page.waitForResponse((r) => r.request().method() === "POST", { timeout: 30_000 }).catch(() => null);
  await click();
  await post;
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
}

/** Sayfayı gerçekten yeniden yükle (bellekteki iyimser durumu değil, sunucudan geleni ölç). */
export async function hardReload(page: Page): Promise<void> {
  await page.reload({ waitUntil: "networkidle" });
}

/* ── Envanter köprüsü ────────────────────────────────────────────────────────────────────── */

export interface RuntimeControlRow {
  route: string;
  role: SeededRole;
  signature: string;
  label: string;
  tag: string;
  actionId: string | null;
  href: string | null;
  disabled: boolean;
  disabledReason: string | null;
  count: number;
}

export interface RuntimeInventory {
  summary: { distinctRouteControls: number; problems: number };
  controls: RuntimeControlRow[];
}

const INVENTORY_PATH = path.join(process.cwd(), "docs", "interaction-audit", "runtime-inventory.json");

export function loadRuntimeInventory(): RuntimeInventory {
  try {
    return JSON.parse(readFileSync(INVENTORY_PATH, "utf8")) as RuntimeInventory;
  } catch {
    throw new Error(
      `Çalışma zamanı envanteri yok: ${INVENTORY_PATH}\n` +
        "Önce `pnpm interaction:crawl` çalıştırın — kapı, KEŞFEDİLEN kontrol kümesini bilmeden " +
        "'hepsi test edildi' diyemez.",
    );
  }
}

/** Aynı kontrolün bütün rollerdeki hâli — yetki matrisi testleri bunu kullanır. */
export function byRouteAndLabel(inv: RuntimeInventory, route: string, labelMatch: RegExp): RuntimeControlRow[] {
  return inv.controls.filter((c) => c.route === route && labelMatch.test(c.label));
}

let cachedInventory: RuntimeInventory | null = null;

/**
 * (rota, etiket) → envanterdeki KONTROL İMZASI.
 *
 * ═══ NEDEN İMZA ELLE YAZILMIYOR ═══
 *
 * İmza, Next'in server action kimliğini içerir: `button||ödendi|$ACTION_ID_4057141eb70f…`.
 * O kimlik derlemeye özgüdür — kod değişince değişir. Teste elle yazılsaydı, ilk kod
 * değişikliğinde kanıt satırı envanterdeki hiçbir kontrolle EŞLEŞMEZ ve kapı sessizce
 * "UNTESTED" derdi: test yeşil, kapsam sıfır. Bu, kapının yakalaması gereken şeyin ta kendisi.
 *
 * Bu yüzden imza HER KOŞUDA aynı taramadan okunur; tarama ve testler aynı derlemeye baktığı
 * sürece eşleşme garantidir.
 */
/**
 * DURUMA BAĞLI kontrollerin imzası — canlı DOM'dan, tarayıcının gördüğü gibi.
 *
 * ═══ NEDEN AYRI BİR YOL GEREKTİ ═══
 *
 * Bazı kontroller yalnız belirli bir veri durumunda VAR OLUR: "geri al" sadece ÖDENMİŞ bir
 * örnekte, "kısmi" sadece tutarı bilinen bir örnekte render edilir. Tarama, fixture'da o durum
 * yokken bu kontrolleri GÖREMEZ — kapının "ölü kural" uyarısı tam olarak bunu bildirdi
 * (payments/mark-unpaid, payments/mark-partial hiçbir kontrolle eşleşmedi).
 *
 * Üç seçenek vardı ve ikisi yanlıştı:
 *   · İmzayı teste elle yazmak — server action kimliği derlemeye özgü; ilk kod değişikliğinde
 *     kanıt hiçbir şeyle eşleşmez ve kapı sessizce UNTESTED der.
 *   · Kontrolü "kapsam dışı" saymak — ürünün en tersinir, en kritik akışını (ödemeyi geri alma)
 *     denetim dışında bırakmak olurdu.
 *   · SEÇİLEN: test o durumu KENDİSİ üretir (önce ödendi işaretler), sonra imzayı canlı DOM'dan
 *     tarayıcının kullandığı formülle çıkarır. Üretilen imza, o durum fixture'da olsaydı
 *     taramanın yazacağı imzanın AYNISIDIR.
 */
export async function signatureFromDom(page: Page, buttonLabel: string): Promise<string> {
  return page.evaluate((label: string) => {
    const clean = (s: string | null): string => (s ?? "").replace(/\s+/g, " ").trim();
    const node = Array.from(document.querySelectorAll("button")).find((b) => clean(b.textContent) === label);
    if (!node) throw new Error(`DOM'da "${label}" düğmesi yok — imza çıkarılamaz`);
    const form = node.closest("form");
    let actionId: string | null = null;
    if (form) {
      const hidden = form.querySelector('input[name^="$ACTION_ID_"]');
      if (hidden) actionId = hidden.getAttribute("name");
      else if (form.querySelector('input[name="$ACTION_REF_1"]')) actionId = "$ACTION_REF_1";
    }
    const type = node.getAttribute("type") ?? "";
    return `button|${type}|${label}|${actionId ?? node.getAttribute("href") ?? ""}`;
  }, buttonLabel);
}

export function signatureFor(route: string, label: string): string {
  cachedInventory ??= loadRuntimeInventory();
  const hit = cachedInventory.controls.find((c) => c.route === route && c.label === label);
  if (!hit) {
    throw new Error(
      `Envanterde (${route}, "${label}") kontrolü yok. Tarama bu kontrolü GÖRMEDİ — ` +
        "ya etiket değişti ya da kontrol o rotada render edilmiyor. Kanıt uydurulmaz.",
    );
  }
  return hit.signature;
}

export { test, expect };
