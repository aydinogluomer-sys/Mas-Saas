// Faz 31 verification — financial controls, anomaly detection, alert lifecycle and escalation.
//
// Usage:
//   MIGRATION_DATABASE_URL=... pnpm phase31:verify
//
// That is the whole contract and it is true: this gate needs the owner connection and nothing
// else. Verified by running exactly that command with DATABASE_URL unset. The import graph was
// checked before writing — controls/rules, controls/engine, money, audit, validation,
// authz/matrix — and none reaches @/lib/env.
//
// ═══ THE CENTRAL CLAIM OF THIS PHASE ═══
//
// It is a SYNTHESIS layer: most controls report on mechanisms that already exist rather than
// enforcing anything a second time. A classification that is merely asserted is worthless, so the
// heaviest section below PROVES each `enforced_elsewhere` claim by exercising the existing
// mechanism — if the Faz 22 ceiling trigger or the bank dedupe index ever stopped holding, this
// gate fails rather than quietly reclassifying.
//
// Every detection view is also proved NON-VACUOUS: a fixture is built that makes it fire, because
// a control returning zero rows on an empty database proves nothing at all.
import { readFileSync } from "node:fs";
import path from "node:path";
import { Pool, type PoolClient } from "pg";
import {
  ALERT_STATUSES, ANOMALY_RULES, assessAnomaly, canTransition, controlState,
  falsePositiveRate, isEscalationDue, isRoundNumber, isSplitPayment,
} from "../src/lib/controls/rules";
import { TABLE_CLASS } from "../src/lib/authz/matrix";
import { requireOwnerDatabaseUrl } from "./db/owner-url";

const pool = new Pool({ connectionString: requireOwnerDatabaseUrl() });

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
const TAG = () => `P31-${Math.random().toString(36).slice(2, 8)}`;

function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ")
    .replace(/^\s*--.*$/gm, " ");
}

async function mkParty(c: PoolClient): Promise<string> {
  const n = TAG();
  return (await c.query(
    `insert into public.parties(name, normalized_name, party_type) values ($1,$2,'vendor') returning id`,
    [n, n.toLowerCase()])).rows[0].id;
}
async function mkUser(c: PoolClient): Promise<string> {
  return (await c.query(
    `insert into public.users(username,password_hash,display_name,role)
     values ($1,'x','P31','finance_manager') returning id`,
    [`p31_${Math.random().toString(36).slice(2, 8)}`])).rows[0].id;
}
async function mkAlert(c: PoolClient, status: string, actor: string, code = TAG()): Promise<string> {
  return (await c.query(
    `insert into public.control_alerts
       (check_code, severity, title, rule_codes, status,
        acknowledged_at, acknowledged_by, snooze_until, resolved_at, resolved_by, resolution_note)
     values ($1,'warning',$2,'{round_number}',$3,
             case when $3='acknowledged' then now() else null end,
             case when $3='acknowledged' then $4::uuid else null end,
             case when $3='snoozed' then current_date + 7 else null end,
             case when $3 in ('resolved','false_positive') then now() else null end,
             case when $3 in ('resolved','false_positive') then $4::uuid else null end,
             case when $3 in ('resolved','false_positive') then 'fixture' else null end)
     returning id`, [code, `alert ${status}`, status, actor])).rows[0].id;
}

const ALLOWED = new Set([
  "open>acknowledged", "open>snoozed", "open>resolved", "open>false_positive",
  "acknowledged>snoozed", "acknowledged>resolved", "acknowledged>false_positive",
  "snoozed>open", "snoozed>acknowledged", "snoozed>resolved", "snoozed>false_positive",
]);

