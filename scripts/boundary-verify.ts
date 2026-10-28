// Faz 15 — the AI / integration BOUNDARY gate.
//
// Every other gate in this repo asks "does the code do the right thing when run". This one asks a
// structural question that running cannot answer as reliably: can financial data leave this process
// through a path nobody reviewed, and can a secret escape into a log, an audit row, or the client
// bundle? Those are properties of the SOURCE, so they are checked against the source — statically,
// with no database and no network, which is also why it can live in the `static` CI job.
//
// It is the written-down form of decisions the codebase already made and defends in comments:
//   - integrations/types.ts: "no integration can reach the network on its own" (the ctx.http seam).
//   - ai/engine.ts: the model is called only behind mutationIntent() + the AI_FORCE_DETERMINISTIC
//     kill switch, and the AI writes only to its own snapshot log, never to a financial table.
//   - reminders/transport.ts & fx/provider.ts: env is read LAZILY, and process.env is never touched
//     outside @/lib/env and the one credential seam.
// A comment is a hope; this turns each into an assertion that fails the build when a future change
// breaks it.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SRC = path.join(ROOT, "src");

// The ONLY files permitted to make an outbound network call. Everything else must route through one
// of these seams (a connector reaches the net via integrations/types.ts's HttpClient, not directly).
const EGRESS_ALLOWLIST = new Set([
  "lib/ai/engine.ts",              // OpenAI, behind the mutation/kill-switch guards
  "lib/ai/copilot-engine.ts",      // Interactive CFO Copilot OpenAI call with timeout & fallback
  "lib/fx/provider.ts",            // TCMB public bulletin
  "lib/integrations/types.ts",     // realHttpClient() — the single integration network seam
  "lib/reminders/transport.ts",    // Telegram + email
]);

// process.env is allowed only in the validated source and the one credential-by-name seam.
const PROCESS_ENV_ALLOWLIST = new Set([
  "lib/env.ts",
  "lib/integrations/types.ts",     // readCredential(envVarName) — reads by NAME, returns null, never logs
]);

// Modules that must read env LAZILY (await import), never at module top level, because a top-level
// import of @/lib/env drags a DATABASE_URL requirement into anything that imports them — the bug
// that made phase6b/phase25/phase38 verifies unrunnable under their own documented commands.
const LAZY_ENV_FILES = ["lib/ai/engine.ts", "lib/reminders/transport.ts"];

// The AI/commentary subtree may never mutate the ledger. It writes only to its own logs
// (ai_response_snapshots, assistant_conversations), which are deliberately absent from this list.
const FINANCIAL_TABLES = [
  "payments", "payment_instances", "checks", "loans", "loan_installments",
  "invoices", "invoice_lines", "cashflow_months", "cashflow_lines",
  "bank_transactions", "scenario_runs", "scenario_run_lines", "promise_to_pay",
  "parties", "cash_accounts", "bank_accounts",
];
const AI_SUBTREE = ["lib/ai", "lib/assistant", "lib/search"];

interface Violation { file: string; line: number; text: string }
interface Outcome { name: string; pass: boolean; violations: Violation[] }
const results: Outcome[] = [];
function record(name: string, violations: Violation[]): void {
  results.push({ name, pass: violations.length === 0, violations });
  console.log(`${violations.length === 0 ? "PASS" : "FAIL"}  ${name}${violations.length ? `  (${violations.length} ihlal)` : ""}`);
  for (const v of violations.slice(0, 12)) console.log(`        ${v.file}:${v.line}  ${v.text.trim().slice(0, 100)}`);
}

/** All source files (relative to src/, forward-slashed), excluding tests and .d.ts. */
function sourceFiles(): string[] {
  return (readdirSync(SRC, { recursive: true }) as string[])
    .map((p) => p.split(path.sep).join("/"))
    .filter((p) => /\.(ts|tsx)$/.test(p) && !/\.test\.(ts|tsx)$/.test(p) && !p.endsWith(".d.ts"));
}
function read(rel: string): string {
  return readFileSync(path.join(SRC, rel), "utf8");
}
function underAny(rel: string, dirs: string[]): boolean {
  return dirs.some((d) => rel === d || rel.startsWith(`${d}/`));
}
/**
 * Match a regex per line, returning violations — but SKIPPING comment lines. A naive comment
 * stripper cannot be used because `//` also appears inside every `https://` URL; instead whole
 * comment lines are skipped (full-line `//`, jsdoc `*` continuations, and `/* … *​/` blocks tracked
 * across lines). Real fetch/process.env/mutation code lives on non-comment lines, which is what a
 * boundary this strict is about. Caught the hard way: check B first flagged transport.ts's own
 * comment that says "this file never touches process.env".
 */
function scan(rel: string, content: string, re: RegExp, keep: (line: string) => boolean = () => true): Violation[] {
  const out: Violation[] = [];
  let inBlock = false;
  content.split(/\r?\n/).forEach((line, i) => {
    const t = line.trim();
    let isComment = false;
    if (inBlock) { isComment = true; if (t.includes("*/")) inBlock = false; }
    else if (t.startsWith("//") || t.startsWith("*")) isComment = true;
    else if (t.startsWith("/*")) { isComment = true; if (!t.includes("*/")) inBlock = true; }
    if (isComment) return;
    if (re.test(line) && keep(line)) out.push({ file: rel, line: i + 1, text: line });
  });
  return out;
}

const files = sourceFiles();

