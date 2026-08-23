// Faz 30 verification — cost allocation, profitability views, working capital.
//
// Usage:
//   MIGRATION_DATABASE_URL=... pnpm phase30:verify
//
// That is the whole contract and it is true: this gate needs the owner connection and nothing
// else. Verified by running exactly that command with DATABASE_URL unset, per the standing rule
// Faz 25 produced. The import graph was checked before writing — costing/rules, costing/engine,
// production/rules, money, audit, validation, authz/matrix — and none reaches @/lib/env.
//
// STANDING RULES INHERITED: conkey targeting with cardinality asserted; fixtures built here and
// dated 2099; value-based comparisons; SQL and TypeScript computing the same number independently
// and having to agree; source-level checks run over CODE with comments stripped (Faz 27's lesson,
// since the scanned files explain in comments exactly what they avoid).
import { readFileSync } from "node:fs";
import path from "node:path";
import { Pool, type PoolClient } from "pg";
import {
  ALLOCATION_BASES, COST_KINDS, allocate, allocationTotal, cashCycle, dpo, dso, profitability,
} from "../src/lib/costing/rules";
import { TABLE_CLASS } from "../src/lib/authz/matrix";
import { requireDisposableOwnerDatabaseUrl } from "./db/owner-url";

const pool = new Pool({ connectionString: requireDisposableOwnerDatabaseUrl("phase30:verify") });

