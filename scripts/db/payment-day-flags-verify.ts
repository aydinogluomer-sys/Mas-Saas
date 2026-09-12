/**
 * `/payments` riskli-gün kararının, hızlandırma sonrasında ESKİ `dayFlags()` ile BİREBİR aynı
 * kaldığının canlı diferansiyel doğrulaması.
 *
 * ═══ NORMATİF REFERANS — eski uygulama ═══
 *
 * 44d9c5f öncesinde sayfa örnekleri tek tek çekiyor ve kararı `dayFlags()`e bırakıyordu:
 *
 *     const overviewRows = await paymentOverviewInstances(pool, today, futureEnd);
 *     // pencere:  due_date <= futureEnd
 *     //       and (due_date >= today or status in ('unpaid','partial','planned','late'))
 *     for (const row of overviewRows) {
 *       if (row.due_date < today || row.due_date > riskEnd) continue;   // riskEnd = today + 30g
 *       riskBuckets.get(row.due_date).push(row);
 *     }
 *     const risky = [...riskBuckets.entries()].filter(([, rows]) => {
 *       const flags = dayFlags(rows.map((r) => ({ id: r.id, dueDate: r.due_date,
 *                                                 amount: r.amount, status: r.status })), thresholds);
 *       return flags.cluster || flags.critical || flags.large;
 *     });
 *
 * ve `dayFlags()` (src/lib/radar/rules.ts — DEĞİŞMEDİ, bu turun ölçütü odur):
 *
 *     const open = dayInstances.filter((i) => isOpen(i.status));     // unpaid|partial|planned|late
 *     knownSum   = Σ decimal(i.amount)  where amount != null && amount > 0
 *     anyCritical= open.some((i) => i.amount != null && i.amount >= t.critical);
 *     anyLarge   = open.some((i) => i.amount != null && i.amount >= t.large);
 *     return { count: open.length, knownSum,
 *              cluster:  open.length >= t.clusterCount,
 *              large:    anyLarge,
 *              critical: anyCritical || knownSum >= t.critical };
 *
 * ═══ HIZLANDIRMANIN GETİRDİĞİ SAPMALAR ═══
 *
 * 44d9c5f kararı toplanmış satırlardan yeniden yazdı:
 *
 *     bucketCount(rows) >= clusterCount
 *       || rows.some((row) => (row.maxAmount ?? 0) >= large)
 *       || bucketTotal(rows) >= critical
 *
 *   (1) `maxAmount`/`bucketTotal` `remaining` (= amount − paid_amount) üzerindeydi; `dayFlags`
 *       ise `amount` üzerinde. Kısmi ödenmiş bir kalem eşiğin altına DÜŞÜYORDU.
 *   (2) Sayım, SQL'in `active` kümesindendi ve o küme `'unknown'` statüsünü İÇERİYOR;
 *       `OPEN_STATUSES` içermiyor. `unknown` kalemler kümeyi şişirip `cluster`ı erken ateşliyordu.
 *
 * Üçüncü bir fark daha vardı — `anyCritical` dalının düşmesi — ama ÖLÇÜLDÜĞÜNDE bunun sonucu
 * değiştiremediği çıktı: `anyCritical` true ise o kalem `knownSum`a da girer, dolayısıyla
 * `knownSum >= critical` zaten sağlanır. Aşağıda 11.310 kombinasyonla taranıyor. Dal referansta
 * olduğu için korundu, ama tek başına bir hata değildi; bunu ayrı bir bulgu saymak yanlış olur.
 *
 * Bu script sapmaları kapatan kodu ölçer: aynı fixture üzerinde ESKİ yol
 * (`paymentOverviewInstances` + `dayFlags`) ile YENİ yol (`loadPaymentDashboard` +
 * `dayFlagsFromAggregate`) çalıştırılır ve beş alanın (count · knownSum · cluster · large ·
 * critical) TAMAMI karşılaştırılır.
 *
 * Beklenen değer ürün kodundan gelmiyor: eski uygulama referans, yeni uygulama ölçülen. Ayrıca
 * her vaka için elle yazılmış beklenen bayraklar da ayrıca doğrulanır.
 *
 * ═══ GÜVENLİK ═══
 *
 * Fixture YAZAR. Hedef adıyla harcanabilir olduğunu söylemek zorundadır
 * (`requireDisposableOwnerDatabaseUrl`); `mas_radar_dev` reddedilir. Temizlik bir transaction
 * ROLLBACK'idir — hiçbir satır kalıcı olmaz, hiçbir invariant delinmez.
 */
