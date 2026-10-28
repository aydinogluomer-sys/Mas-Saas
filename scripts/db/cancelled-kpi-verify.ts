/**
 * İptal edilmiş ödeme örneklerinin ödeme yükü KPI'larından dışlandığının canlı doğrulaması.
 *
 * ═══ SABİTLENEN KURAL ═══
 *
 * `status='cancelled'` ya da `cancelled_at` dolu bir payment instance:
 *
 *   · bugün toplamına girmez          · gecikmiş/açık toplamlara girmez
 *   · yarın toplamına girmez          · öncelikli ödemelere girmez
 *   · 7 günlük çıkışa girmez          · riskli gün hesabına girmez
 *   · grafiğin açık ödeme serisine girmez
 *   · /payments/history üzerinde GÖRÜNMEYE DEVAM EDER
 *
 * Kural burada icat edilmiyor; üç ayrı yerde zaten yazılı:
 *   src/lib/radar/rules.ts         OPEN_STATUSES = unpaid|partial|planned|late
 *   docs/calculation-rules.md      "Ödenmiş/iptal kayıtlar risk almaz."
 *   tests/visual/golden-ui-smoke   OPEN = "status <> 'paid' and cancelled_at is null"
 *
 * ═══ NEDEN FARK ÖLÇÜLÜYOR, MUTLAK DEĞER DEĞİL ═══
 *
 * Veritabanında zaten veri var ve "bugün toplamı 1.234.567 olmalı" biçiminde bir beklenen
 * yazmak, seed her değiştiğinde kırılan ve kimsenin güvenmediği bir test üretir. Bunun yerine
 * her ölçüm ÖNCE/SONRA alınıp FARKA bakılıyor — kuralın iddiası zaten bir fark iddiası:
 * "iptal eklenince hiçbir şey değişmez, açık eşdeğeri eklenince tam tutar kadar artar."
 * Beklenen farklar elle aritmetikle yazıldı ve ayrıca ürüne hiç dokunmayan bağımsız bir SQL
 * ile çapraz kontrol ediliyor.
 *
 * ═══ GÜVENLİK ═══
 *
 * Fixture YAZAR. Hedef adıyla harcanabilir olduğunu söylemek zorundadır
 * (`requireDisposableOwnerDatabaseUrl`); `mas_radar_dev` reddedilir. Temizlik transaction
 * ROLLBACK'idir — hiçbir satır kalıcı olmaz, hiçbir invariant delinmez.
 */
import { Client } from "pg";
import type { Pool } from "pg";
import { requireDisposableOwnerDatabaseUrl } from "./owner-url";