interface Check { name: string; pass: boolean; detail: string }
const checks: Check[] = [];
function record(name: string, pass: boolean, detail: string): void {
  checks.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name} — ${detail}`);
}
const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function inRollback<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query("begin"); return await fn(client); }
  finally { await client.query("rollback").catch(() => {}); client.release(); }
}
async function refuses(c: PoolClient, sql: string, params: unknown[] = []): Promise<boolean> {
  await c.query("savepoint probe");
  try { await c.query(sql, params); await c.query("release savepoint probe"); return false; }
  catch { await c.query("rollback to savepoint probe"); return true; }
}
const TAG = () => `P30-${Math.random().toString(36).slice(2, 8)}`;

/** Source with comments stripped — Faz 27's lesson. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ")
    .replace(/^\s*--.*$/gm, " ");
}

async function mkParty(c: PoolClient, type = "customer"): Promise<string> {
  const n = TAG();
  return (await c.query(
    `insert into public.parties(name, normalized_name, party_type) values ($1,$2,$3) returning id`,
    [n, n.toLowerCase(), type])).rows[0].id;
}
async function mkInvoice(
  c: PoolClient, party: string, direction: string, amount: number,
  costCenter: string | null, issue = "2099-01-10",
): Promise<void> {
  await c.query(
    `insert into public.invoices
       (party_id, direction, issue_date, due_date, net_amount, gross_amount, currency, status,
        cost_center_id, invoice_no)
     values ($1,$2,$3::date,($3::date + 30),$4,$4,'TRY','open',$5,$6)`,
    [party, direction, issue, amount, costCenter, TAG()]);
}

async function main(): Promise<void> {
  /* ── 1. structure ───────────────────────────────────────────────────────────────────── */
  const tbl = await q(
    `select table_name from information_schema.tables
     where table_schema='public' and table_name='cost_allocation_rules'`);
  record("cost_allocation_rules tablosu var", tbl.length === 1, tbl.length === 1 ? "mevcut" : "yok");

  // §17 rule 3 is N/A here, asserted STRUCTURALLY rather than claimed in a comment (Faz 26/28).
  const lifecycleCols = await q(
    `select column_name from information_schema.columns
     where table_schema='public' and table_name='cost_allocation_rules'
       and column_name in ('status','state','version_status','lifecycle','approved_at')`);
  record("cost_allocation_rules'ta yaşam döngüsü kolonu YOK (§17 kural 3 gerçekten N/A)",
    lifecycleCols.length === 0,
    lifecycleCols.length === 0
      ? "yalnız is_active boolean — kısıtlanacak geçiş yok"
      : `bulundu: ${lifecycleCols.map((r) => r.column_name).join(", ")}`);

  const kindCheck = await q(
    `select pg_get_constraintdef(c.oid) as def
     from pg_constraint c
     join pg_attribute a on a.attrelid=c.conrelid and a.attnum = any(c.conkey)
     where c.conrelid='public.cost_allocation_rules'::regclass and c.contype='c'
       and cardinality(c.conkey)=1 and a.attname='cost_kind'`);
  record("cost_kind CHECK'i yapısal olarak ve TEK olarak hedeflendi",
    kindCheck.length === 1, `${kindCheck.length} aday`);
  const kinds = new Set([...(kindCheck[0]?.def ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
  record("cost_kind tam olarak plandaki beş türü sayıyor (ortak/makine/personel/enerji/proje)",
    kinds.size === 5 && COST_KINDS.every((k) => kinds.has(k)), [...kinds].sort().join(", "));

  const basisCheck = await q(
    `select pg_get_constraintdef(c.oid) as def
     from pg_constraint c
     join pg_attribute a on a.attrelid=c.conrelid and a.attnum = any(c.conkey)
     where c.conrelid='public.cost_allocation_rules'::regclass and c.contype='c'
       and cardinality(c.conkey)=1 and a.attname='allocation_basis'`);
  const bases = new Set([...(basisCheck[0]?.def ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
  record("allocation_basis CHECK'i koddaki ALLOCATION_BASES ile birebir aynı",
    basisCheck.length === 1 && bases.size === ALLOCATION_BASES.length
      && ALLOCATION_BASES.every((b) => bases.has(b)),
    [...bases].sort().join(", "));

  /* ── 2. constraints, with positive controls ─────────────────────────────────────────── */
  const cons = await inRollback(async (c) => {
    const percentNoBasis = await refuses(c,
      `insert into public.cost_allocation_rules(code, description, cost_kind, allocation_basis, fixed_percent)
       values ($1,'x','common','revenue_share',0.5)`, [TAG()]);
    const basisNoPercent = await refuses(c,
      `insert into public.cost_allocation_rules(code, description, cost_kind, allocation_basis)
       values ($1,'x','common','fixed_percent')`, [TAG()]);
    const outOfRange = await refuses(c,
      `insert into public.cost_allocation_rules(code, description, cost_kind, allocation_basis, fixed_percent)
       values ($1,'x','common','fixed_percent',1.5)`, [TAG()]);
    const zeroPercent = !(await refuses(c,
      `insert into public.cost_allocation_rules(code, description, cost_kind, allocation_basis, fixed_percent, is_active)
       values ($1,'x','project','fixed_percent',0,false)`, [TAG()]));
    return { percentNoBasis, basisNoPercent, outOfRange, zeroPercent };
  });
  record("yüzde, okumayan bir tabana iliştirilemiyor", cons.percentNoBasis, "kapsam iki yönlü");
  record("sabit yüzde tabanı yüzdesiz olamıyor", cons.basisNoPercent, "");
  record("0..1 dışındaki pay reddediliyor", cons.outOfRange, "");
  record("POZİTİF KONTROL: SIFIR pay geçerli ('buraya bir şey dağıtma')",
    cons.zeroPercent, "0 ile null farklı ifadeler");

  const dup = await inRollback(async (c) => {
    const cc = (await c.query(
      `insert into public.cost_centers(code,name) values ($1,$2) returning id`, [TAG(), TAG()])).rows[0].id;
    await c.query(
      `insert into public.cost_allocation_rules(code, description, cost_kind, allocation_basis, cost_center_id, is_active)
       values ($1,'x','energy','direct_cost',$2,true)`, [TAG(), cc]);
    const second = await refuses(c,
      `insert into public.cost_allocation_rules(code, description, cost_kind, allocation_basis, cost_center_id, is_active)
       values ($1,'x','energy','equal_split',$2,true)`, [TAG(), cc]);
    const inactive = !(await refuses(c,
      `insert into public.cost_allocation_rules(code, description, cost_kind, allocation_basis, cost_center_id, is_active)
       values ($1,'x','energy','equal_split',$2,false)`, [TAG(), cc]));
    return { second, inactive };
  });
  record("aynı hedef için ikinci AKTİF kural engelleniyor",
    dup.second, "çelişen iki taban olamaz — view hangisini seçeceğini bilemezdi");
  record("POZİTİF KONTROL: pasif ikinci kural serbest", dup.inactive, "");

  const seeded = await q(`select code, is_active from public.cost_allocation_rules order by code`);
  record("dört varsayılan kural yüklendi; personel/enerji PASİF geliyor",
    seeded.length >= 4
      && seeded.find((s) => s.code === "machine_by_minutes")?.is_active === true
      && seeded.find((s) => s.code === "personnel_by_revenue")?.is_active === false
      && seeded.find((s) => s.code === "energy_by_minutes")?.is_active === false,
    seeded.map((s) => `${s.code}${s.is_active ? "" : "(pasif)"}`).join(" "));

  /* ── 3. profitability: SQL and TypeScript must agree ────────────────────────────────── */
  const prof = await inRollback(async (c) => {
    const cc = (await c.query(
      `insert into public.cost_centers(code,name) values ($1,$2) returning id`, [TAG(), TAG()])).rows[0].id;
    const ccNoCost = (await c.query(
      `insert into public.cost_centers(code,name) values ($1,$2) returning id`, [TAG(), TAG()])).rows[0].id;
    const cust = await mkParty(c, "customer");
    const supp = await mkParty(c, "vendor");
    // Full picture: 1.000 revenue, 600 cost -> margin 400, rate 0,4
    await mkInvoice(c, cust, "sales", 1000, cc);
    await mkInvoice(c, supp, "purchase", 600, cc);
    // Revenue only, no cost recorded -> margin must be NULL, not 1.000
    await mkInvoice(c, cust, "sales", 500, ccNoCost);
    const rows = (await c.query(
      `select cost_center_id, revenue, direct_cost, margin, margin_rate, confidence
       from public.profitability_by_cost_center where cost_center_id = any($1::uuid[])`,
      [[cc, ccNoCost]])).rows;
    return { cc, ccNoCost, rows };
  });

  const full = prof.rows.find((r) => r.cost_center_id === prof.cc);
  const partial = prof.rows.find((r) => r.cost_center_id === prof.ccNoCost);
  record("kâr marjı doğru hesaplanıyor (1.000 ciro − 600 maliyet = 400)",
    Number(full.margin) === 400 && Math.abs(Number(full.margin_rate) - 0.4) < 1e-9,
    `marj=${full?.margin} oran=${full?.margin_rate}`);
  record("MALİYET YOKSA marj NULL, sıfır veya ciro DEĞİL",
    partial.margin === null && partial.margin_rate === null && partial.confidence === "needs_review",
    "0 marj gerçek bir başabaşla ayırt edilemezdi");
  const tsFull = profitability(full.revenue, full.direct_cost);
  const tsPartial = profitability(partial.revenue, partial.direct_cost);
  record("SQL kâr hesabı ile TS profitability() BİREBİR aynı",
    tsFull.margin === Number(full.margin) && tsFull.confidence === full.confidence
      && tsPartial.margin === null && tsPartial.confidence === partial.confidence,
    `TS ${tsFull.margin}/${tsFull.confidence} — SQL ${full.margin}/${full.confidence}`);

  const party = await inRollback(async (c) => {
    const p = await mkParty(c, "customer");
    await mkInvoice(c, p, "sales", 800, null);
    await mkInvoice(c, p, "purchase", 300, null);
    return (await c.query(
      `select observed_role, net_contribution from public.profitability_by_party where party_id=$1`,
      [p])).rows[0];
  });
  record("aynı cari hem müşteri hem tedarikçiyse 'both' olarak GÖZLEMLENİYOR",
    party.observed_role === "both" && Number(party.net_contribution) === 500,
    `rol=${party.observed_role} net=${party.net_contribution} — type kolonunun iddiası değil, verinin gösterdiği`);

  /* ── 4. the department gap, recorded not invented ───────────────────────────────────── */
  const deptLink = await q(
    `select count(*)::int n from information_schema.columns
     where table_schema='public' and column_name='department_id'
       and table_name in ('invoices','invoice_lines','payments','payment_instances','bank_transactions')`);
  record("ÖLÇÜLDÜ: hiçbir işlem tablosunda department_id yok",
    Number(deptLink[0].n) === 0, "Faz 28'in bulgusu burada da geçerli");
  const deptView = await inRollback(async (c) => {
    await c.query(`insert into public.departments(code,name) values ($1,$2)`, [TAG(), TAG()]);
    return (await c.query(
      `select revenue, margin, unmeasurable_reason from public.profitability_by_department limit 1`)).rows[0];
  });
  record("departman kârlılığı NULL ve GEREKÇELİ — tahsis kuralı icat edilmedi",
    deptView.revenue === null && deptView.margin === null
      && deptView.unmeasurable_reason === "no_transaction_link",
    `gerekçe=${deptView?.unmeasurable_reason}`);

  /* ── 5. working capital ─────────────────────────────────────────────────────────────── */
  const inventoryTables = await q(
    `select count(*)::int n from information_schema.tables
     where table_schema='public' and (table_name ilike '%invent%' or table_name ilike '%stock%')`);
  record("ÖLÇÜLDÜ: şemada envanter tablosu YOK (DIO hesaplanamaz)",
    Number(inventoryTables[0].n) === 0, "stok/envanter tablosu yok");

  const wc = await q(
    `select dso_days, dpo_days, dio_days, dio_unmeasurable_reason,
            cash_conversion_cycle_days, ccc_unmeasurable_reason, cash_cycle_excluding_inventory
     from public.working_capital_metrics limit 1`);
  record("DIO NULL ve gerekçeli — sıfır sayılmıyor",
    wc[0].dio_days === null && wc[0].dio_unmeasurable_reason === "no_inventory_data",
    "DIO'yu 0 saymak döngüyü malzeme tutulan gün kadar KISALTIR, yani daha iyi gösterir");
  record("CCC de NULL ve gerekçeli (üç terimden biri bilinmiyor)",
    wc[0].cash_conversion_cycle_days === null && wc[0].ccc_unmeasurable_reason === "dio_unknown",
    "iki terimden üç terimli bir metrik uydurulmuyor");

  const wcMath = await inRollback(async (c) => {
    const cust = await mkParty(c, "customer");
    const supp = await mkParty(c, "vendor");
    // 100.000 open receivable against 365.000 annual sales -> DSO 100 days.
    await mkInvoice(c, cust, "sales", 365000, null, "2099-01-01");
    await mkInvoice(c, supp, "purchase", 365000, null, "2099-01-01");
    return { tsDso: dso(100000, 365000), tsDpo: dpo(50000, 365000) };
  });
  record("TS DSO/DPO aritmetiği doğru (100.000 / (365.000/365) = 100 gün)",
    wcMath.tsDso === 100 && wcMath.tsDpo === 50, `DSO=${wcMath.tsDso} DPO=${wcMath.tsDpo}`);
  record("sıfır paydada DSO NULL — sıfır 'anında ödüyorlar' demek olurdu",
    dso(100000, 0) === null && dpo(100000, 0) === null, "sonsuz da değil, sıfır da değil");
  record("TS cashCycle DIO bilinmezken CCC vermiyor ama hesaplanabilir kısmı veriyor",
    cashCycle(60, null, 30).cashConversionCycleDays === null
      && cashCycle(60, null, 30).cycleExcludingInventory === 30,
    "dışladığı şeyle birlikte adlandırılıyor");

  /* ── 6. allocation: the kuruş invariant ─────────────────────────────────────────────── */
  const shares = allocate(100, [
    { id: "a", label: "A", driver: 1 },
    { id: "b", label: "B", driver: 1 },
    { id: "c", label: "C", driver: 1 },
  ]);
  record("dağıtım TAM olarak toplanıyor (100,00 üçe bölünse bile kuruş kaybolmuyor)",
    allocationTotal(shares) === 100, `parçalar: ${shares.map((s) => s.amount).join(" + ")}`);
  record("dağıtım deterministik ve girdi sırasından bağımsız",
    allocate(100, [{ id: "b", label: "B", driver: 1 }, { id: "a", label: "A", driver: 1 }])
      .map((s) => s.id).join(",") ===
    allocate(100, [{ id: "a", label: "A", driver: 1 }, { id: "b", label: "B", driver: 1 }])
      .map((s) => s.id).join(","),
    "eşit sürücüler id ile çözülüyor");
  record("sıfır sürücü toplamında bölme yapılmıyor",
    allocate(100, [{ id: "a", label: "A", driver: 0 }]).length === 0, "NaN yerine boş sonuç");

  /* ── 7. views, money discipline, AI exclusion ───────────────────────────────────────── */
  const views = await q(
    `select table_name, table_type from information_schema.tables
     where table_schema='public' and table_name in
       ('costing_invoice_facts','profitability_by_cost_center','profitability_by_project',
        'profitability_by_party','profitability_by_department','profitability_by_machine',
        'profitability_company','working_capital_metrics','working_capital_trend')
     order by table_name`);
  record("dokuz read-model de VIEW (yeni kaynak veri yok)",
    views.length === 9 && views.every((v) => v.table_type === "VIEW"), `${views.length} view`);

  const rulesSrc = readFileSync(path.join(process.cwd(), "src/lib/costing/rules.ts"), "utf8");
  const engineSrc = readFileSync(path.join(process.cwd(), "src/lib/costing/engine.ts"), "utf8");
  const aiImport = (src: string) =>
    /(^|\s)import\s[^;]*["']@\/lib\/ai[^"']*["']/m.test(codeOnly(src))
    || /import\s*\(\s*["']@\/lib\/ai/.test(codeOnly(src));
  record("costing KURALLARI @/lib/ai'yi import ETMİYOR", !aiImport(rulesSrc), "kârlılık matematiği LLM'siz");
  record("costing MOTORU @/lib/ai'yi import ETMİYOR", !aiImport(engineSrc), "");
  record("kârlılık matematiği production/rules.ts desenini İÇE AKTARARAK doğruluyor",
    /from "@\/lib\/production\/rules"/.test(
      readFileSync(path.join(process.cwd(), "src/lib/costing/rules.test.ts"), "utf8")),
    "birim test iki hesabın aynı sonucu verdiğini çiviliyor");

  const FLOAT_CAST = `::${"float"}8`;
  const sources = [
    "supabase/migrations/0074_cost_allocation_rules.sql",
    "supabase/migrations/0075_profitability_working_capital.sql",
    "src/lib/costing/rules.ts", "src/lib/costing/engine.ts",
  ];
  const offenders = sources.filter((f) => codeOnly(readFileSync(path.join(process.cwd(), f), "utf8")).includes(FLOAT_CAST));
  record(`yeni kaynakların hiçbirinde ${FLOAT_CAST} yok`,
    offenders.length === 0, offenders.length === 0 ? `${sources.length} dosya temiz` : offenders.join(", "));
  record("costing matematiği money.ts üzerinden geçiyor",
    /from "@\/lib\/money"/.test(rulesSrc) && /decimal\(/.test(rulesSrc), "Faz 17 katmanı");
  record("motor audit() ve Zod sınırını kullanıyor",
    /audit\(client/.test(engineSrc) && /parseOrThrow\(/.test(engineSrc), "Faz 18 kuralı");
  record("costing motoru MALİ kayıt yazmıyor (yalnız dağıtım kuralı)",
    !/update\s+public\.(invoices|payments|payment_instances|checks|loans|cashflow_months)/i.test(codeOnly(engineSrc)),
    "tek mutasyon cost_allocation_rules");

  /* ── 8. Faz 24B rol matrisi ─────────────────────────────────────────────────────────── */
  record("cost_allocation_rules kod matrisinde sınıflandırılmış (config)",
    TABLE_CLASS["cost_allocation_rules"] === "config", String(TABLE_CLASS["cost_allocation_rules"]));
  const tierRoles = ["mas_radar_viewer", "mas_radar_finance_operator", "mas_radar_finance_approver",
    "mas_radar_finance_manager", "mas_radar_admin"].sort().join(",");
  const selPolicy = await q(
    `select roles::text[] as roles from pg_policies
     where schemaname='public' and tablename='cost_allocation_rules' and cmd='SELECT'`);
  record("SELECT politikası tam beş katmanı hedefliyor",
    selPolicy.length === 1 && [...(selPolicy[0].roles as string[])].sort().join(",") === tierRoles,
    `${selPolicy.length} politika`);
  const writePolicies = await q(
    `select cmd, roles::text[] as roles from pg_policies
     where schemaname='public' and tablename='cost_allocation_rules' and cmd <> 'SELECT'`);
  record("yazma politikalarının tamamı yalnız admin (yönetici maliyeti kendi merkezinden kaydıramaz)",
    writePolicies.length === 3 && writePolicies.every((p) => (p.roles as string[]).join() === "mas_radar_admin"),
    writePolicies.map((p) => `${p.cmd}`).join(" "));
  const blanket = await q(
    `select count(*)::int n from pg_policies
     where schemaname='public' and tablename='cost_allocation_rules' and 'authenticated' = any(roles::text[])`);
  record("yeni tabloya blanket deseni geri getirilmemiş", Number(blanket[0].n) === 0, `${blanket[0].n} adet`);

  const migrateSrc = readFileSync(path.join(process.cwd(), "scripts/db/migrate.ts"), "utf8");
  const anchorBlock = migrateSrc.match(/const ANCHORS[\s\S]*?\];/)?.[0] ?? "";
  record("ANCHORS'a dokunulmadı (0074-0075 eklenmedi)",
    !/007[45]/.test(anchorBlock), "yalnız 0001-0019 legacy tespiti için");

  const failed = checks.filter((c) => !c.pass);
  console.log(`\n${checks.length - failed.length}/${checks.length} kontrol geçti.`);
  if (failed.length > 0) {
    console.error(`\nPHASE30 VERIFY FAIL — ${failed.length} kontrol başarısız:`);
    for (const c of failed) console.error(`  - ${c.name}: ${c.detail}`);
    await pool.end();
    process.exit(1);
  }
  console.log("PHASE30 VERIFY: ALL PASS");
  await pool.end();
}

main().catch(async (e) => {
  console.error("PHASE30 VERIFY FAIL:", messageOf(e));
  await pool.end().catch(() => {});
  process.exit(1);
});