import { Client } from "pg";
import type { Pool } from "pg";
import { requireDisposableOwnerDatabaseUrl } from "./owner-url";
import type { RiskThresholds } from "../../src/lib/radar/rules";

const MARK = "IX-DAYFLAG-";

/** Eşik kurulumları. `large`/`critical` sırası ürün kuralında serbest — üçünü de sınıyoruz. */
const THRESHOLD_SETS = [
  { name: "large < critical  (ölçülen kurulum)", t: { large: 50_000, critical: 100_000, clusterCount: 3 } },
  { name: "large = critical", t: { large: 100_000, critical: 100_000, clusterCount: 3 } },
  { name: "large > critical  (anyLarge artık kritiği örtmüyor)", t: { large: 250_000, critical: 100_000, clusterCount: 3 } },
  { name: "kümelenme eşiği yüksek (cluster susturulur)", t: { large: 1_000_000, critical: 100_000, clusterCount: 99 } },
] as const;

interface Fixture {
  offset: number;
  case: string;
  rows: Array<{ amount: number | null; status: string; paidAmount?: number | null }>;
  /** Elle yazılmış beklenen — ÖLÇÜLEN kurulum (large=50k, critical=100k, cluster=3) için. */
  expect: { count: number; knownSum: number; cluster: boolean; large: boolean; critical: boolean };
}

const FIXTURES: Fixture[] = [
  { offset: 501, case: "ödenmemiş tam tutar", rows: [{ amount: 60_000, status: "unpaid" }],
    expect: { count: 1, knownSum: 60_000, cluster: false, large: true, critical: false } },

  { offset: 502, case: "kısmi ödeme — eşik AMOUNT'a bakar, kalana değil",
    rows: [{ amount: 80_000, status: "partial", paidAmount: 45_000 }],
    expect: { count: 1, knownSum: 80_000, cluster: false, large: true, critical: false } },

  { offset: 503, case: "ödenmiş ve iptal edilmiş HARİÇ",
    rows: [{ amount: 900_000, status: "paid", paidAmount: 900_000 }, { amount: 900_000, status: "cancelled" }],
    expect: { count: 0, knownSum: 0, cluster: false, large: false, critical: false } },

  { offset: 504, case: "tek kalem kritiği aşıyor", rows: [{ amount: 150_000, status: "unpaid" }],
    expect: { count: 1, knownSum: 150_000, cluster: false, large: true, critical: true } },

  { offset: 505, case: "toplam kritiği aşıyor (tek tek hiçbiri aşmıyor)",
    rows: [{ amount: 45_000, status: "unpaid" }, { amount: 60_000, status: "planned" }],
    expect: { count: 2, knownSum: 105_000, cluster: false, large: true, critical: true } },

  { offset: 506, case: "yalnız büyük eşiği aşıyor", rows: [{ amount: 60_000, status: "late" }],
    expect: { count: 1, knownSum: 60_000, cluster: false, large: true, critical: false } },

  { offset: 507, case: "tutar NULL — bilinmeyen, sıfır değil",
    rows: [{ amount: null, status: "unpaid" }, { amount: null, status: "unpaid" }],
    expect: { count: 2, knownSum: 0, cluster: false, large: false, critical: false } },

  { offset: 508, case: "aynı günde çok ödeme — kümelenme",
    rows: [{ amount: 1_000, status: "unpaid" }, { amount: 1_000, status: "unpaid" },
           { amount: 1_000, status: "planned" }, { amount: 1_000, status: "late" }],
    expect: { count: 4, knownSum: 4_000, cluster: true, large: false, critical: false } },

  { offset: 509, case: "'unknown' statü — OPEN_STATUSES DIŞINDA, sayımı şişirmemeli",
    rows: [{ amount: 500_000, status: "unknown" }, { amount: 500_000, status: "unknown" },
           { amount: 500_000, status: "unknown" }, { amount: 1_000, status: "unpaid" }],
    expect: { count: 1, knownSum: 1_000, cluster: false, large: false, critical: false } },

  { offset: 510, case: "sıfır ve negatif tutar",
    rows: [{ amount: 0, status: "unpaid" }, { amount: -5_000, status: "unpaid" }],
    expect: { count: 2, knownSum: 0, cluster: false, large: false, critical: false } },

  { offset: 511, case: "neredeyse tamamı ödenmiş — kalan 1.000 TL, AMOUNT 120.000 TL",
    rows: [{ amount: 120_000, status: "partial", paidAmount: 119_000 }],
    expect: { count: 1, knownSum: 120_000, cluster: false, large: true, critical: true } },
];

