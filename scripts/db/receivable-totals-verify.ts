/**
 * Alacak/borç KPI'larının LİSTE LİMİTİNDEN BAĞIMSIZ olduğunun canlı doğrulaması.
 *
 * ═══ NEYİ İSPATLAR ═══
 *
 * `/finance/receivables` ekranı `recTotal`, yaşlandırma kovaları ve gecikmiş sayacını LİSTEYE
 * gelen satırlardan hesaplıyordu. Liste `loadReceivables(pool, 75)` ile sınırlı olduğu için
 * ekrandaki "AÇIK ALACAK" aslında "en büyük 75 alacağın toplamı"ydı — 75'in üzerinde açık kayıt
 * olduğunda her rakam gerçeğin altında kalıyordu ve bunu söyleyen hiçbir şey yoktu.
 *
 * Bu script 120 fixture faturayla o durumu ÜRETİR ve toplamların artık limitten etkilenmediğini
 * ölçer. Yalnız "kod çalışıyor" demez; limiti 5'e indirip aynı toplamların çıktığını da gösterir.
 *
 * ═══ BEKLENEN DEĞERLER NEREDEN GELİYOR ═══
 *
 * Rehber §30.2: expected = BAĞIMSIZ hesap, actual = ürün kodu. Buradaki beklenenler:
 *   · view'a hiç dokunmayan, `public.invoices` üzerinden AYRI yazılmış SQL, ve
 *   · sınır vakaları için elle aritmetik (fixture üretilirken kova ataması elle yazılır).
 * Hiçbir beklenen değer `loadReceivableTotals` çağrılarak üretilmez — öyle olsaydı test
 * yalnızca "fonksiyon kendisiyle tutarlı" derdi.
 *
 * ═══ GÜVENLİK ═══
 *
 * Bu script fixture YAZAR. Hedef, adıyla harcanabilir olduğunu söylemek zorundadır
 * (`requireDisposableOwnerDatabaseUrl`) — `mas_radar_dev` ve diğer korunan adlar reddedilir.
 *
 * TEMİZLİK BİR TRANSACTION ROLLBACK'İDİR, DELETE DEĞİL. İlk yazımda fixture'lar silinerek
 * temizleniyordu ve ürün bunu HAKLI OLARAK reddetti:
 *
 *     invoices.<id>: düzenlenmiş fatura silinemez (durum=open).
 *     İptal, bağlı bir reversal kaydıyla yapılır.        [invoices_block_issued_delete]
 *
 * Bu, Faz 21'in "düzenlenmiş faturanın ticari içeriği değişmez" invariant'ı. Tetikleyici yalnız
 * `draft` silmeye izin veriyor; fixture'ı taslağa çevirip silmek teknik olarak mümkündü ama o da
 * ürünün asla izin vermeyeceği bir geçiş olurdu. Bunun yerine her şey tek bir transaction içinde
 * yapılır ve SONUNDA ROLLBACK edilir: hiçbir satır kalıcı olmaz, hiçbir invariant delinmez,
 * tetikleyici hiç ateşlenmez.
 *
 * Kullanım:
 *   MIGRATION_DATABASE_URL=postgres://…/mas_radar_…_verify pnpm db:receivable-totals:verify
 */

import { Pool, type PoolClient } from "pg";
import { requireDisposableOwnerDatabaseUrl } from "./owner-url";

const MARK = "IX-RECV-";
const LIST_LIMIT = 75;

interface Case {
  name: string;
  pass: boolean;
  detail: string;
}

const results: Case[] = [];
function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
}

/**
 * Fixture planı — kova ataması ELLE yazılır, koddan türetilmez.
 *
 * `offset` = bugünden kaç gün ÖNCE vadesi doldu (negatif = gelecek). `collectionBucket()`:
 *   days <= 0 → vadesi gelmemiş · <= 7 → 1-7 gün · <= 30 → 8-30 · <= 60 → 31-60 · aksi → 60+
 * Sınırlar (0, 7, 8, 30, 31, 60, 61) bilerek tek tek yazıldı.
 */
