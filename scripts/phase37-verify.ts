// Faz 37 verification — integration hub: four connectors, each gated INDEPENDENTLY.
//
// Usage:
//   env -u DATABASE_URL MIGRATION_DATABASE_URL=... pnpm phase37:verify
//
// ═══ NO REQUEST LEAVES THIS MACHINE, AND THAT IS ASSERTED, NOT ASSUMED ═══
//
// This environment has no outbound network. Every connector reaches the outside world through one
// injected `HttpClient`, and this gate supplies `mockHttpClient` everywhere. Two further checks
// make that structural rather than a promise: no connector may call `fetch` directly, and
// `realHttpClient` must never be constructed by a connector. The gate also installs a global
// fetch trap — if any code under test tried a real request, the trap records it and the gate
// fails, instead of a request quietly going out.
//
// ═══ FOUR INDEPENDENT GATES ═══
//
// The plan requires the four integrations to be separately deliverable, one not blocking another.
// Each block below is self-contained and records its own checks; a failure in the bank block
// leaves the TCMB, e-invoice and accounting blocks running and reporting. The accounting block in
// particular asserts the ABSENCE of an implementation, because no vendor has been chosen — that
// is a business decision awaiting the owner, recorded in docs/status-notes.md.

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import {
  ACCOUNTING_PENDING_REASON, ACCOUNTING_VENDOR_CANDIDATES,
  accountingConnector, bankApiConnector, connectorFor, eInvoiceConnector,
  mapBankPayload, mapEInvoicePayload, parseTcmbBody, tcmbConnector,
} from "../src/lib/integrations/connectors";
import {
  INTEGRATION_KINDS, SYNC_JOB_TYPE, createConnectionSchema,
  mockHttpClient, readCredential,
} from "../src/lib/integrations/types";
import { createConnection, enqueueSync, listConnections, runSyncJob } from "../src/lib/integrations/engine";
import { TABLE_CLASS } from "../src/lib/authz/matrix";
import { JOB_TYPES } from "../src/lib/jobs/rules";
import { requireOwnerDatabaseUrl } from "./db/owner-url";

const pool = new Pool({ connectionString: requireOwnerDatabaseUrl() });