type Flags = { count: number; knownSum: number; cluster: boolean; large: boolean; critical: boolean };
const fmt = (f: Flags) =>
  `count=${f.count} knownSum=${f.knownSum} cluster=${f.cluster} large=${f.large} critical=${f.critical}`;

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) { pass += 1; console.log(`  PASS  ${label}`); }
  else { fail += 1; console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ""}`); }
}

async function main() {
  const client = new Client({ connectionString: requireDisposableOwnerDatabaseUrl() });
  await client.connect();
  const dbName = (await client.query("select current_database() as d")).rows[0].d as string;
  console.log(`Hedef veritabanı: ${dbName}\n`);

  // `Pool` ile `Client` bu çağrılar için aynı yüzeyi (query) paylaşıyor. Tek bir bağlantıda
  // kalmak ZORUNLU: fixture'lar açık bir transaction içinde ve yalnız o bağlantıdan görülüyor.
  const pool = client as unknown as Pool;

  const today = (await client.query("select current_date::text as d")).rows[0].d as string;
  const anchor = new Date(`${today}T00:00:00Z`);
  const futureEnd = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 24, anchor.getUTCDate()))
    .toISOString().slice(0, 10);

  // Fixture yazmak ve okumak RLS altında bir KATMAN rolü ister; bağlantı `mas_radar_app` olarak
  // açılıyor ve o rolün `payment_instances` üzerinde hiçbir politikası yok (yazma da okuma da
  // reddedilir). `set role` politikaları DELMİYOR — yalnız ürünün gerçekte kullandığı katmandan
  // konuşuyor. Rol transaction ile birlikte geri alınır.
  await client.query("begin");
  await client.query("set local role mas_radar_admin");
  try {
    // Fixture penceresi ÇALIŞMA ANINDA seçiliyor. Sabit bir gün aralığı yazmak, seed verisi bir
    // gün o günlere dokunduğunda testi sessizce "başka satırlarla karışmış" hâle getirirdi;
    // bulunan pencere `FIXTURES.length` gün boyunca gerçekten BOŞ olmak zorunda.
    const occupied = new Set(
      (await client.query(
        `select (due_date - current_date)::int as off from public.payment_instances
          where due_date between current_date + 300 and current_date + 700`,
      )).rows.map((r) => Number(r.off)),
    );
    const freeOffsets: number[] = [];
    for (let candidate = 300; candidate <= 700 && freeOffsets.length < FIXTURES.length; candidate += 1) {
      if (!occupied.has(candidate)) freeOffsets.push(candidate);
    }
    if (freeOffsets.length < FIXTURES.length) {
      throw new Error(`300–700 gün aralığında yalnız ${freeOffsets.length} boş gün var; ${FIXTURES.length} gerekiyor.`);
    }
    console.log(`Fixture günleri: bugün + ${freeOffsets.join(", +")} (her biri boş doğrulandı)`);

    const dates = new Map<number, string>();
    for (const [index, f] of FIXTURES.entries()) {
      const d = (await client.query("select (current_date + $1::int)::text as d", [freeOffsets[index]])).rows[0].d as string;
      dates.set(f.offset, d);
      const existing = await client.query("select count(*)::int c from public.payment_instances where due_date=$1", [d]);
      if (existing.rows[0].c !== 0) {
        throw new Error(`${d} tarihinde zaten ${existing.rows[0].c} kayıt var; fixture penceresi temiz değil.`);
      }
      for (const [i, r] of f.rows.entries()) {
        const paidAt = r.status === "paid" || r.paidAmount != null ? `${d}T09:00:00Z` : null;
        await client.query(
          `insert into public.payment_instances
             (id, payment_id, instance_month, due_date, amount, currency, amount_status, direction,
              status, paid_amount, paid_at, risk_level, risk_reasons, note, amount_source,
              cancelled_at, cancel_reason)
           values (gen_random_uuid(), null, date_trunc('month',$1::date)::date, $1::date, $2,
                   'TRY', $3, 'outflow', $4, $5, $6, 'none', '{}', $7, 'manual',
                   case when $4 = 'cancelled' then now() end,
                   case when $4 = 'cancelled' then 'fixture' end)`,
          [d, r.amount, r.amount == null ? "missing" : "known", r.status,
            r.paidAmount ?? null, paidAt, `${MARK}${f.offset}-${i}`],
        );
      }
    }
    console.log(`${FIXTURES.length} gün için fixture yazıldı (transaction içinde).\n`);

    const { paymentOverviewInstances, loadPaymentDashboard, dayFlagsForDate } = await import("../../src/lib/radar/queries");
    const { dayFlags } = await import("../../src/lib/radar/rules");

    const overviewRows = await paymentOverviewInstances(pool, today, futureEnd);
    const { buckets } = await loadPaymentDashboard(pool, today, futureEnd);

    const byDateRef = new Map<string, Array<{ id: string; dueDate: string; amount: number | null; status: string; currency: string | null }>>();
    for (const row of overviewRows) {
      const list = byDateRef.get(row.due_date) ?? [];
      // PHASE 2.2 (T1-a): dayFlags artık para birimi ister; BASE `i.currency`'yi seçer.
      list.push({ id: row.id, dueDate: row.due_date, amount: row.amount, status: row.status, currency: row.currency ?? null });
      byDateRef.set(row.due_date, list);
    }
    // Sayfanin cagirdigi fonksiyonun TA KENDISI — burada yeniden yazilmis bir kopyasi degil.
    const actual = (date: string, t: RiskThresholds) => dayFlagsForDate(buckets, date, t);
    // Ham toplamlar yalniz "hangi alan neyi tasiyor" kontrolleri icin.
    const rawAgg = (date: string) => {
      const rows = buckets.filter((b) => b.dueDate === date);
      return {
        openCount: rows.reduce((s, b) => s + b.openCount, 0),
        knownSum: rows.reduce((s, b) => s + b.flagKnownSum, 0),
        maxAmount: rows.reduce<number | null>(
          (m, b) => (b.flagMaxAmount != null && (m == null || b.flagMaxAmount > m) ? b.flagMaxAmount : m), null),
      };
    };

    // ── 1. DİFERANSİYEL: eski yol === yeni yol, PENCEREDEKİ HER GÜN, HER EŞİK KURULUMU ──────
    const allDates = [...new Set([...byDateRef.keys(), ...buckets.map((b) => b.dueDate)])].sort();
    console.log(`── Diferansiyel: ${allDates.length} gün × ${THRESHOLD_SETS.length} eşik kurulumu ──`);
    for (const set of THRESHOLD_SETS) {
      const diffs: string[] = [];
      for (const date of allDates) {
        const ref = dayFlags(byDateRef.get(date) ?? [], set.t);
        const act = actual(date, set.t);
        if (fmt(ref) !== fmt(act)) diffs.push(`${date}\n          eski: ${fmt(ref)}\n          yeni: ${fmt(act)}`);
      }
      check(`${set.name} — ${allDates.length} günün tamamı eski dayFlags() ile aynı`,
        diffs.length === 0, diffs.slice(0, 5).join("\n        "));
    }

    // ── 2. VAKA MATRİSİ: elle yazılmış beklenenler (ölçülen kurulum) ────────────────────────
    const measured = THRESHOLD_SETS[0].t;
    console.log(`\n── Vaka matrisi (large=${measured.large} critical=${measured.critical} cluster=${measured.clusterCount}) ──`);
    for (const f of FIXTURES) {
      const date = dates.get(f.offset)!;
      const act = actual(date, measured);
      check(`${f.case}`, fmt(act) === fmt(f.expect), `beklenen: ${fmt(f.expect)}\n        ölçülen : ${fmt(act)}`);
    }

    // ── 3. SAPMALARIN AÇIKÇA ADLANDIRILDIĞI KONTROLLER ──────────────────────────────────────
    console.log("\n── Hızlandırmanın getirdiği sapmalar kapalı mı ──");
    const d511 = rawAgg(dates.get(511)!);
    check("kısmi ödenmiş kalem AMOUNT ile tartılıyor (remaining ile değil)",
      d511.knownSum === 120_000 && d511.maxAmount === 120_000,
      `knownSum=${d511.knownSum} maxAmount=${d511.maxAmount} — kalan 1.000 TL olsaydı iki değer de 1.000 olurdu`);

    const bigLarge = { large: 250_000, critical: 100_000, clusterCount: 99 };
    const d504 = actual(dates.get(504)!, bigLarge);
    check("large > critical kurulumunda 150.000 TL'lik gün kritik sayılıyor",
      d504.large === false && d504.critical === true,
      `large=${d504.large} critical=${d504.critical}`);

    const d509 = rawAgg(dates.get(509)!);
    check("'unknown' statü sayıma girmiyor",
      d509.openCount === 1 && d509.knownSum === 1_000 && d509.maxAmount === 1_000,
      `openCount=${d509.openCount} knownSum=${d509.knownSum} maxAmount=${d509.maxAmount} — 'unknown' sayılsaydı 4 / 1.501.000 / 500.000 olurdu`);

    // ── 3B. `anyCritical` DALI GERÇEKTEN GEREKLİ Mİ — kaba kuvvetle ─────────────────────────
    //
    // 44d9c5f `anyCritical`ı düşürmüştü ve bunu üçüncü bir hata olarak raporlamak isterdik. Ama
    // iddia ölçülmeden yazılmaz: dalı düşürüp bu scripti çalıştırdığımızda TEK bir test bile
    // kırmızıya dönmedi. Nedeni aşağıda kanıtlanıyor — `anyCritical` true olan her girdide
    // `knownSum >= critical` de true. Dal referansta olduğu için korunuyor; hata olarak
    // sayılmıyor. Bu tarama, `knownSum`un tanımı ileride değişirse iddianın da bozulacağını
    // görebilmek için burada duruyor.
    {
      const AMOUNTS = [null, -100_000, -1, 0, 1, 49_999, 50_000, 99_999, 100_000, 100_001, 250_000, 1_000_000];
      const CRITS = [-1_000, 0, 1, 50_000, 100_000, 250_000];
      const combos = (n: number): (number | null)[][] =>
        n === 0 ? [[]] : AMOUNTS.flatMap((a) => combos(n - 1).map((rest) => [a, ...rest]));
      let counter = 0;
      let scanned = 0;
      for (const size of [0, 1, 2, 3]) {
        for (const day of combos(size)) {
          for (const critical of CRITS) {
            scanned += 1;
            const knownSum = day.reduce<number>((sum, a) => (a != null && a > 0 ? sum + a : sum), 0);
            const anyCritical = day.some((a) => a != null && a >= critical);
            if (anyCritical && !(knownSum >= critical)) counter += 1;
          }
        }
      }
      check(`anyCritical dalı sonucu değiştiremiyor (${scanned} kombinasyon, karşı örnek ${counter})`,
        counter === 0, "karşı örnek bulunduysa dal GEREKLİ demektir ve bu yorum güncellenmeli");
    }

    // ── 4. GÖRÜNTÜLEME ALANLARI KORUNDU MU (risk alanları onları ezmemeli) ──────────────────
    console.log("\n── Görüntüleme alanları (remaining tabanlı) dokunulmadan duruyor mu ──");
    const b511 = buckets.filter((b) => b.dueDate === dates.get(511)!);
    check("knownAmount hâlâ kalan tutarı ('baskı') gösteriyor",
      b511.reduce((s, b) => s + b.knownAmount, 0) === 1_000,
      `ölçülen: ${b511.reduce((s, b) => s + b.knownAmount, 0)}`);
    check("maxAmount hâlâ kalan tutar üzerinden",
      b511.length === 1 && b511[0].maxAmount === 1_000, `ölçülen: ${b511[0]?.maxAmount}`);
  } finally {
    await client.query("rollback");
    await client.end();
  }

  // Kalıntı kontrolü AYRI bir bağlantıdan: rollback'in gerçekten iş gördüğünü kanıtlar.
  const auditor = new Client({ connectionString: requireDisposableOwnerDatabaseUrl() });
  await auditor.connect();
  await auditor.query("set role mas_radar_admin");
  const left = await auditor.query("select count(*)::int c from public.payment_instances where note like $1", [`${MARK}%`]);
  await auditor.end();
  console.log(`\nRollback sonrası kalan fixture satırı: ${left.rows[0].c}`);
  check("fixture'lar kalıcı olmadı", left.rows[0].c === 0);

  console.log(`\n${pass} PASS · ${fail} FAIL`);
  if (fail > 0) process.exit(1);
}

main().catch((error) => { console.error(error); process.exit(1); });