const BOUNDARY: Array<{ offset: number | null; bucket: string; amount: number }> = [
  { offset: -5, bucket: "vadesi gelmemiş", amount: 100 },
  { offset: 0, bucket: "vadesi gelmemiş", amount: 200 },
  { offset: 1, bucket: "1-7 gün", amount: 300 },
  { offset: 7, bucket: "1-7 gün", amount: 400 },
  { offset: 8, bucket: "8-30 gün", amount: 500 },
  { offset: 30, bucket: "8-30 gün", amount: 600 },
  { offset: 31, bucket: "31-60 gün", amount: 700 },
  { offset: 60, bucket: "31-60 gün", amount: 800 },
  { offset: 61, bucket: "60+ gün", amount: 900 },
  { offset: 400, bucket: "60+ gün", amount: 1_000 },
  { offset: null, bucket: "tarihsiz", amount: 1_100 },
];

async function main(): Promise<void> {
  const connectionString = requireDisposableOwnerDatabaseUrl("receivable-totals-verify");
  const realPool = new Pool({ connectionString, max: 4 });
  const client: PoolClient = await realPool.connect();

  /**
   * Yükleyiciler `Pool` bekliyor ama YALNIZ `.query()` çağırıyorlar (loadOpen, loadOpenTotals).
   * Fixture'ın rollback edilebilmesi için hepsinin AYNI bağlantıda koşması şart — havuz her
   * sorguya farklı bağlantı verebilir ve transaction dışında kalırlardı. Tek, belgeli bir cast;
   * `.connect()`/`.end()` çağıran bir yükleyici eklenirse bu varsayım kırılır ve burada durur.
   */
  const pool = client as unknown as Pool;

  try {
    const live = await client.query<{ db: string }>("select current_database() as db");
    console.log(`Hedef veritabanı: ${live.rows[0].db}`);
    await client.query("begin");
    // RLS altında fixture yazmak ve okumak bir KATMAN rolü ister. Bağlantı hangi kullanıcıyla
    // açıldıysa açılsın (uygulama URL'i `mas_radar_app` verir ve o rolün `parties`/`invoices`
    // üzerinde politikası YOKTUR — sessizce 0 satır görür), script buradan itibaren ürünün
    // gerçekten kullandığı katmandan konuşur. `set local`: rol transaction ile geri alınır.
    await client.query("set local role mas_radar_admin");

    const party = await pool.query<{ id: string }>("select id from public.parties limit 1");
    if (party.rowCount !== 1) throw new Error("parties boş — referans seed uygulanmamış.");
    const partyId = party.rows[0].id;

    // ── Fixture ────────────────────────────────────────────────────────────────────────
    // (a) Sınır vakaları — her biri elle atanmış kovaya düşmeli.
    for (const [index, row] of BOUNDARY.entries()) {
      await pool.query(
        `insert into public.invoices
           (direction, invoice_no, party_id, issue_date, due_date, net_amount, tax_amount, gross_amount, allocated_amount, status)
         values ('sales', $1, $2, current_date - 500,
                 case when $3::int is null then null else current_date - $3::int end,
                 $4::numeric, 0, $4::numeric, 0, 'open')`,
        [`${MARK}B${index}`, partyId, row.offset, row.amount],
      );
    }

    // (b) Listeyi taşıracak hacim: 110 açık fatura, hepsi "60+ gün" kovasında, her biri 10 TL.
    //     Toplam 1.100 TL. Liste 75 satır gösterecek, toplam 121 kaydı kapsayacak.
    await pool.query(
      `insert into public.invoices
         (direction, invoice_no, party_id, issue_date, due_date, net_amount, tax_amount, gross_amount, allocated_amount, status)
       select 'sales', '${MARK}V' || g, $1, current_date - 500, current_date - 200, 10, 0, 10, 0, 'open'
       from generate_series(1, 110) g`,
      [partyId],
    );

    // (c) HARİÇ TUTULMASI GEREKENLER — view'ın filtresi bunları elemeli.
    await pool.query(
      `insert into public.invoices
         (direction, invoice_no, party_id, issue_date, due_date, net_amount, tax_amount, gross_amount, allocated_amount, status)
       values
         -- kapanmış fatura: status open/partial değil
         ('sales',    '${MARK}X-paid',      $1, current_date - 100, current_date - 50, 5000, 0, 5000, 5000, 'paid'),
         -- tamamen dağıtılmış: gross > allocated koşulunu geçmez
         ('sales',    '${MARK}X-alloc',     $1, current_date - 100, current_date - 50, 7000, 0, 7000, 7000, 'open'),
         -- alış faturası: receivables_open yalnız 'sales' alır
         ('purchase', '${MARK}X-purchase',  $1, current_date - 100, current_date - 50, 9000, 0, 9000, 0, 'open'),
         -- taslak: status filtresi dışında
         ('sales',    '${MARK}X-draft',     $1, current_date - 100, current_date - 50, 3000, 0, 3000, 0, 'draft')`,
      [partyId],
    );

    // ── BAĞIMSIZ BEKLENENLER: view'a değil, ham invoices tablosuna sorulur ─────────────
    const expected = await pool.query<{
      item_count: string; total_open: string; overdue_count: string;
    }>(
      `select count(*)::int as item_count,
              coalesce(sum(gross_amount - allocated_amount), 0) as total_open,
              count(*) filter (where due_date is not null and (current_date - due_date) > 0)::int as overdue_count
         from public.invoices
        where invoice_no like $1
          and direction = 'sales'
          and status in ('open','partial')
          and gross_amount > allocated_amount`,
      [`${MARK}%`],
    );
    const exp = expected.rows[0];
    const expectedCount = Number(exp.item_count);
    const expectedTotal = Number(exp.total_open);
    const expectedOverdue = Number(exp.overdue_count);

    // Elle aritmetik kontrolü: 11 sınır + 110 hacim = 121 kayıt.
    // Sınır tutarları 100+200+…+1100 = 6.600; hacim 110 × 10 = 1.100 → 7.700 TL.
    const manualCount = BOUNDARY.length + 110;
    const manualTotal = BOUNDARY.reduce((n, r) => n + r.amount, 0) + 110 * 10;
    check(
      "fixture elle aritmetikle uyuşuyor (bağımsız SQL ile çapraz kontrol)",
      expectedCount === manualCount && expectedTotal === manualTotal,
      `SQL: ${expectedCount} kayıt / ${expectedTotal} TL · elle: ${manualCount} / ${manualTotal}`,
    );

    // ── ÜRÜN KODU ─────────────────────────────────────────────────────────────────────
    // src/ modülleri ancak hedef doğrulandıktan SONRA yüklenir (fail-closed refleksi).
    const [{ loadReceivables, loadReceivableTotals }, { istanbulDateISO }] = await Promise.all([
      import("../../src/lib/receivables/engine"),
      import("../../src/lib/reports/rules"),
    ]);
    const today = istanbulDateISO();

    const list = await loadReceivables(pool, LIST_LIMIT);
    const totals = await loadReceivableTotals(pool, today);

    check(
      `liste yalnız ilk ${LIST_LIMIT} satırı döndürüyor`,
      list.length === LIST_LIMIT,
      `liste=${list.length}, uygun kayıt=${expectedCount}`,
    );
    check(
      "KPI kayıt sayısı listeyi DEĞİL bütün uygun kayıtları sayıyor",
      totals.itemCount === expectedCount,
      `totals.itemCount=${totals.itemCount}, beklenen=${expectedCount}, liste=${list.length}`,
    );
    check(
      "KPI toplamı 121 kaydın tamamını içeriyor",
      totals.totalOpenAmount === expectedTotal,
      `totals=${totals.totalOpenAmount}, beklenen=${expectedTotal}`,
    );
    check(
      "gecikmiş sayacı bütün uygun satırları sayıyor",
      totals.overdueCount === expectedOverdue,
      `totals.overdueCount=${totals.overdueCount}, beklenen=${expectedOverdue}`,
    );

    // ── Mutabakat: kovaların toplamı = genel toplam ────────────────────────────────────
    const bucketAmount = totals.ageing.reduce((n, b) => n + b.amount, 0);
    const bucketCount = totals.ageing.reduce((n, b) => n + b.count, 0);
    check(
      "yaşlandırma kovalarının tutar toplamı genel toplamla mutabık",
      bucketAmount === totals.totalOpenAmount,
      `kova toplamı=${bucketAmount}, genel=${totals.totalOpenAmount}`,
    );
    check(
      "yaşlandırma kovalarının kayıt sayısı toplamı genel sayıyla mutabık",
      bucketCount === totals.itemCount,
      `kova adedi=${bucketCount}, genel=${totals.itemCount}`,
    );

    // ── Sınır vakaları: her biri ELLE atanmış kovada mı ────────────────────────────────
    const expectedByBucket = new Map<string, { count: number; amount: number }>();
    for (const row of BOUNDARY) {
      const current = expectedByBucket.get(row.bucket) ?? { count: 0, amount: 0 };
      expectedByBucket.set(row.bucket, { count: current.count + 1, amount: current.amount + row.amount });
    }
    // 110 hacim faturası da "60+ gün"e düşer (vade bugünden 200 gün önce).
    const volume = expectedByBucket.get("60+ gün") ?? { count: 0, amount: 0 };
    expectedByBucket.set("60+ gün", { count: volume.count + 110, amount: volume.amount + 110 * 10 });

    for (const [bucket, want] of expectedByBucket) {
      const got = totals.ageing.find((b) => b.bucket === bucket);
      check(
        `kova sınırı doğru: ${bucket}`,
        got !== undefined && got.count === want.count && got.amount === want.amount,
        `gerçek=${got ? `${got.count}/${got.amount}` : "YOK"}, beklenen=${want.count}/${want.amount}`,
      );
    }

    // ── ASIL INVARIANT: liste limiti toplamları DEĞİŞTİRMEZ ───────────────────────────
    const tinyList = await loadReceivables(pool, 5);
    const totalsAgain = await loadReceivableTotals(pool, today);
    check(
      "liste limiti 5'e indirilince toplamlar DEĞİŞMİYOR",
      tinyList.length === 5 &&
        totalsAgain.totalOpenAmount === totals.totalOpenAmount &&
        totalsAgain.itemCount === totals.itemCount &&
        totalsAgain.overdueCount === totals.overdueCount,
      `liste=${tinyList.length}, toplam=${totalsAgain.totalOpenAmount} (önce ${totals.totalOpenAmount})`,
    );

    // ── Hariç tutulanlar gerçekten dışarıda mı ────────────────────────────────────────
    // Dört hariç kayıt 5000+7000+9000+3000 = 24.000 TL taşıyor; biri bile sızsaydı toplam şişerdi.
    check(
      "paid / tam dağıtılmış / purchase / draft kayıtlar toplamın DIŞINDA",
      totals.totalOpenAmount === manualTotal,
      `toplam=${totals.totalOpenAmount}, hariçler sızsaydı ≥ ${manualTotal + 24_000} olurdu`,
    );

    // ── Borç tarafı da aynı yoldan geliyor mu ─────────────────────────────────────────
    const { loadPayableTotals } = await import("../../src/lib/receivables/engine");
    const payTotals = await loadPayableTotals(pool, today);
    const expectedPay = await pool.query<{ total_open: string; item_count: string }>(
      `select coalesce(sum(gross_amount - allocated_amount),0) as total_open, count(*)::int as item_count
         from public.invoices
        where direction = 'purchase' and status in ('open','partial') and gross_amount > allocated_amount`,
    );
    check(
      "borç toplamı da aynı limitsiz yoldan geliyor",
      payTotals.totalOpenAmount === Number(expectedPay.rows[0].total_open) &&
        payTotals.itemCount === Number(expectedPay.rows[0].item_count),
      `payTotals=${payTotals.itemCount}/${payTotals.totalOpenAmount}, beklenen=${expectedPay.rows[0].item_count}/${expectedPay.rows[0].total_open}`,
    );
  } finally {
    // ROLLBACK — fixture hiç var olmamış gibi. `invoices_block_issued_delete` bu yolda hiç
    // ateşlenmez, çünkü silme yok.
    await client.query("rollback").catch(() => {});
    client.release();

    // Kalıntı kontrolü AYRI bir bağlantıdan: rollback'in gerçekten işe yaradığı, aynı
    // transaction'dan bakılarak "doğrulanamaz". "Temizlik no-op değildi" iddiası ölçülür.
    const auditor = await realPool.connect();
    await auditor.query("set role mas_radar_admin");
    const leftover = await auditor.query<{ n: string }>(
      `select count(*)::int as n from public.invoices where invoice_no like '${MARK}%'`,
    );
    auditor.release();
    const remaining = Number(leftover.rows[0].n);
    console.log(`\nRollback sonrası kalan fixture satırı: ${remaining}`);
    if (remaining !== 0) {
      console.error(`TEMİZLİK BAŞARISIZ: ${remaining} fixture satırı kaldı.`);
      process.exitCode = 1;
    }
    await realPool.end();
  }

  console.log("\n=== Özet ===");
  let pass = 0;
  for (const r of results) {
    console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}`);
    if (!r.pass) console.log(`      ${r.detail}`);
    if (r.pass) pass++;
  }
  console.log(`\n${pass}/${results.length} test geçti`);
  if (pass !== results.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error("receivable-totals-verify beklenmedik hata ile durdu:", err);
  process.exit(1);
});