const MARK = "IX-CANCEL-";
/** Matris satırlarının ortak tutarı. Aynı vade + aynı tutar: tek değişken statü kalsın. */
const AMOUNT = 250_000;
/** Kısmi ödenen satırın ödenmiş kısmı → kalan 150.000. */
const PARTIAL_PAID = 100_000;
/** Tek başına bırakılan iptal kaydının tutarı: gözden kaçamayacak kadar büyük. */
const LONE_CANCELLED = 5_000_000;

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) { pass += 1; console.log(`  PASS  ${label}`); }
  else { fail += 1; console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ""}`); }
}
const tl = (n: number) => new Intl.NumberFormat("tr-TR").format(n);

interface Snapshot {
  today: number;
  tomorrow: number;
  week: number;
  openCount: number;
  overdueCount: number;
  riskyDays: number;
  chartTotal: number;
  priorityIds: string[];
  datesInChart: string[];
}

async function main() {
  const client = new Client({ connectionString: requireDisposableOwnerDatabaseUrl() });
  await client.connect();
  console.log(`Hedef veritabanı: ${(await client.query("select current_database() d")).rows[0].d}\n`);

  // Tek bağlantı ZORUNLU: fixture'lar açık bir transaction içinde ve yalnız buradan görünüyor.
  const pool = client as unknown as Pool;

  const { loadPaymentDashboard, dayFlagsForDate, paymentHistoryEvents } = await import("../../src/lib/radar/queries");
  const { paymentDashboardChart } = await import("../../src/lib/radar/payment-dashboard-chart");
  const { loadThresholds } = await import("../../src/lib/radar/engine");

  const today = (await client.query("select current_date::text d")).rows[0].d as string;
  const tomorrow = new Date(Date.parse(today) + 86_400_000).toISOString().slice(0, 10);
  const weekEnd = new Date(Date.parse(today) + 6 * 86_400_000).toISOString().slice(0, 10);
  const anchor = new Date(`${today}T00:00:00Z`);
  const futureEnd = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 24, anchor.getUTCDate()))
    .toISOString().slice(0, 10);
  const riskEnd = new Date(Date.parse(today) + 30 * 86_400_000).toISOString().slice(0, 10);

  await client.query("begin");
  // RLS altında yazmak ve okumak bir KATMAN rolü ister; bağlantı `mas_radar_app` ile açıldığında
  // bu tablolarda hiçbir politikası yoktur. `set local`: rol transaction ile geri alınır.
  await client.query("set local role mas_radar_admin");

  try {
    const thresholds = await loadThresholds(pool);
    console.log(`Eşikler: large=${tl(thresholds.large)} critical=${tl(thresholds.critical)} cluster=${thresholds.clusterCount}\n`);

    const snapshot = async (): Promise<Snapshot> => {
      const { buckets, priorities } = await loadPaymentDashboard(pool, today, futureEnd);
      const sum = (rows: typeof buckets) => rows.reduce((s, b) => s + b.knownAmount, 0);
      const count = (rows: typeof buckets) => rows.reduce((s, b) => s + b.count, 0);
      const riskDates = [...new Set(buckets.filter((b) => b.dueDate >= today && b.dueDate <= riskEnd).map((b) => b.dueDate))];
      const chart = paymentDashboardChart(buckets, today, thresholds.critical);
      return {
        today: sum(buckets.filter((b) => b.dueDate === today)),
        tomorrow: sum(buckets.filter((b) => b.dueDate === tomorrow)),
        week: sum(buckets.filter((b) => b.dueDate >= today && b.dueDate <= weekEnd)),
        openCount: count(buckets),
        overdueCount: count(buckets.filter((b) => b.status === "overdue")),
        riskyDays: riskDates.filter((d) => {
          const f = dayFlagsForDate(buckets, d, thresholds);
          return f.cluster || f.critical || f.large;
        }).length,
        chartTotal: chart.series.reduce((s, serie) => s + serie.points.reduce((n, p) => n + (p.value ?? 0), 0), 0),
        priorityIds: priorities.map((p) => p.id),
        datesInChart: [...new Set(buckets.map((b) => b.dueDate))],
      };
    };

    const insert = async (due: string, status: string, amount: number | null, note: string, paidAmount?: number) => {
      const cancelled = status === "cancelled";
      const paidAt = status === "paid" || paidAmount != null ? `${due}T09:00:00Z` : null;
      const r = await client.query<{ id: string }>(
        `insert into public.payment_instances
           (id, payment_id, instance_month, due_date, amount, currency, amount_status, direction,
            status, paid_amount, paid_at, risk_level, risk_reasons, note, amount_source,
            cancelled_at, cancel_reason)
         values (gen_random_uuid(), null, date_trunc('month',$1::date)::date, $1::date, $2, 'TRY',
                 $3, 'outflow', $4, $5, $6, 'none', '{}', $7, 'manual',
                 case when $8 then now() end, case when $8 then 'fixture' end)
         returning id`,
        [due, amount, amount == null ? "missing" : "known", status,
          status === "paid" ? amount : paidAmount ?? null, paidAt, `${MARK}${note}`, cancelled],
      );
      return r.rows[0].id;
    };

    // ── A. TABAN ÖLÇÜM ───────────────────────────────────────────────────────────────────
    const base = await snapshot();
    console.log("── A. Taban ölçüm (fixture yok) ──");
    console.log(`  bugün=${tl(base.today)}  yarın=${tl(base.tomorrow)}  7gün=${tl(base.week)}`);
    console.log(`  açık=${base.openCount}  gecikmiş=${base.overdueCount}  riskli gün=${base.riskyDays}  grafik=${tl(base.chartTotal)}\n`);

    // ── B. YALNIZ İPTAL — BUGÜN VADELİ, YÜKSEK TUTARLI ───────────────────────────────────
    //
    // Kuralın en keskin hâli: bugün vadeli 5.000.000 TL'lik bir iptal kaydı eklendiğinde
    // SEKİZ göstergenin hiçbiri kıpırdamamalı.
    const loneCancelId = await insert(today, "cancelled", LONE_CANCELLED, "lone-cancelled");
    const afterCancel = await snapshot();
    console.log(`── B. Bugün vadeli ${tl(LONE_CANCELLED)} TL'lik İPTAL kaydı eklendi ──`);
    const unchanged: Array<[string, number, number]> = [
      ["bugün toplamı", base.today, afterCancel.today],
      ["yarın toplamı", base.tomorrow, afterCancel.tomorrow],
      ["7 günlük toplam", base.week, afterCancel.week],
      ["açık kayıt sayısı", base.openCount, afterCancel.openCount],
      ["gecikmiş sayısı", base.overdueCount, afterCancel.overdueCount],
      ["riskli gün sayısı", base.riskyDays, afterCancel.riskyDays],
      ["grafik toplamı", base.chartTotal, afterCancel.chartTotal],
    ];
    for (const [name, before, after] of unchanged) {
      check(`${name} DEĞİŞMEDİ`, before === after, `önce=${tl(before)} sonra=${tl(after)}`);
    }
    check("iptal kaydı öncelikli ödemelerde YOK",
      !afterCancel.priorityIds.includes(loneCancelId),
      `priorities: ${afterCancel.priorityIds.join(", ") || "(boş)"}`);

    // ── C. AYNI VADE, AYNI TUTAR — ALTI STATÜNÜN TAMAMI ──────────────────────────────────
    //
    // Elle aritmetik (bugün toplamı = Σ kalan, yalnız açık kümedeki satırlar):
    //   unpaid    250.000  kalan 250.000  ✓ sayılır
    //   partial   250.000  kalan 150.000  ✓ sayılır  (100.000 ödenmiş)
    //   planned   250.000  kalan 250.000  ✓ sayılır
    //   late      250.000  kalan 250.000  ✓ sayılır
    //   paid      250.000                 ✗ izin listesinde yok
    //   cancelled 250.000                 ✗ BU TURUN KURALI
    //   ─────────────────────────────────────────────────
    //   beklenen artış                       900.000
    const ids: Record<string, string> = {};
    for (const [status, paid] of [["unpaid", undefined], ["partial", PARTIAL_PAID], ["paid", undefined],
      ["cancelled", undefined], ["planned", undefined], ["late", undefined]] as const) {
      ids[status] = await insert(today, status, AMOUNT, `matrix-${status}`, paid ?? undefined);
    }
    const EXPECTED_DELTA = 4 * AMOUNT - PARTIAL_PAID; // 900.000
    const afterMatrix = await snapshot();
    console.log(`\n── C. Aynı gün, aynı tutar (${tl(AMOUNT)} TL), altı statü ──`);
    check(`bugün toplamı tam ${tl(EXPECTED_DELTA)} TL arttı (paid ve cancelled hariç)`,
      afterMatrix.today - afterCancel.today === EXPECTED_DELTA,
      `ölçülen artış=${tl(afterMatrix.today - afterCancel.today)} beklenen=${tl(EXPECTED_DELTA)}`);
    check("7 günlük toplam da aynı tutar kadar arttı",
      afterMatrix.week - afterCancel.week === EXPECTED_DELTA,
      `ölçülen=${tl(afterMatrix.week - afterCancel.week)}`);
    check("yarın toplamı DEĞİŞMEDİ (hepsi bugün vadeli)",
      afterMatrix.tomorrow === afterCancel.tomorrow);
    check("açık kayıt sayısı 4 arttı (6 satırın 2'si dışarıda)",
      afterMatrix.openCount - afterCancel.openCount === 4,
      `ölçülen=${afterMatrix.openCount - afterCancel.openCount}`);
    check("gecikmiş sayısı DEĞİŞMEDİ (bugün vadeli, geçmiş değil)",
      afterMatrix.overdueCount === afterCancel.overdueCount);
    check("grafik toplamı da tam aynı tutar kadar arttı",
      afterMatrix.chartTotal - afterCancel.chartTotal === EXPECTED_DELTA,
      `ölçülen=${tl(afterMatrix.chartTotal - afterCancel.chartTotal)}`);
    check("iptal edilen matris satırı öncelikli ödemelerde YOK",
      !afterMatrix.priorityIds.includes(ids.cancelled));
    check("ödenmiş matris satırı da öncelikli ödemelerde YOK",
      !afterMatrix.priorityIds.includes(ids.paid));

    // Bağımsız SQL: ürün koduna hiç dokunmadan, kuralı elle yazarak aynı artışı hesapla.
    const independent = await client.query<{ v: string }>(
      `select coalesce(sum(greatest(amount - coalesce(paid_amount,0), 0)), 0)::text v
         from public.payment_instances
        where note like $1
          and due_date = current_date
          and status in ('unpaid','partial','planned','late','unknown')
          and status <> 'cancelled'
          and cancelled_at is null`,
      [`${MARK}matrix-%`],
    );
    check(`bağımsız SQL de ${tl(EXPECTED_DELTA)} TL diyor (ürün koduna dokunmadan)`,
      Number(independent.rows[0].v) === EXPECTED_DELTA,
      `bağımsız SQL=${tl(Number(independent.rows[0].v))}`);

    // ── D. TEMİZ BİR GÜNDE YALNIZ İPTAL — GÜN HİÇ VAR OLMAMALI ───────────────────────────
    const freeOffset = await (async () => {
      const busy = new Set((await client.query(
        `select (due_date - current_date)::int off from public.payment_instances
          where due_date between current_date + 200 and current_date + 400`)).rows.map((r) => Number(r.off)));
      for (let o = 200; o <= 400; o += 1) if (!busy.has(o)) return o;
      throw new Error("200–400 gün arasında boş gün bulunamadı.");
    })();
    const cleanDate = (await client.query("select (current_date + $1::int)::text d", [freeOffset])).rows[0].d as string;
    console.log(`\n── D. Boş bir gün (bugün + ${freeOffset}) — yalnız iptal kaydı ──`);
    await insert(cleanDate, "cancelled", LONE_CANCELLED, "clean-day-cancelled");
    const afterCleanCancel = await snapshot();
    check("o gün için HİÇ kova üretilmedi (gün grafikte yok)",
      !afterCleanCancel.datesInChart.includes(cleanDate));
    check("o gün riskli gün sayılmadı",
      afterCleanCancel.riskyDays === afterMatrix.riskyDays,
      `önce=${afterMatrix.riskyDays} sonra=${afterCleanCancel.riskyDays}`);
    check("grafik toplamı DEĞİŞMEDİ",
      afterCleanCancel.chartTotal === afterMatrix.chartTotal,
      `önce=${tl(afterMatrix.chartTotal)} sonra=${tl(afterCleanCancel.chartTotal)}`);

    // ── E. AYNI GÜNE AÇIK EŞDEĞER — TAM TUTAR KADAR ARTMALI ──────────────────────────────
    console.log(`\n── E. Aynı güne, aynı tutarda AÇIK (unpaid) eşdeğer ──`);
    await insert(cleanDate, "unpaid", LONE_CANCELLED, "clean-day-unpaid");
    const afterEquivalent = await snapshot();
    check(`grafik toplamı tam ${tl(LONE_CANCELLED)} TL arttı`,
      afterEquivalent.chartTotal - afterCleanCancel.chartTotal === LONE_CANCELLED,
      `ölçülen=${tl(afterEquivalent.chartTotal - afterCleanCancel.chartTotal)}`);
    check("gün artık grafikte var",
      afterEquivalent.datesInChart.includes(cleanDate));
    check("açık kayıt sayısı 1 arttı (iptal olan hâlâ sayılmıyor)",
      afterEquivalent.openCount - afterCleanCancel.openCount === 1,
      `ölçülen=${afterEquivalent.openCount - afterCleanCancel.openCount}`);

    // ── F. İPTAL KAYDI DENETİM İZİNDE GÖRÜNÜYOR MU ───────────────────────────────────────
    //
    // Dışlamak "yok saymak" değil. /payments/history iptalleri göstermeye devam etmeli;
    // aksi hâlde bu düzeltme, kaydı KPI'dan çıkarırken denetimden de silmiş olurdu.
    console.log("\n── F. İptal kaydı denetim izinde (payments/history) ──");
    const events = await paymentHistoryEvents(pool, { status: "cancelled", limit: 1000 });
    const seen = new Set(events.map((e) => e.instanceId));
    check("bugün vadeli iptal kaydı geçmiş ekranında GÖRÜNÜYOR", seen.has(loneCancelId));
    check("matris iptal satırı da geçmiş ekranında GÖRÜNÜYOR", seen.has(ids.cancelled));
    check("ödenmiş satır 'iptal edilen' sekmesine sızmıyor", !seen.has(ids.paid));
  } finally {
    await client.query("rollback").catch(() => {});
    await client.end();
  }

  // Kalıntı kontrolü AYRI bağlantıdan: rollback'in gerçekten iş gördüğünü kanıtlar.
  const auditor = new Client({ connectionString: requireDisposableOwnerDatabaseUrl() });
  await auditor.connect();
  await auditor.query("set role mas_radar_admin");
  const left = await auditor.query<{ c: number }>(
    "select count(*)::int c from public.payment_instances where note like $1", [`${MARK}%`]);
  await auditor.end();
  console.log(`\nRollback sonrası kalan fixture satırı: ${left.rows[0].c}`);
  check("fixture'lar kalıcı olmadı", left.rows[0].c === 0);

  console.log(`\n${pass} PASS · ${fail} FAIL`);
  if (fail > 0) process.exit(1);
}

main().catch((error) => { console.error(error); process.exit(1); });