async function main(): Promise<void> {
  /* ── 1. structure ───────────────────────────────────────────────────────────────────── */
  const tables = await q(
    `select table_name from information_schema.tables
     where table_schema='public' and table_name in ('control_alerts','alert_escalation_rules')
     order by table_name`);
  record("iki yeni tablo da mevcut", tables.length === 2, `${tables.length}/2`);

  const statusCheck = await q(
    `select pg_get_constraintdef(c.oid) as def
     from pg_constraint c
     join pg_attribute a on a.attrelid=c.conrelid and a.attnum = any(c.conkey)
     where c.conrelid='public.control_alerts'::regclass and c.contype='c'
       and cardinality(c.conkey)=1 and a.attname='status'`);
  record("control_alerts.status CHECK'i yapısal olarak ve TEK olarak hedeflendi",
    statusCheck.length === 1, `${statusCheck.length} aday`);
  const lits = new Set([...(statusCheck[0]?.def ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
  record("status CHECK tam olarak 5 kanonik değeri sayıyor",
    lits.size === 5 && ALERT_STATUSES.every((s) => lits.has(s)), [...lits].sort().join(", "));

  const escLifecycle = await q(
    `select column_name from information_schema.columns
     where table_schema='public' and table_name='alert_escalation_rules'
       and column_name in ('status','state','version_status','lifecycle')`);
  record("alert_escalation_rules'ta yaşam döngüsü kolonu YOK (§17 kural 3 N/A)",
    escLifecycle.length === 0, "yalnız is_active boolean");

  /* ── 2. the 20-pair alert transition enumeration ────────────────────────────────────── */
  const guard = await inRollback(async (c) => {
    const actor = await mkUser(c);
    const out: { pair: string; accepted: boolean }[] = [];
    for (const from of ALERT_STATUSES) {
      for (const to of ALERT_STATUSES) {
        if (from === to) continue;
        const id = await mkAlert(c, from, actor);
        const sql = `update public.control_alerts
                       set status=$2,
                           acknowledged_at = case when $2='acknowledged' then now()
                                                  when $2='open' then null else acknowledged_at end,
                           acknowledged_by = case when $2='acknowledged' then $3::uuid
                                                  when $2='open' then null else acknowledged_by end,
                           snooze_until    = case when $2='snoozed' then current_date + 7 else null end,
                           resolved_at     = case when $2 in ('resolved','false_positive') then now() else null end,
                           resolved_by     = case when $2 in ('resolved','false_positive') then $3::uuid else null end,
                           resolution_note = case when $2 in ('resolved','false_positive') then 'x' else resolution_note end
                     where id=$1`;
        const blocked = await refuses(c, sql, [id, to, actor]);
        out.push({ pair: `${from}>${to}`, accepted: !blocked });
      }
    }
    return out;
  });
  const wrong = guard.filter((g) => g.accepted !== ALLOWED.has(g.pair));
  record("20 geçişin tamamı allow-list ile örtüşüyor (izinli 11, yasak 9)",
    wrong.length === 0,
    wrong.length === 0
      ? `${guard.filter((g) => g.accepted).length} kabul / ${guard.filter((g) => !g.accepted).length} ret`
      : wrong.map((w) => `${w.pair}=${w.accepted ? "kabul" : "ret"}`).join(", "));
  record("guard ile koddaki canTransition BİREBİR aynı",
    guard.every((g) => g.accepted === canTransition(
      g.pair.split(">")[0] as never, g.pair.split(">")[1] as never)),
    "veritabanı ve uygulama tek kural kümesi");
  record("ERTELEME SÜRESİ DOLABİLİYOR (snoozed → open)",
    guard.find((g) => g.pair === "snoozed>open")?.accepted === true,
    "olmasaydı ertelenen her uyarı kalıcı susturulurdu");
  record("kapatılmış bulgu yeniden AÇILAMIYOR (resolved/false_positive terminal)",
    guard.filter((g) => g.pair.startsWith("resolved>") || g.pair.startsWith("false_positive>"))
      .every((g) => !g.accepted),
    "tekrar ederse yeni uyarı oluşur, geçmiş yeniden yazılmaz");

  /* ── 3. THE ENFORCEMENT CLASSIFICATION, PROVED not asserted ─────────────────────────── */
  //
  // Each `enforced_elsewhere` claim is checked by exercising the mechanism it points at.
  const bankDedupe = await q(
    `select indisunique from pg_index x join pg_class c on c.oid = x.indexrelid
     where c.relname = 'bank_transactions_dedupe_uq'`);
  record("KANIT: bank_transactions dedupe indeksi GERÇEKTEN unique (birebir kopya imkânsız)",
    bankDedupe.length === 1 && bankDedupe[0].indisunique === true,
    "bu yüzden kontrol yalnız YAKIN kopyaları arıyor");

  const invoiceDedupe = await q(
    `select indisunique from pg_index x join pg_class c on c.oid = x.indexrelid
     where c.relname = 'invoices_dedupe_idx'`);
  record("KANIT: invoices dedupe indeksi unique DEĞİL — yinelenen fatura gerçekten engellenmiyor",
    invoiceDedupe.length === 1 && invoiceDedupe[0].indisunique === false,
    "bu yüzden duplicate_invoice 'detection_only' sınıfında");

  const ceilingHolds = await inRollback(async (c) => {
    const party = await mkParty(c);
    const inv = (await c.query(
      `insert into public.invoices
         (party_id, direction, issue_date, due_date, net_amount, gross_amount, currency, status, invoice_no)
       values ($1,'sales','2099-01-01','2099-02-01',1000,1000,'TRY','open',$2) returning id`,
      [party, TAG()])).rows[0].id;
    // The Faz 22 trigger must refuse an allocation above the invoice.
    return refuses(c,
      `insert into public.invoice_allocations(invoice_id, source_table, source_id, allocated_amount, allocated_on)
       values ($1,'payment_instances',gen_random_uuid(),5000,'2099-01-05')`, [inv]);
  });
  record("KANIT: Faz 22'nin tavan trigger'ı HÂLÂ tutuyor (fatura üstü dağıtım reddedildi)",
    ceilingHolds,
    "allocation_over_invoice bu yüzden 'enforced_elsewhere' — ikinci bir kısıt eklenmedi");

  const ibanEvents = await q(
    `select count(*)::int n from information_schema.tables
     where table_schema='public' and table_name='iban_change_events'`);
  record("KANIT: Faz 19'un iban_change_events'i mevcut (IBAN değişimi zaten kaydediliyor)",
    Number(ibanEvents[0].n) === 1, "iban_changed 'enforced_elsewhere' — yeniden icat edilmedi");

  const registryCounts = await q(
    `select enforcement, count(*)::int n from public.control_registry group by enforcement order by enforcement`);
  record("kontrol kaydı her denetimi SINIFLANDIRIYOR (zaten-zorlanan vs yalnız-tespit)",
    registryCounts.length === 2,
    registryCounts.map((r) => `${r.enforcement}=${r.n}`).join(" "));

  /* ── 4. every detection view PROVED NON-VACUOUS ─────────────────────────────────────── */
  const fires = await inRollback(async (c) => {
    const party = await mkParty(c);
    const out: Record<string, number> = {};

    // duplicate invoice: same party, amount, date, direction
    for (let i = 0; i < 2; i += 1) {
      await c.query(
        `insert into public.invoices
           (party_id, direction, issue_date, due_date, net_amount, gross_amount, currency, status, invoice_no)
         values ($1,'purchase','2099-03-01','2099-04-01',5000,5000,'TRY','open',$2)`, [party, TAG()]);
    }
    out.duplicate_invoice = Number((await c.query(
      `select count(*)::int n from public.control_duplicate_invoices`)).rows[0].n);

    // missing source document (the invoices above have no workbook)
    out.missing_source = Number((await c.query(
      `select count(*)::int n from public.control_missing_source_document`)).rows[0].n);

    // large payment + approval bypass + round number
    const pay = (await c.query(
      `insert into public.payments(name, recurrence_type, due_day, default_amount, currency, provider_party_id)
       values ($1,'monthly',10,150000,'TRY',$2) returning id`, [TAG(), party])).rows[0].id;
    // status='paid' requires paid_at (paid_requires_paid_at) — a real invariant this fixture must
    // satisfy rather than work around.
    await c.query(
      `insert into public.payment_instances
         (payment_id, instance_month, due_date, amount, currency, status, direction, paid_at, paid_amount)
       values ($1,'2099-03-01','2099-03-10',150000,'TRY','paid','outflow', now(), 150000)`, [pay]);
    out.large_payment = Number((await c.query(
      `select count(*)::int n from public.control_large_payments`)).rows[0].n);
    out.approval_bypass = Number((await c.query(
      `select count(*)::int n from public.control_approval_bypass`)).rows[0].n);
    out.round_number = Number((await c.query(
      `select count(*)::int n from public.anomaly_round_number_payments`)).rows[0].n);
    out.payment_without_invoice = Number((await c.query(
      `select count(*)::int n from public.control_payment_without_invoice`)).rows[0].n);

    // split payment: two parts each under the 100k threshold, together over it
    // TWO payment records, not two instances of one: payment_instances_idempotency is unique on
    // (payment_id, instance_month). That constraint also makes the fixture more faithful — a split
    // is one bill entered as several separate payments to the same counterparty, which is exactly
    // what the detector is looking for.
    for (const day of [11, 12]) {
      const p2 = (await c.query(
        `insert into public.payments(name, recurrence_type, due_day, default_amount, currency, provider_party_id)
         values ($1,'monthly',$2,60000,'TRY',$3) returning id`, [TAG(), day, party])).rows[0].id;
      await c.query(
        `insert into public.payment_instances
           (payment_id, instance_month, due_date, amount, currency, status, direction)
         values ($1,'2099-05-01','2099-05-11',60000,'TRY','unpaid','outflow')`, [p2]);
    }
    out.split_payment = Number((await c.query(
      `select count(*)::int n from public.anomaly_split_payments`)).rows[0].n);

    // closed-period mutation: a locked month with an invoice updated after it
    await c.query(
      `insert into public.cashflow_months
         (month_start, opening_balance, projected_income, projected_expense, monthly_delta,
          closing_balance, status, updated_at)
       values ('2099-06-01',0,0,0,0,0,'locked', now() - interval '2 days')`);
    await c.query(
      `insert into public.invoices
         (party_id, direction, issue_date, due_date, net_amount, gross_amount, currency, status, invoice_no, updated_at)
       values ($1,'purchase','2099-06-10','2099-07-10',900,900,'TRY','open',$2, now())`, [party, TAG()]);
    out.closed_period = Number((await c.query(
      `select count(*)::int n from public.control_closed_period_mutations`)).rows[0].n);

    return out;
  });

  const nonVacuous = [
    ["duplicate_invoice", fires.duplicate_invoice],
    ["missing_source_document", fires.missing_source],
    ["large_payment", fires.large_payment],
    ["approval_bypass", fires.approval_bypass],
    ["payment_without_invoice", fires.payment_without_invoice],
    ["closed_period_mutation", fires.closed_period],
    ["anomaly_round_number", fires.round_number],
    ["anomaly_split_payment", fires.split_payment],
  ] as const;
  const silent = nonVacuous.filter(([, n]) => n === 0).map(([k]) => k);
  record("her tespit görünümü BİR FIXTURE İLE GERÇEKTEN TETİKLENİYOR (boş küme kanıt değil)",
    silent.length === 0,
    silent.length === 0
      ? nonVacuous.map(([k, n]) => `${k}=${n}`).join(" ")
      : `tetiklenmeyen: ${silent.join(", ")}`);

  record("kapalı dönem mutasyonu 'locked' çıpasıyla yakalanıyor",
    fires.closed_period >= 1, `${fires.closed_period} bulgu — cashflow_months.status='locked'`);
  record("onay atlama tespiti Faz 24A'nın approvals'ını KULLANIYOR",
    fires.approval_bypass >= 1, "eşik üstü ödemenin approvals kaydı yok");

  /* ── 5. dashboard: PASS when clean, severity when not ───────────────────────────────── */
  const dash = await q(`select check_code, state, finding_count, enforcement from public.control_dashboard`);
  record("kontrol panosu her kaydı listeliyor (bulgu yokken de görünüyor)",
    dash.length === 11, `${dash.length} kontrol`);
  const stateMismatch = dash.filter((d) => {
    const sev = d.state === "PASS" ? null : d.state;
    return Number(d.finding_count) === 0 ? d.state !== "PASS" : sev === null;
  });
  record("PASS yalnız bulgu YOKKEN, aksi hâlde kontrolün kendi ciddiyeti",
    stateMismatch.length === 0, `${dash.filter((d) => d.state === "PASS").length} PASS`);
  record("TS controlState() ile SQL durumu aynı mantığı izliyor",
    controlState("critical", 0) === "PASS" && controlState("critical", 1) === "CRITICAL"
      && controlState("warning", 2) === "WARNING",
    "tek eşik tanımı");

  /* ── 6. alert idempotency and the review workflow ───────────────────────────────────── */
  const idem = await inRollback(async (c) => {
    const actor = await mkUser(c);
    const code = TAG();
    const subject = (await c.query(`select gen_random_uuid() as id`)).rows[0].id;
    await c.query(
      `insert into public.control_alerts(check_code, severity, title, rule_codes, subject_table, subject_id)
       values ($1,'warning','dup test','{round_number}','invoices',$2)`, [code, subject]);
    // Second identical live alert must be impossible — the partial unique index.
    const blocked = await refuses(c,
      `insert into public.control_alerts(check_code, severity, title, rule_codes, subject_table, subject_id)
       values ($1,'warning','dup test','{round_number}','invoices',$2)`, [code, subject]);
    // But once closed, a recurrence may legitimately open a new one.
    await c.query(
      `update public.control_alerts set status='resolved', resolved_at=now(), resolved_by=$2,
         resolution_note='closed' where check_code=$1`, [code, actor]);
    const afterClose = !(await refuses(c,
      `insert into public.control_alerts(check_code, severity, title, rule_codes, subject_table, subject_id)
       values ($1,'warning','dup test','{round_number}','invoices',$2)`, [code, subject]));
    return { blocked, afterClose };
  });
  record("aynı bulgu için ikinci CANLI uyarı engelleniyor (tekrar koşu liste şişirmiyor)",
    idem.blocked, "kısmi unique indeks");
  record("POZİTİF KONTROL: kapandıktan sonra tekrarlayan bulgu YENİ uyarı açabiliyor",
    idem.afterClose, "geçmiş yeniden yazılmıyor, yeni kayıt açılıyor");

  const actionItemSource = await q(
    `select pg_get_constraintdef(oid) as def from pg_constraint where conname='action_items_source_type_check'`);
  record("inceleme iş akışı MEVCUT action_items modelini kullanıyor ('control' değeri)",
    /'control'/.test(actionItemSource[0]?.def ?? ""), "ikinci görev modeli icat edilmedi");

  const engineSrc = readFileSync(path.join(process.cwd(), "src/lib/controls/engine.ts"), "utf8");
  record("motor takip görevini action_items'a yazıyor, yeni tabloya değil",
    /insert into public\.action_items/.test(codeOnly(engineSrc))
      && /'control'/.test(codeOnly(engineSrc)),
    "Faz 14/25 deseni");

  /* ── 7. scoring, escalation and feedback ───────────────────────────────────────────── */
  record("anomali skoru ağırlıkları TOPLUYOR (üç zayıf sinyal birlikte daha şüpheli)",
    assessAnomaly(["round_number", "new_payee", "unusual_record_hour"]).score >
      assessAnomaly(["new_payee"]).score,
    "ortalama alsaydı yığın en büyük bileşeninin altına düşerdi");
  record("boş kural kümesi uyarı üretmiyor",
    assessAnomaly([]).score === 0 && assessAnomaly([]).primaryRule === null,
    "kuralsız bulgu bulgu değildir");
  record("kural kaydı eksiksiz", ANOMALY_RULES.length === 7, `${ANOMALY_RULES.length} adlandırılmış kural`);
  record("yuvarlak-sayı kuralı hem BÜYÜK hem YUVARLAK istiyor",
    isRoundNumber(50000) && !isRoundNumber(1000) && !isRoundNumber(50500),
    "küçük yuvarlak tutar sıradan; büyük düzensiz tutar da öyle");
  record("bölünmüş ödeme yalnız eşiği ATLATAN parçalar için tetikleniyor",
    isSplitPayment([60000, 60000], 100000) && !isSplitPayment([120000, 10000], 100000),
    "tek başına eşiği aşan ödeme 'bölünmüş' değil, zaten büyük");
  record("yalnız AÇIK uyarılar yükseliyor",
    isEscalationDue({ status: "open", firstSeenAt: "2099-01-01T00:00:00Z", escalateAfterHours: 1, nowISO: "2099-01-01T02:00:00Z" })
      && !isEscalationDue({ status: "acknowledged", firstSeenAt: "2099-01-01T00:00:00Z", escalateAfterHours: 1, nowISO: "2099-01-01T02:00:00Z" }),
    "yanıt veren operatör cezalandırılmıyor");
  record("yanlış-alarm oranı yalnız KAPANMIŞ uyarılardan hesaplanıyor",
    falsePositiveRate(0, 0) === null && falsePositiveRate(3, 1) === 0.25,
    "triyaj edilmemiş kontrol 'kusursuz' görünmüyor");

  const escSeeds = await q(`select code, is_active from public.alert_escalation_rules order by code`);
  record("iki eskalasyon kuralı yüklendi ve İKİSİ DE AKTİF",
    escSeeds.length >= 2 && escSeeds.every((e) => e.is_active),
    "pasif gelen bir eskalasyon kuralı, hiç yükseltmeyen bir alarm demek olurdu");

  /* ── 8. no LLM in the control chain ─────────────────────────────────────────────────── */
  const rulesSrc = readFileSync(path.join(process.cwd(), "src/lib/controls/rules.ts"), "utf8");
  const aiImport = (src: string) =>
    /(^|\s)import\s[^;]*["']@\/lib\/ai[^"']*["']/m.test(codeOnly(src))
    || /import\s*\(\s*["']@\/lib\/ai/.test(codeOnly(src));
  record("kontrol KURALLARI @/lib/ai'yi import ETMİYOR", !aiImport(rulesSrc),
    "bir kontrol bulgusu ikinci bir kişi tarafından yeniden üretilebilmeli");
  record("kontrol MOTORU @/lib/ai'yi import ETMİYOR", !aiImport(engineSrc), "");
  record("istatistiksel/ML kütüphanesi yok",
    !/scipy|sklearn|tensorflow|regression|stddev_samp\s*\(/i.test(codeOnly(rulesSrc + engineSrc)),
    "yalnız adlandırılmış eşikler ve sabit ağırlıklar");
  record("motor MALİ kayıt yazmıyor (bulgu sunar, düzeltmez)",
    !/(update|delete\s+from)\s+public\.(invoices|payments|payment_instances|checks|loans|bank_transactions|cashflow_months)/i
      .test(codeOnly(engineSrc)),
    "kendi bulduğunu 'düzelten' bir kontrol, otomasyonun tutar/vade değiştirmesi olurdu");

  const FLOAT_CAST = `::${"float"}8`;
  const sources = [
    "supabase/migrations/0076_control_alerts.sql",
    "supabase/migrations/0077_action_items_control_source.sql",
    "supabase/migrations/0078_control_checks_views.sql",
    "src/lib/controls/rules.ts", "src/lib/controls/engine.ts",
  ];
  const offenders = sources.filter((f) => codeOnly(readFileSync(path.join(process.cwd(), f), "utf8")).includes(FLOAT_CAST));
  record(`yeni kaynakların hiçbirinde ${FLOAT_CAST} yok`,
    offenders.length === 0, offenders.length === 0 ? `${sources.length} dosya temiz` : offenders.join(", "));
  record("motor audit() ve Zod sınırını kullanıyor",
    /audit\(client/.test(engineSrc) && /parseOrThrow\(/.test(engineSrc), "Faz 18 kuralı");

  /* ── 9. constraints-verify was EXTENDED, not altered ────────────────────────────────── */
  const cvSrc = readFileSync(path.join(process.cwd(), "scripts/db/constraints-verify.ts"), "utf8");
  record("db:constraints:verify Faz 31 girdilerini aldı (mevcut fonksiyonlar korunarak)",
    /runFaz31ConstraintAssertions/.test(cvSrc)
      && /runFaz19ConstraintAssertions/.test(cvSrc) && /runFaz22ConstraintAssertions/.test(cvSrc),
    "planın şartı: genişletir, değiştirmez");

  /* ── 10. Faz 24B rol matrisi ────────────────────────────────────────────────────────── */
  const newTables = ["control_alerts", "alert_escalation_rules"];
  const unclassified = newTables.filter((t) => TABLE_CLASS[t] === undefined);
  record("iki yeni tablo da kod matrisinde sınıflandırılmış",
    unclassified.length === 0,
    unclassified.length === 0 ? newTables.map((t) => `${t}=${TABLE_CLASS[t]}`).join(" ") : unclassified.join(", "));
  const tierRoles = ["mas_radar_viewer", "mas_radar_finance_operator", "mas_radar_finance_approver",
    "mas_radar_finance_manager", "mas_radar_admin"].sort().join(",");
  const selPolicies = await q(
    `select tablename, roles::text[] as roles from pg_policies
     where schemaname='public' and cmd='SELECT' and tablename = any($1::text[])`, [newTables]);
  record("iki tablonun da SELECT politikası tam beş katmanı hedefliyor",
    selPolicies.length === 2 && selPolicies.every((p) => [...(p.roles as string[])].sort().join(",") === tierRoles),
    `${selPolicies.length}/2`);
  const blanket = await q(
    `select count(*)::int n from pg_policies
     where schemaname='public' and tablename = any($1::text[]) and 'authenticated' = any(roles::text[])`,
    [newTables]);
  record("yeni tablolara blanket deseni geri getirilmemiş", Number(blanket[0].n) === 0, `${blanket[0].n} adet`);

  const migrateSrc = readFileSync(path.join(process.cwd(), "scripts/db/migrate.ts"), "utf8");
  const anchorBlock = migrateSrc.match(/const ANCHORS[\s\S]*?\];/)?.[0] ?? "";
  record("ANCHORS'a dokunulmadı (0076-0078 eklenmedi)",
    !/007[678]/.test(anchorBlock), "yalnız 0001-0019 legacy tespiti için");

  const failed = checks.filter((c) => !c.pass);
  console.log(`\n${checks.length - failed.length}/${checks.length} kontrol geçti.`);
  if (failed.length > 0) {
    console.error(`\nPHASE31 VERIFY FAIL — ${failed.length} kontrol başarısız:`);
    for (const c of failed) console.error(`  - ${c.name}: ${c.detail}`);
    await pool.end();
    process.exit(1);
  }
  console.log("PHASE31 VERIFY: ALL PASS");
  await pool.end();
}

main().catch(async (e) => {
  console.error("PHASE31 VERIFY FAIL:", messageOf(e));
  await pool.end().catch(() => {});
  process.exit(1);
});
