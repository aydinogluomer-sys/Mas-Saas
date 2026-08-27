/**
 * ETKİLEŞİM KAPSAM KAPISI — "test edilmeyen kontrol" sessizce kalamaz.
 *
 * ═══ NE YAPAR ═══
 *
 * Üç girdi alır ve tek bir yargı üretir:
 *
 *   1. KEŞFEDİLEN   docs/interaction-audit/runtime-inventory.json
 *                   Çalışan production sunucusunda, beş rolle, GERÇEKTEN görülen kontroller.
 *   2. SÖZLEŞME     tests/interaction/manifest.ts
 *                   Her kontrolün hangi sınıfla ve hangi testle doğrulandığı.
 *   3. SONUÇ        docs/interaction-audit/evidence.json  (Playwright paketi yazar)
 *                   Gerçekten koşan doğrulamaların yargıları.
 *
 * ═══ NEDEN ÜÇÜ BİRDEN ═══
 *
 * İkisi eksik olduğunda üretilen yanılsamalar farklıdır ve üçü de bu repoda görüldü:
 *
 *   Yalnız sonuç        "42 test geçti" — 42'nin 574'ün neresi olduğu bilinmez.
 *   Keşif + sonuç       Kapsam ölçülür ama "nasıl doğrulandı" kaydı yoktur; bir kontrol
 *                       "test edildi" sayılırken aslında yalnız 200 dönüp dönmediğine bakılmış
 *                       olabilir (bkz. `.testsprite/button-action-audit.mjs`).
 *   Keşif + sözleşme    Sözleşme yazılır, test yazılmaz. Kağıt üstünde kapsam %100.
 *
 * ═══ KIRMIZI VERME KURALI ═══
 *
 *   UNTESTED > 0   → FAIL. İstisnası yok. Dış servise bağlı kontroller bile açık bir
 *                    allowlist satırıyla (gerekçe + karar sahibi + kanıt + mock testi)
 *                    EXTERNAL_NOT_LIVE_VERIFIABLE'a taşınmak zorundadır; "unuttuk" bir durum değil.
 *   FAIL > 0       → FAIL.
 *   Ölü kural      → uyarı olarak raporlanır (manifesto gerçeğe değil geçmişe ait olmasın).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { EXTERNAL_ALLOWLIST, RULES, NAVIGATION_FALLBACK, ruleFor, type VerificationClass } from "../../tests/interaction/manifest";
import { evaluateGate, type GateBaseline, type GateMode } from "./interaction-gate-rules";

const OUT_DIR = path.join(process.cwd(), "docs", "interaction-audit");
const INVENTORY = path.join(OUT_DIR, "runtime-inventory.json");
const BASELINE_FILE = path.join(OUT_DIR, "baseline.json");
const BASELINE_REPO_PATH = "docs/interaction-audit/baseline.json";

/**
 * Kabul edilmiş borç tavanı.
 *
 * Dosya KÜÇÜK ve elle okunabilir olmalı — büyük runtime kanıt dosyaları baseline olamaz, çünkü
 * bir insanın PR'da "bu sayı neden yükseldi?" diye bakabileceği tek şey budur. Dosya yoksa kapı
 * TAHMİN ETMEZ: ratchet'in anlamı "kabul edilmiş bir tavan" olmasıdır; tavan yoksa ratchet de yok.
 */
function readBaseline(): GateBaseline {
  if (!existsSync(BASELINE_FILE)) {
    console.error(
      `EKSİK BASELINE: ${BASELINE_FILE}\n` +
        "Ratchet modu kabul edilmiş bir tavan olmadan çalışamaz — tavanı uydurmak, kapıyı ilk " +
        "koşuda kendi kendine onaylatmak olurdu.",
    );
    process.exit(1);
  }
  return JSON.parse(readFileSync(BASELINE_FILE, "utf8")) as GateBaseline;
}