// ── A. Egress containment ────────────────────────────────────────────────────────────────
// Any fetch() outside the allowlist must be a same-origin RELATIVE call ("/api/…"); an absolute
// URL or a variable target is an unreviewed egress path and fails.
{
  const v: Violation[] = [];
  for (const rel of files) {
    if (EGRESS_ALLOWLIST.has(rel)) continue;
    for (const hit of scan(rel, read(rel), /\bfetch\s*\(/)) {
      const after = hit.text.slice(hit.text.search(/\bfetch\s*\(/)).replace(/\bfetch\s*\(\s*/, "");
      const sameOrigin = /^[`"']\//.test(after); // fetch("/api/...") — not egress
      if (!sameOrigin) v.push(hit);
    }
    // websockets / raw node http clients are egress too
    for (const hit of scan(rel, read(rel), /\bnew WebSocket\b|from ["']node:(https?|net|dns|tls)["']|require\(["']node:(https?|net)["']\)/)) v.push(hit);
  }
  record("A. ağ çıkışı yalnız izinli 4 sınır modülünde (fetch/ws/raw-http)", v);
}

// ── B. process.env only in the validated source + the credential seam ──────────────────────
{
  const v: Violation[] = [];
  for (const rel of files) {
    if (PROCESS_ENV_ALLOWLIST.has(rel)) continue;
    // Only enforce over the boundary-relevant subtrees; app routes may read non-secret vars.
    if (!underAny(rel, ["lib/ai", "lib/assistant", "lib/reminders", "lib/fx", "lib/integrations", "lib/search"])) continue;
    v.push(...scan(rel, read(rel), /\bprocess\.env\b/));
  }
  record("B. sınır modülleri process.env'e dokunmaz (yalnız env.ts + readCredential seam)", v);
}

// ── C. env is read lazily in the transport/AI modules ──────────────────────────────────────
{
  const v: Violation[] = [];
  for (const rel of LAZY_ENV_FILES) {
    // A TOP-LEVEL import line that pulls @/lib/env. The lazy form (await import("@/lib/env")) is fine.
    v.push(...scan(rel, read(rel), /^\s*import\b[^\n]*["']@\/lib\/env["']/));
  }
  record("C. ai/engine + reminders/transport env'i tembel okur (üst-seviye import yok)", v);
}

// ── D. no ledger mutation in the AI/commentary subtree ─────────────────────────────────────
{
  const v: Violation[] = [];
  const mut = new RegExp(
    `\\b(insert\\s+into|update|delete\\s+from)\\s+(public\\.)?(${FINANCIAL_TABLES.join("|")})\\b`,
    "i",
  );
  for (const rel of files) {
    if (!underAny(rel, AI_SUBTREE)) continue;
    v.push(...scan(rel, read(rel), mut));
  }
  record("D. AI/asistan/arama alt ağacı finansal tabloları MUTASYONA uğratmaz", v);
}

// ── E. env object is never serialised whole (secret leak) ──────────────────────────────────
{
  const v: Violation[] = [];
  for (const rel of files) {
    v.push(...scan(rel, read(rel), /JSON\.stringify\(\s*(process\.)?env\b/));
  }
  record("E. env/process.env nesnesi hiçbir yerde JSON.stringify ile basılmaz", v);
}

// ── F. no secret token in a console.* call inside the boundary modules ──────────────────────
{
  const v: Violation[] = [];
  const secretConsole = /console\.\w+\([^)]*\b(token|apikey|api_key|credential|bearer|secret|password)\b/i;
  for (const rel of files) {
    if (!underAny(rel, ["lib/ai", "lib/assistant", "lib/reminders", "lib/fx", "lib/integrations"])) continue;
    v.push(...scan(rel, read(rel), secretConsole));
  }
  record("F. sınır modüllerinde console.* çağrısı sır (token/apiKey/credential) taşımaz", v);
}

// ── G. AI kill switch + mutation gate are still wired in ai/engine.ts ───────────────────────
{
  const engine = read("lib/ai/engine.ts");
  const v: Violation[] = [];
  if (!/aiForceDeterministic/.test(engine)) v.push({ file: "lib/ai/engine.ts", line: 0, text: "AI_FORCE_DETERMINISTIC kill switch kontrolü kayıp" });
  if (!/mutationIntent\s*\(/.test(engine)) v.push({ file: "lib/ai/engine.ts", line: 0, text: "mutationIntent() kapısı kayıp" });
  record("G. ai/engine kill switch (aiForceDeterministic) + mutationIntent kapısı yerinde", v);
}

// ── H. accounting connector refuses permanently (no vendor chosen) ─────────────────────────
{
  const conn = read("lib/integrations/connectors.ts");
  const v: Violation[] = [];
  if (!/ACCOUNTING_PENDING_REASON/.test(conn)) v.push({ file: "lib/integrations/connectors.ts", line: 0, text: "ACCOUNTING_PENDING_REASON kayıp" });
  if (!/accountingConnector/.test(conn)) v.push({ file: "lib/integrations/connectors.ts", line: 0, text: "accountingConnector kayıp" });
  if (!/permanent:\s*true/.test(conn)) v.push({ file: "lib/integrations/connectors.ts", line: 0, text: "kalıcı ret (permanent:true) kayıp" });
  record("H. muhasebe konnektörü kalıcı reddediyor (vendor seçilmedi)", v);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} sınır kontrolü geçti.`);
if (failed.length > 0) {
  console.error("BOUNDARY VERIFY FAIL:");
  for (const f of failed) console.error(`  - ${f.name}: ${f.violations.length} ihlal`);
  process.exit(1);
}
console.log("BOUNDARY VERIFY: ALL PASS");
process.exit(0);