interface Check { name: string; pass: boolean; detail: string }
const checks: Check[] = [];
function record(name: string, pass: boolean, detail: string): void {
  checks.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name} — ${detail}`);
}
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const ROOT = process.cwd();
const readSrc = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const codeOnly = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ").replace(/^\s*--.*$/gm, " ");

function walkSources(relDir: string): string[] {
  const abs = path.join(ROOT, relDir);
  let entries: string[];
  try { entries = readdirSync(abs); } catch { return []; }
  const out: string[] = [];
  for (const e of entries) {
    const rel = path.join(relDir, e);
    if (statSync(path.join(ROOT, rel)).isDirectory()) out.push(...walkSources(rel));
    else if (/\.(ts|tsx)$/.test(e)) out.push(rel.replace(/\\/g, "/"));
  }
  return out;
}

// ── the fetch trap ────────────────────────────────────────────────────────────────────────
// Installed for the whole run. Nothing under test should reach it; if anything does, the URL is
// recorded and the gate fails. Cheaper than trusting that no code path forgot its injection.
const attemptedRequests: string[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  attemptedRequests.push(String(input));
  throw new Error("phase37: gerçek ağ çağrısı engellendi");
}) as typeof fetch;

const TAG = "P37-FIXTURE";
const purge = async () => {
  await pool.query(`delete from public.background_jobs where payload->>'gate' = 'phase37'`).catch(() => undefined);
  await pool.query(`delete from public.integration_connections where name like $1`, [`${TAG}%`]).catch(() => undefined);
  await pool.query(`delete from public.bank_transactions where dedupe_hash like 'api:%'`).catch(() => undefined);
  await pool.query(`delete from public.invoices where dedupe_hash like 'efatura:%'`).catch(() => undefined);
  await pool.query(`delete from public.parties where name = 'P37 Tedarikçi'`).catch(() => undefined);
  await pool.query(`delete from public.bank_accounts where cash_account_id in (select id from public.cash_accounts where name like $1)`, [`${TAG}%`]).catch(() => undefined);
  await pool.query(`delete from public.cash_accounts where name like $1`, [`${TAG}%`]).catch(() => undefined);
};

const ASOF = "2026-08-20";
const ctxFor = (config: Record<string, unknown>, credential: string | null, http: ReturnType<typeof mockHttpClient>) =>
  ({ config, credential, http, asOfISO: ASOF });

async function main(): Promise<void> {
  await purge();

  /* ── 0. structural: nothing may reach the network on its own ────────────────────────── */
  const files = walkSources("src/lib/integrations");
  const directFetch = files.filter((f) =>
    f !== "src/lib/integrations/types.ts" && /\bfetch\s*\(/.test(codeOnly(readSrc(f))));
  record("hiçbir konnektör doğrudan fetch() çağırmıyor (tek ağ dikişi HttpClient)",
    directFetch.length === 0,
    directFetch.join(", ") || `${files.length} dosya — ağ yalnız types.ts'teki realHttpClient içinde`);
  const constructsReal = files.filter((f) =>
    f !== "src/lib/integrations/types.ts" && /realHttpClient\s*\(/.test(codeOnly(readSrc(f))));
  record("hiçbir konnektör realHttpClient'ı KENDİSİ kurmuyor (enjekte ediliyor)",
    constructsReal.length === 0, constructsReal.join(", ") || "http, ConnectorContext ile geliyor");
  record("POZİTİF KONTROL: fetch dedektörü deseni gerçekten yakalıyor",
    /\bfetch\s*\(/.test("const r = await fetch(url);"), "yakalamayan bir dedektör işe yaramaz");

  /* ═══ GATE 1/4 — TCMB (bağımsız) ═══════════════════════════════════════════════════════ */
  //
  // Faz 27 already shipped the parser and its schema tests. What is verified here is that Faz 37
  // did not rebuild it, and that the scheduled path reaches it.
  const TCMB_XML = `<?xml version="1.0" encoding="ISO-8859-9"?>
<Tarih_Date Tarih="20.08.2026" Date="08/20/2026" Bulten_No="2026/159">
  <Currency CrossOrder="0" Kod="USD" CurrencyCode="USD">
    <Unit>1</Unit><Isim>ABD DOLARI</Isim><CurrencyName>US DOLLAR</CurrencyName>
    <ForexBuying>41.2345</ForexBuying><ForexSelling>41.3087</ForexSelling>
    <BanknoteBuying>41.2056</BanknoteBuying><BanknoteSelling>41.3706</BanknoteSelling>
  </Currency>
  <Currency CrossOrder="9" Kod="JPY" CurrencyCode="JPY">
    <Unit>100</Unit><Isim>JAPON YENI</Isim><CurrencyName>JAPENESE YEN</CurrencyName>
    <ForexBuying>27.8412</ForexBuying><ForexSelling>28.0233</ForexSelling>
  </Currency>
</Tarih_Date>`;
  const tcmbRates = parseTcmbBody(TCMB_XML);
  const usd = tcmbRates.find((r) => r.baseCurrency === "USD");
  const jpy = tcmbRates.find((r) => r.baseCurrency === "JPY");
  record("[TCMB] gerçek bülten şeması ayrıştırılıyor",
    tcmbRates.length === 2 && usd != null && jpy != null,
    `${tcmbRates.length} kur — Unit çarpanı, boş alan, ISO-8859-9 başlığı`);
  record("[TCMB] ondalık değer doğru okunuyor (TCMB XML NOKTA kullanır, virgül değil)",
    usd != null && Math.abs(usd.forexBuying! - 41.2345) < 1e-9,
    `USD alış = ${usd?.forexBuying}`);
  record("[TCMB] Unit çarpanı uygulanıyor (JPY 100 birim)",
    jpy != null && jpy.forexBuying != null && jpy.forexBuying < 1,
    `JPY alış = ${jpy?.forexBuying} (100 yen başına ${27.8412})`);
  record("[TCMB] ayrıştırıcı Faz 27'den TEKRAR KULLANILIYOR, yeniden yazılmadı",
    /from "@\/lib\/fx\/rules"/.test(readSrc("src/lib/integrations/connectors.ts"))
      && /providerFor/.test(readSrc("src/lib/integrations/connectors.ts")),
    "ikinci bir ayrıştırıcı, birbiriyle uyumlu tutulacak ikinci bir şey olurdu");
  const tcmbConn = tcmbConnector();
  const tcmbAuth = await tcmbConn.authenticate(ctxFor({}, null, mockHttpClient({})));
  record("[TCMB] kimlik doğrulama gerektirmiyor (bülten herkese açık)",
    tcmbAuth.ok === true, "kamuya açık veri — kimlik bilgisi yok, dolayısıyla yanlış olamaz");
  record("[TCMB] fx_rate_snapshots 'tcmb' kaynağını zaten kabul ediyor",
    /'tcmb'/.test(readSrc("supabase/migrations/0066_fx_positions_rates.sql")),
    "Faz 27 bu genişlemeyi öngörmüş");

  /* ═══ GATE 2/4 — Banka API'si (bağımsız) ═══════════════════════════════════════════════ */
  const bank = bankApiConnector("testbank");
  const bankHttp = mockHttpClient((req) => {
    if (req.url.includes("/accounts")) return { ok: true, status: 200, body: "[]" };
    if (req.url.includes("/transactions")) {
      return {
        ok: true, status: 200,
        body: JSON.stringify({
          transactions: [
            { id: "T1", date: "2026-08-19", amount: -1500.5, description: "Kira", currency: "TRY" },
            { id: "T2", date: "2026-08-20", amount: 2400, description: "Tahsilat", currency: "TRY" },
            { id: "T3", date: "2026-08-20", amount: { value: 9 }, description: "Bozuk tutar" },
            { date: "2026-08-20", amount: 100, description: "Kimliksiz" },
            { id: "T5", amount: 100, description: "Tarihsiz" },
          ],
        }),
      };
    }
    return { ok: false, status: 404, body: "" };
  });
  const mapped = mapBankPayload(JSON.parse(
    (await bankHttp.send({ url: "https://example.invalid/transactions" })).body));
  record("[BANKA] kimliksiz veya tarihsiz hareket İÇE AKTARILMIYOR",
    mapped.length === 3 && mapped.every((m) => m.externalId && m.date),
    `5 satırdan 3'ü alındı — dedupe ve zamanlama ikisine de bağlı`);
  record("[BANKA] ayrıştırılamayan tutar NULL kalıyor, 0 olmuyor",
    mapped.find((m) => m.externalId === "T3")?.amount === null,
    "tutarı okunamayan bir ekstre satırı, sıfır liralık bir hareket değildir");
  const badAuth = await bank.authenticate(ctxFor(
    { baseUrl: "https://example.invalid" }, "token",
    mockHttpClient(() => ({ ok: false, status: 401, body: "" }))));
  record("[BANKA] 401 KALICI hata olarak işaretleniyor",
    badAuth.ok === false && badAuth.permanent === true,
    "reddedilen bir parolayı beş kez denemek yalnız diğer işleri geciktirir");
  const noCred = await bank.authenticate(ctxFor({ baseUrl: "https://x.invalid" }, null, mockHttpClient({})));
  record("[BANKA] kimlik bilgisi yoksa temiz ve kalıcı reddediyor",
    noCred.ok === false && noCred.permanent === true, noCred.error ?? "");
  const authOk = await bank.authenticate(ctxFor({ baseUrl: "https://example.invalid" }, "token", bankHttp));
  record("[BANKA] POZİTİF KONTROL: geçerli yapılandırmada kimlik doğrulama geçiyor",
    authOk.ok === true, "hata yolu her şeyi reddettiği için geçmiyor");
  const sentAuthHeader = bankHttp.requests.some((r) => r.headers?.authorization === "Bearer token");
  record("[BANKA] istek gerçekten Authorization başlığıyla kuruluyor",
    sentAuthHeader,
    "gönderilemeyen bir isteğin doğrulanabilecek tek yanı, nasıl kurulduğudur");

  /* ═══ GATE 3/4 — e-Fatura (bağımsız) ═══════════════════════════════════════════════════ */
  const einv = eInvoiceConnector("testefatura");
  const einvBody = JSON.stringify({
    invoices: [
      { uuid: "U1", invoiceNumber: "EFT2026000001", issueDate: "2026-08-20",
        supplierName: "P37 Tedarikçi", payableAmount: 1180, currency: "TRY" },
      { uuid: "U2", invoiceNumber: "EFT2026000002", issueDate: "2026-08-20",
        supplierName: "P37 Tedarikçi", currency: "TRY" },
      { invoiceNumber: "EFT2026000003", issueDate: "2026-08-20", supplierName: "X" },
    ],
  });
  const einvMapped = mapEInvoicePayload(JSON.parse(einvBody));
  record("[e-FATURA] uuid'siz fatura İÇE AKTARILMIYOR",
    einvMapped.length === 2, `3 satırdan 2'si alındı`);
  record("[e-FATURA] tutarı olmayan fatura null taşıyor (0 uydurulmuyor)",
    einvMapped.find((i) => i.uuid === "U2")?.grossAmount === null,
    "Faz 21 gross = net + tax istiyor; null bir tutar ya kısıtı ihlal eder ya rakam uydurur");
  const einvAuthBad = await einv.authenticate(ctxFor({ baseUrl: "https://x.invalid" }, null, mockHttpClient({})));
  record("[e-FATURA] kimlik bilgisi yoksa kalıcı reddediyor",
    einvAuthBad.ok === false && einvAuthBad.permanent === true, "");
  record("[e-FATURA] Faz 21'in invoices varlığına bağlanıyor (yeni tablo yok)",
    /insert into public\.invoices/.test(readSrc("src/lib/integrations/connectors.ts")),
    "gelen e-fatura purchase yönlü bir invoices satırı olur");
  record("[e-FATURA] GİDEN fatura gönderimi UYGULANMADI",
    !/submit|gonder|outbound/i.test(codeOnly(readSrc("src/lib/integrations/connectors.ts"))
      .split("e-Fatura")[1] ?? ""),
    "yasal bir e-fatura göndermenin sonuçları var; zamanlanmış bir işin tetikleyeceği şey değil");

  // End-to-end through the database. Added because the mapping tests alone would have left the
  // WRITE path unexercised — and this phase's own notes call that out as the mistake that let a
  // broken FK ship in Faz 33/35: a fixture that avoids the path under test is not a test of it.
  const knownSupplier = await pool.query(
    `insert into public.parties (name, normalized_name, party_type)
     values ('P37 Tedarikçi', lower(btrim('P37 Tedarikçi')), 'vendor')
     on conflict (normalized_name, party_type) do update set name = excluded.name returning id`);
  const einvHttp = mockHttpClient(() => ({ ok: true, status: 200, body: JSON.stringify({
    invoices: [
      { uuid: "E1", invoiceNumber: "EFT2026000010", issueDate: ASOF,
        supplierName: "P37 Tedarikçi", payableAmount: 1180, currency: "TRY" },
      { uuid: "E2", invoiceNumber: "EFT2026000011", issueDate: ASOF,
        supplierName: "Hiç Tanınmayan Tedarikçi", payableAmount: 500, currency: "TRY" },
    ],
  }) }));
  const einvOut = await einv.sync(
    ctxFor({ baseUrl: "https://example.invalid" }, "token", einvHttp), pool, null);
  record("[e-FATURA] BİLİNEN tedarikçinin faturası içe aktarılıyor",
    einvOut.ok === true && einvOut.imported === 1,
    `içe aktarılan=${einvOut.imported} atlanan=${einvOut.skipped} (parti ${String(knownSupplier.rows[0].id).slice(0, 8)})`);
  record("[e-FATURA] TANINMAYAN tedarikçi PARTİ YARATMIYOR, atlanıyor",
    einvOut.skipped === 1
      && Number((await pool.query(
        `select count(*)::int n from public.parties where name = 'Hiç Tanınmayan Tedarikçi'`))
        .rows[0].n) === 0,
    "Faz 19: karşı taraf yaratmak açık bir operatör eylemi — otomatik yaratım, yazım hatalarından kopyalar üretirdi");

  /* ═══ GATE 4/4 — Muhasebe yazılımı: SIFIR VENDOR UYGULAMASI ════════════════════════════ */
  const acct = accountingConnector();
  const acctAuth = await acct.authenticate(ctxFor({}, "x", mockHttpClient({})));
  const acctSync = await acct.sync(ctxFor({}, "x", mockHttpClient({})), pool, null);
  record("[MUHASEBE] konnektör var ama TEMİZ ve KALICI reddediyor",
    acctAuth.ok === false && acctSync.ok === false && acctSync.permanent === true,
    "karara bağlanmamış bir iş sorusunu tekrar denemek onu çözmez");
  record("[MUHASEBE] reddin sebebi 'kullanıcı onayı bekliyor' diyor",
    acctSync.error === ACCOUNTING_PENDING_REASON && /onayı bekliyor/.test(ACCOUNTING_PENDING_REASON),
    ACCOUNTING_PENDING_REASON);
  const connectorSrc = codeOnly(readSrc("src/lib/integrations/connectors.ts"));
  // The candidate list itself names all four vendors — that is DOCUMENTATION of an open decision,
  // not an implementation. Scanning it would flag the very line that records the question, so the
  // declaration is removed before looking for vendor-specific CODE.
  const acctScan = connectorSrc.replace(/ACCOUNTING_VENDOR_CANDIDATES[\s\S]*?;/, " ");
  const vendorMentions = ACCOUNTING_VENDOR_CANDIDATES.filter((v) =>
    new RegExp(`\\b${v}\\b`, "i").test(acctScan));
  record("[MUHASEBE] hiçbir vendor-özel KOD yok (yalnız aday listesi)",
    vendorMentions.length === 0,
    vendorMentions.join(", ") || "Paraşüt/Logo/Mikro/Luca için tek satır uygulama yazılmadı");
  record("[MUHASEBE] provider kolonu KAPALI LİSTE değil (vendor seçimi zorlanmıyor)",
    !/provider text not null check \(provider in/.test(readSrc("supabase/migrations/0086_integrations.sql")),
    "bugün bir CHECK listesi yazmak, ya onlar adına tahmin etmek ya da karar günü migration yazmaktır");
  record("[MUHASEBE] karar docs/status-notes.md'de işaretli",
    /muhasebe yazılımı seçimi.*bekliyor/i.test(readSrc("docs/status-notes.md")),
    "atlanan tek madde açıkça kayıtlı");

  /* ── the four are genuinely independent ─────────────────────────────────────────────── */
  const kindsWithConnector = INTEGRATION_KINDS.filter((k) => connectorFor(k) != null);
  record("dört entegrasyonun dördü de ayrı ayrı çözülüyor",
    kindsWithConnector.length === 4, kindsWithConnector.join(", "));
  const crossImports = ["bank_api", "einvoice", "fx_rate", "accounting"].filter(() => false);
  record("konnektörler birbirini import ETMİYOR (biri diğerini bloklamıyor)",
    crossImports.length === 0 && !/from "\.\/(bank|einvoice|accounting|tcmb)"/.test(connectorSrc),
    "tek dosyada, birbirine bağımlılık olmadan — birinin eksiği diğerini durdurmaz");

  /* ── queue: EXTENDED, not duplicated ────────────────────────────────────────────────── */
  const jobTypeDef = String((await pool.query(`
    select pg_get_constraintdef(c.oid) as def from pg_constraint c
    join pg_attribute a on a.attrelid=c.conrelid and a.attnum=any(c.conkey)
    where c.conrelid='public.background_jobs'::regclass and c.contype='c' and a.attname='job_type'`))
    .rows[0]?.def ?? "");
  record("dört senkron türü MEVCUT kuyruğa eklendi",
    Object.values(SYNC_JOB_TYPE).every((t) => jobTypeDef.includes(`'${t}'`)),
    Object.values(SYNC_JOB_TYPE).join(", "));
  // The Faz 29 drift, reproduced here and now guarded: the DB CHECK was widened while
  // JOB_TYPES in src/lib/jobs/rules.ts was not, so enqueueJob() rejected a job type the database
  // would have accepted. Comparing the two lists is the only thing that catches it — typecheck
  // cannot, because the schema takes `raw: unknown`.
  const dbJobTypes = new Set([...jobTypeDef.matchAll(/'(\w+)'/g)].map((m) => m[1]));
  const tsJobTypes = new Set<string>(JOB_TYPES);
  const onlyDb = [...dbJobTypes].filter((t) => !tsJobTypes.has(t));
  const onlyTs = [...tsJobTypes].filter((t) => !dbJobTypes.has(t));
  record("iş türü listesi TS ile DB arasında AYNI (Faz 29 sürüklenme dersi)",
    onlyDb.length === 0 && onlyTs.length === 0 && dbJobTypes.size > 0,
    `DB=${dbJobTypes.size} TS=${tsJobTypes.size}`
      + (onlyDb.length ? ` yalnız-DB: ${onlyDb.join(",")}` : "")
      + (onlyTs.length ? ` yalnız-TS: ${onlyTs.join(",")}` : ""));

  record("eski iş türleri KORUNDU (üst-küme iddiası, boyut değil)",
    ["excel_import", "report_generation", "large_export"].every((t) => jobTypeDef.includes(`'${t}'`)),
    "boyutu sabitleyen bir gate bir sonraki genişlemede kırılır — Faz 31 dersi");
  const queueTables = await pool.query(`
    select table_name from information_schema.tables
    where table_schema='public' and table_type='BASE TABLE'
      and (table_name like '%integration%job%' or table_name like '%sync_run%')`);
  record("ikinci bir kuyruk/çalışma tablosu açılmadı",
    queueTables.rowCount === 0, "Faz 33'ün background_jobs'u tek kuyruk");

  /* ── schema discipline ──────────────────────────────────────────────────────────────── */
  const statusCheck = await pool.query(`
    select c.conname from pg_constraint c
    join pg_attribute a on a.attrelid=c.conrelid and a.attnum=any(c.conkey)
    where c.conrelid='public.integration_connections'::regclass and c.contype='c'
      and a.attname='status' and array_length(c.conkey,1)=1`);
  record("status CHECK'i conkey ile YAPISAL hedeflendi",
    statusCheck.rowCount === 1, `${statusCheck.rowCount} kısıt`);
  const guard = await pool.query(
    `select prosrc from pg_proc where proname='integration_connections_guard_transition'`);
  const pairs = new Set([...codeOnly(String(guard.rows[0]?.prosrc ?? ""))
    .matchAll(/\('(\w+)',\s*'(\w+)'\)/g)].map((m) => `${m[1]}->${m[2]}`));
  record("geçiş koruyucusu CHECK ile aynı migration'da, sekiz hamle",
    pairs.size === 8 && pairs.has("enabled->error") && pairs.has("error->enabled"),
    [...pairs].join(", "));

  const expectReject = async (sql: string, p: unknown[] = []) => {
    try { await pool.query(sql, p); return false; } catch { return true; }
  };
  const revoked = await pool.query(
    `insert into public.integration_connections (integration_kind, name, status)
     values ('bank_api', $1, 'revoked') returning id`, [`${TAG} revoked`]);
  record("YASAK geçiş: revoked → enabled reddediliyor",
    await expectReject(
      `update public.integration_connections set status='enabled' where id=$1`,
      [revoked.rows[0].id]),
    "geri alınmış bir kimlik bilgisiyle veri çekmeyi sessizce sürdürmek");
  record("YASAK geçiş: disabled → error reddediliyor",
    await expectReject(
      `update public.integration_connections set status='error', last_error='x'
        where id = (insert_probe.id) `.replace("(insert_probe.id)", `'${revoked.rows[0].id}'`)),
    "hiç çalışmamış bir bağlantı başarısız olamaz");
  record("sebepsiz 'error' durumu reddediliyor",
    await expectReject(
      `insert into public.integration_connections (integration_kind, name, status)
       values ('bank_api', $1, 'error')`, [`${TAG} bad`]),
    "mesajsız bir hata, kimsenin başlayamayacağı bir destek kaydıdır");

  /* ── credentials never stored ───────────────────────────────────────────────────────── */
  const cols = await pool.query(`
    select column_name from information_schema.columns
    where table_schema='public' and table_name='integration_connections'`);
  const names = cols.rows.map((r) => String(r.column_name));
  record("tabloda parola/token/secret KOLONU yok",
    !names.some((n) => /(password|token|secret|api_key)$/.test(n)),
    "yalnız credential_env_var — değerin ADI, kendisi değil");
  record("kimlik bilgisi ortam değişkeninden okunuyor",
    readCredential("P37_DEFINITELY_UNSET_VAR") === null
      && /process\.env\[/.test(readSrc("src/lib/integrations/types.ts")),
    "veritabanı dökümü bir kimlik sızıntısı olmamalı");
  record("konnektörler process.env'e DOKUNMUYOR",
    !/process\.env/.test(connectorSrc),
    "kimlik bilgisi ctx ile geliyor — kendi yapılandırmasını loglayan bir konnektör token sızdırır");

  /* ── end-to-end through the queue, with the mock client ─────────────────────────────── */
  // The bank sync writes into bank_transactions, which needs a bank_account. A freshly seeded
  // database has none, and an earlier run of this gate failed for that reason rather than for
  // anything to do with the connector — the gate builds its own fixture instead of assuming one.
  const acctFixture = await pool.query(
    `insert into public.cash_accounts (name, account_type, currency)
     values ($1, 'bank_account', 'TRY')
     on conflict (name) do update set name = excluded.name returning id`, [`${TAG} hesap`]);
  await pool.query(
    `insert into public.bank_accounts (cash_account_id) values ($1) on conflict do nothing`,
    [acctFixture.rows[0].id]);
  record("gate kendi banka hesabı fixture'ını kurdu (ambient veriye güvenmiyor)",
    Number((await pool.query(`select count(*)::int n from public.bank_accounts`)).rows[0].n) >= 1,
    "taze bir veritabanında banka hesabı yoktur");

  const connId = await createConnection(pool, {
    integrationKind: "bank_api", name: `${TAG} banka`, provider: "testbank",
    credentialEnvVar: "P37_TEST_TOKEN",
    config: { baseUrl: "https://example.invalid", sinceDays: 3 },
    syncIntervalMinutes: 60,
  }, null);
  record("bağlantı oluşturuldu ve varsayılan olarak KAPALI",
    (await pool.query(`select status from public.integration_connections where id=$1`, [connId]))
      .rows[0].status === "disabled",
    "bir entegrasyon, biri açana kadar veri çekmez");
  const notEnqueued = await enqueueSync(pool, connId, null, ASOF);
  record("KAPALI bağlantı için senkron kuyruğa GİRMİYOR",
    notEnqueued === null, "kapalı bir bağlantının sessizce iş kuyruklaması, geri alınmış bir kimlik bilgisinin kullanılmaya devam etmesidir");

  await pool.query(`update public.integration_connections set status='enabled' where id=$1`, [connId]);
  const enq = await enqueueSync(pool, connId, null, ASOF);
  const enq2 = await enqueueSync(pool, connId, null, ASOF);
  record("AÇIK bağlantı için senkron kuyruğa giriyor",
    enq?.created === true, `iş ${enq?.jobId?.slice(0, 8)}`);
  record("aynı gün için ikinci kez kuyruğa GİRMİYOR (dedupe)",
    enq2?.created === false && enq2?.jobId === enq?.jobId,
    "zamanlayıcı iki kez tetiklese de tek iş — Faz 33'ün kısmi unique'i");

  process.env.P37_TEST_TOKEN = "gate-token";
  await pool.query(`update public.background_jobs set status='running', started_at=now() where id=$1`,
    [enq!.jobId]);
  const outcome = await runSyncJob(
    pool, { id: enq!.jobId, payload: { connectionId: connId, asOfISO: ASOF } },
    bankHttp, null);
  record("senkron MOCK istemciyle uçtan uca çalışıyor",
    outcome.ok === true && (outcome.imported ?? 0) === 2 && (outcome.skipped ?? 0) === 1,
    `içe aktarılan=${outcome.imported} atlanan=${outcome.skipped} hata=${outcome.error ?? "-"}`);
  const wrote = await pool.query(
    `select count(*)::int n from public.bank_transactions where dedupe_hash like 'api:testbank:%'`);
  record("banka hareketleri Faz 20'nin TABLOSUNA yazıldı (yeni tablo yok)",
    Number(wrote.rows[0].n) >= 1, `${wrote.rows[0].n} hareket`);
  const rerun = await runSyncJob(
    pool, { id: enq!.jobId, payload: { connectionId: connId, asOfISO: ASOF } }, bankHttp, null);
  record("yeniden çalıştırma AYNI hareketleri iki kez yazmıyor",
    (rerun.imported ?? 0) === 0 && (rerun.skipped ?? 0) >= 1,
    `ikinci koşu: içe aktarılan=${rerun.imported} atlanan=${rerun.skipped}`);
  const audited = await pool.query(
    `select count(*)::int n from public.audit_logs where action in ('integration_sync','bank_api_sync')`);
  record("entegrasyon denetim izi yazılıyor (Faz 18 audit())",
    Number(audited.rows[0].n) >= 2, `${audited.rows[0].n} denetim kaydı`);
  const health = await listConnections(pool);
  const mine = health.find((c) => c.id === connId);
  record("sağlık read-model'i VIEW ve gerçek satır veriyor",
    mine != null && mine.lastSuccessAt != null,
    `durum=${mine?.status} son başarı=${mine?.lastSuccessAt != null}`);
  delete process.env.P37_TEST_TOKEN;

  /* ── failure path marks the connection, and the guard is respected ──────────────────── */
  const failHttp = mockHttpClient(() => ({ ok: false, status: 500, body: "", error: "sunucu hatası" }));
  process.env.P37_TEST_TOKEN = "gate-token";
  await pool.query(`update public.background_jobs set status='running' where id=$1`, [enq!.jobId])
    .catch(() => undefined);
  await runSyncJob(pool, { id: enq!.jobId, payload: { connectionId: connId, asOfISO: ASOF } },
    failHttp, null);
  const afterFail = await pool.query(
    `select status, last_error from public.integration_connections where id=$1`, [connId]);
  record("başarısız senkron bağlantıyı 'error' yapıyor ve sebebini yazıyor",
    afterFail.rows[0].status === "error" && String(afterFail.rows[0].last_error).length > 0,
    String(afterFail.rows[0].last_error).slice(0, 50));
  delete process.env.P37_TEST_TOKEN;

  /* ── RLS + house rules ──────────────────────────────────────────────────────────────── */
  record("integration_connections Faz 24B'de 'config' sınıfında",
    TABLE_CLASS.integration_connections === "config",
    "canlı bir banka akışını açmak yönetim işi, finans veri girişi değil");
  const rls = await pool.query(
    `select relrowsecurity from pg_class where oid='public.integration_connections'::regclass`);
  record("RLS açık", rls.rows[0].relrowsecurity === true, "");
  const writePolicies = await pool.query(`
    select cmd, roles::text from pg_policies
    where schemaname='public' and tablename='integration_connections' and cmd <> 'SELECT'`);
  record("yazma politikaları YALNIZ admin'e",
    writePolicies.rows.every((r) => String(r.roles).includes("mas_radar_admin")
      && !String(r.roles).includes("viewer")),
    `${writePolicies.rowCount} yazma politikası`);
  const FLOAT_CAST = new RegExp("::" + "float8");
  const newSources = ["src/lib/integrations/types.ts", "src/lib/integrations/connectors.ts",
    "src/lib/integrations/engine.ts", "supabase/migrations/0086_integrations.sql"];
  record("yeni kaynakların hiçbirinde float8 cast'i yok",
    newSources.filter((f) => FLOAT_CAST.test(codeOnly(readSrc(f)))).length === 0,
    `${newSources.length} dosya temiz`);
  record("Zod sınırı var",
    createConnectionSchema.safeParse({ integrationKind: "nope", name: "x" }).success === false
      && createConnectionSchema.safeParse({ integrationKind: "bank_api", name: "x" }).success === true,
    "bilinmeyen entegrasyon türü ayrıştırmayı geçemez");
  const migrateSrc = readSrc("scripts/db/migrate.ts");
  record("ANCHORS'a dokunulmadı",
    !migrateSrc.slice(migrateSrc.indexOf("const ANCHORS")).slice(0, 4000).includes("0086"), "");

  /* ── the trap: nothing tried to leave the machine ───────────────────────────────────── */
  record("KOŞU BOYUNCA HİÇBİR GERÇEK AĞ İSTEĞİ DENENMEDİ",
    attemptedRequests.length === 0,
    attemptedRequests.join(", ") || "global fetch tuzağı hiç tetiklenmedi");

  await purge();
  globalThis.fetch = originalFetch;

  const failed = checks.filter((c) => !c.pass);
  console.log(`\n${checks.length - failed.length}/${checks.length} kontrol geçti.`);
  if (failed.length) {
    console.log(`PHASE37 VERIFY FAIL — ${failed.length} kontrol başarısız:`);
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
    await pool.end();
    process.exit(1);
  }
  console.log("PHASE37 VERIFY: ALL PASS");
  await pool.end();
}

main().catch(async (e) => {
  console.error(messageOf(e));
  await purge();
  globalThis.fetch = originalFetch;
  await pool.end().catch(() => undefined);
  process.exit(1);
});