/**
 * HEAD'deki baseline — "gerekçesiz yükseltilemez" kuralının karşılaştırma noktası.
 *
 * Commit ÖNCESİ çalıştırıldığında çalışma ağacındaki (yeni) değer HEAD'dekiyle karşılaştırılır,
 * yani yükseltme commit edilmeden yakalanır. HEAD'de dosya yoksa (ilk tanıtım) karşılaştırma
 * yapılmaz — geçmiş olmadığı için, sessizce affedildiği için değil.
 */
function readPreviousBaseline(): GateBaseline | undefined {
  try {
    const raw = execFileSync("git", ["show", `HEAD:${BASELINE_REPO_PATH}`], { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return JSON.parse(raw) as GateBaseline;
  } catch {
    return undefined;
  }
}

interface RuntimeControl {
  route: string;
  role: string;
  signature: string;
  label: string;
  tag: string;
  actionId: string | null;
  href: string | null;
  disabled: boolean;
  disabledReason: string | null;
}

interface EvidenceRow {
  route: string;
  control: string;
  role: string;
  verdict: "PASS" | "FAIL" | "EXPECTED_DISABLED" | "EXTERNAL_NOT_LIVE_VERIFIABLE" | "UNTESTED";
  proof: string[];
  error?: string;
}

function readJson<T>(file: string, what: string): T {
  if (!existsSync(file)) {
    console.error(
      `EKSİK GİRDİ: ${file}\n` +
        `${what} olmadan bu kapı "hepsi test edildi" diyemez — ve demeyecek.\n` +
        "Sıra: pnpm interaction:crawl → pnpm interaction:test → pnpm interaction:gate",
    );
    process.exit(1);
  }
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

const inventory = readJson<{ controls: RuntimeControl[]; summary: Record<string, unknown> }>(
  INVENTORY,
  "Çalışma zamanı envanteri (keşfedilen kontroller)",
);
/**
 * Kanıt DOSYALARI çoğuldur ve bu bilinçlidir.
 *
 * Her spec kendi kanıtını yazar (`evidence-navigation.json`, `evidence-flows.json`, …). Tek bir
 * dosyaya yazsalardı, paralel/kısmi koşularda birbirlerinin sonucunu EZERLERDİ: yalnız gezinme
 * paketini çalıştıran biri, mutasyon kanıtlarını sıfırlayıp "her şey UNTESTED" raporu üretirdi.
 * Ayrı dosyalar + birleştirme, kısmi koşuyu kısmi kanıt olarak gösterir — ki doğrusu budur.
 */
const evidence: EvidenceRow[] = [];
for (const file of readdirSync(OUT_DIR).filter((f) => /^evidence(-.*)?\.json$/.test(f))) {
  const parsed = JSON.parse(readFileSync(path.join(OUT_DIR, file), "utf8")) as { rows?: EvidenceRow[] };
  if (Array.isArray(parsed.rows)) evidence.push(...parsed.rows);
}

/**
 * Keşif birimi: (rota, imza). Aynı imzanın bir tabloda 40 satır tekrarlaması 40 ayrı kontrol
 * DEĞİLDİR — aynı kontroldür. Ama /payments'taki "ödendi" ile /overview'daki "ödendi" AYRI
 * birimlerdir: farklı ekranda, farklı veriyle, farklı kırılabilirler.
 *
 * /login bilerek dışarıda: oturum açma akışı `tests/visual/global-setup.ts`'in konusudur ve
 * zaten HER koşuda gerçek formdan geçilerek kanıtlanır.
 */
const units = new Map<string, RuntimeControl>();
for (const c of inventory.controls) {
  if (c.route === "/login") continue;
  const key = `${c.route}|${c.signature}`;
  if (!units.has(key)) units.set(key, c);
}

const allowlisted = new Set(EXTERNAL_ALLOWLIST.map((e) => e.control));
const usedRules = new Set<string>();

interface Classified {
  key: string;
  control: RuntimeControl;
  klass: VerificationClass | null;
  ruleId: string | null;
  verifiedBy: string | null;
  verdict: EvidenceRow["verdict"];
  proof: string[];
  error?: string;
}

const classified: Classified[] = [];

for (const [key, control] of units) {
  const rule = ruleFor(control);
  if (rule) usedRules.add(rule.id);

  // Kanıt eşleşmesi: aynı rota + aynı etiket. Rol ayrımı kanıt satırında saklı; burada
  // "bu kontrol için EN AZ BİR gerçek doğrulama koştu mu" sorusu sorulur.
  const hits = evidence.filter((e) => e.route === control.route && e.control === control.signature);
  const failed = hits.find((h) => h.verdict === "FAIL");
  const passed = hits.find((h) => h.verdict === "PASS");
  const disabled = hits.find((h) => h.verdict === "EXPECTED_DISABLED");
  const external = hits.find((h) => h.verdict === "EXTERNAL_NOT_LIVE_VERIFIABLE");

  let verdict: EvidenceRow["verdict"] = "UNTESTED";
  let proof: string[] = [];
  let error: string | undefined;

  if (failed) {
    verdict = "FAIL";
    proof = failed.proof;
    error = failed.error;
  } else if (external || allowlisted.has(control.signature)) {
    verdict = "EXTERNAL_NOT_LIVE_VERIFIABLE";
    proof = external?.proof ?? ["allowlist"];
  } else if (passed) {
    verdict = "PASS";
    proof = passed.proof;
  } else if (disabled) {
    verdict = "EXPECTED_DISABLED";
    proof = disabled.proof;
  }

  classified.push({
    key,
    control,
    klass: rule?.klass ?? null,
    ruleId: rule?.id ?? null,
    verifiedBy: rule?.verifiedBy ?? null,
    verdict,
    proof,
    error,
  });
}

/* ── Rapor ───────────────────────────────────────────────────────────────────────────────── */

const tally = (v: EvidenceRow["verdict"]): Classified[] => classified.filter((c) => c.verdict === v);

const pass = tally("PASS");
const fail = tally("FAIL");
const expectedDisabled = tally("EXPECTED_DISABLED");
const externalNotLive = tally("EXTERNAL_NOT_LIVE_VERIFIABLE");
const untested = tally("UNTESTED");

/** Manifesto boşluğu: kural bile yok. UNTESTED'in en kötü alt kümesi. */
const unmapped = classified.filter((c) => c.ruleId === null);
const deadRules = [...RULES, NAVIGATION_FALLBACK].filter((r) => !usedRules.has(r.id));

const byClass: Record<string, number> = {};
for (const c of classified) byClass[c.klass ?? "(kuralsız)"] = (byClass[c.klass ?? "(kuralsız)"] ?? 0) + 1;

console.log("═".repeat(78));
console.log("ETKİLEŞİM KAPSAM KAPISI");
console.log("═".repeat(78));
console.log(`Interactive controls discovered: ${classified.length}   (ayrık rota×kontrol çifti)`);
console.log("");
console.log(`PASS:                          ${pass.length}`);
console.log(`EXPECTED DISABLED:             ${expectedDisabled.length}`);
console.log(`EXTERNAL NOT LIVE-VERIFIABLE:  ${externalNotLive.length}`);
console.log(`FAIL:                          ${fail.length}`);
console.log(`UNTESTED:                      ${untested.length}`);
console.log("");
console.log("Doğrulama sınıfına göre dağılım:");
for (const [k, n] of Object.entries(byClass).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${k}`);

if (unmapped.length) {
  console.log("");
  console.log(`MANİFESTODA KARŞILIĞI OLMAYAN KONTROLLER (${unmapped.length}) —`);
  console.log("  yeni bir kontrol eklendi ama nasıl doğrulanacağı yazılmadı:");
  const shown = unmapped.slice(0, 60);
  for (const c of shown) console.log(`    ${c.control.route.padEnd(28)} ${c.control.tag.padEnd(7)} ${c.control.label.slice(0, 60)}`);
  if (unmapped.length > shown.length) console.log(`    … +${unmapped.length - shown.length} tane daha`);
}

if (fail.length) {
  console.log("");
  console.log(`BAŞARISIZ (${fail.length}):`);
  for (const c of fail) console.log(`    ${c.control.route} · ${c.control.label.slice(0, 50)} — ${c.error ?? "(gerekçe yok)"}`);
}

if (deadRules.length) {
  console.log("");
  console.log(`ÖLÜ MANİFESTO KURALLARI (${deadRules.length}) — hiçbir kontrolle eşleşmedi:`);
  for (const r of deadRules) console.log(`    ${r.id}`);
}

/* ── Allowlist bütünlüğü ─────────────────────────────────────────────────────────────────── */

const badAllowlist = EXTERNAL_ALLOWLIST.filter(
  (e) => !e.reason?.trim() || !e.ownerDecisionNeeded?.trim() || !e.proofOfImplementation?.trim() || !e.mockTest?.trim(),
);
if (badAllowlist.length) {
  console.log("");
  console.log("EKSİK ALLOWLIST SATIRLARI — dört alan da zorunludur:");
  for (const e of badAllowlist) console.log(`    ${e.control}`);
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(
  path.join(OUT_DIR, "coverage-report.json"),
  JSON.stringify(
    {
      discovered: classified.length,
      pass: pass.length,
      expectedDisabled: expectedDisabled.length,
      externalNotLiveVerifiable: externalNotLive.length,
      fail: fail.length,
      untested: untested.length,
      byClass,
      unmapped: unmapped.map((c) => ({ route: c.control.route, tag: c.control.tag, label: c.control.label })),
      failures: fail.map((c) => ({ route: c.control.route, label: c.control.label, error: c.error })),
      deadRules: deadRules.map((r) => r.id),
      rows: classified.map((c) => ({
        route: c.control.route,
        label: c.control.label,
        tag: c.control.tag,
        klass: c.klass,
        rule: c.ruleId,
        verifiedBy: c.verifiedBy,
        verdict: c.verdict,
        proof: c.proof,
      })),
    },
    null,
    2,
  ) + "\n",
  "utf8",
);

/* ── Karar: ratchet (günlük PR) ya da strict (release/cutover) ───────────────────────────── */

const mode: GateMode = process.argv.includes("--strict") || process.env.MAS_INTERACTION_GATE_MODE === "strict" ? "strict" : "ratchet";
const baseline = readBaseline();
const previousBaseline = readPreviousBaseline();

const verdict = evaluateGate(
  { discovered: classified.length, pass: pass.length, fail: fail.length, untested: untested.length, unmapped: unmapped.length },
  baseline,
  mode,
  previousBaseline,
);

// Allowlist bütünlüğü kapının kural setinin DIŞINDA tutuldu: o, sayıların değil, BEYANIN
// eksikliğidir (dört alandan biri boş). Her modda ve baseline'dan bağımsız olarak kırmızıdır.
if (badAllowlist.length > 0) {
  verdict.reasons.push(`Eksik allowlist satırı=${badAllowlist.length} — dört alan da (reason/ownerDecisionNeeded/proofOfImplementation/mockTest) zorunludur.`);
  verdict.red = true;
}

console.log("");
console.log(`MOD: ${mode === "strict" ? "STRICT (release/cutover)" : "RATCHET (günlük PR kapısı)"}`);
if (mode === "ratchet") {
  console.log(`  baseline: UNTESTED ≤ ${baseline.untested}, PASS ≥ ${baseline.pass}  (docs/interaction-audit/baseline.json)`);
  console.log("  strict kapı için: pnpm interaction:gate:strict");
}
for (const note of verdict.notes) console.log(`  · ${note}`);

console.log("");
console.log(`Ayrıntı: docs/interaction-audit/coverage-report.json`);
console.log("");
if (verdict.red) {
  console.log("SONUÇ: KIRMIZI");
  for (const reason of verdict.reasons) console.log(`  ✖ ${reason}`);
} else {
  console.log(
    mode === "strict"
      ? "SONUÇ: YEŞİL — keşfedilen her kontrolün doğrulanmış bir karşılığı var."
      : "SONUÇ: YEŞİL — kapsam gerilemedi (kalan borç baseline'da kayıtlı).",
  );
}
process.exit(verdict.red ? 1 : 0);
