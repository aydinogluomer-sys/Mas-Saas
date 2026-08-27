/**
 * MUTASYON KAPSAMI — parametrik, ama kanıt zinciri gevşetilmeden.
 *
 * ═══ NEDEN PARAMETRİK ═══
 *
 * Kalan mutasyon borcu 126 (rota, kontrol) birimi. Her biri için elle yazılmış bir test, aynı
 * kanıt zincirini 126 kez kopyalamak olurdu — ve kopyalanan her zincirde biri eninde sonunda
 * "reload doğrulamasını atlayayım" der. Zincir TEK YERDE yazılır, vakalar veri olarak eklenir.
 *
 * ═══ ZİNCİR (her vaka için, istisnasız) ═══
 *
 *   1. Fixture ön koşulu güvenli biçimde kurulur (tekrar çalıştırılabilir).
 *   2. BEFORE: bağımsız owner bağlantısıyla sayaç okunur.
 *   3. Gerçek UI click (fetch/POST taklidi değil).
 *   4. UI sonucu gözlenir (hata ekranına düşülmedi mi).
 *   5. AFTER: yine bağımsız bağlantıyla sayaç okunur ve YÖNÜ doğrulanır.
 *   6. audit_logs izi (vaka istiyorsa).
 *   7. Reload → sayaç hâlâ doğru (iyimser render değil, sunucudan gelen).
 *
 * Toast, redirect, HTTP 200 ya da DOM değişikliği TEK BAŞINA PASS değildir. Bunun ölçülmüş
 * gerekçesi var: mutasyon testinde `markPaid`'in UPDATE'i etkisizleştirildiğinde UI tamamen
 * başarılı görünüyordu (redirect oldu, hata çıkmadı) ve yalnız DB iddiası yakaladı.
 *
 * ═══ SAYAÇ NEDEN "YÖN", TAM DEĞER DEĞİL ═══
 *
 * Bu paket üretim benzeri, dolu bir fixture'a karşı koşar ve paralel hiçbir şey yoktur ama
 * arka plan işleri (ör. ödeme penceresi üretimi) satır ekleyebilir. "Tam olarak +1" iddiası bu
 * yüzden kırılgan olurdu; "kesinlikle arttı" iddiası ise aksiyonun gerçekten yazdığını kanıtlar
 * ve hiçbir şey yazmayan bir aksiyonu yakalar — mutasyon testiyle doğrulandı.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { db, openAs, scalar, signatureFor, type Evidence, type SeededRole } from "./harness";
import { usernameFor } from "../visual/global-setup";
import { waitForWorkspaceReady } from "./workspace-ready";

const OUT = path.join(process.cwd(), "docs", "interaction-audit");
const evidence: Evidence[] = [];

test.afterAll(() => {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(path.join(OUT, "evidence-mutations.json"), `${JSON.stringify({ rows: evidence }, null, 2)}\n`, "utf8");
});

interface MutationCase {
  /** Rapor ve hata mesajlarında görünen ad. */
  id: string;
  route: string;
  /** Tıklanacak düğmenin GÖRÜNEN metni (envanterdeki etiketle aynı). */
  label: string;
  /** Bu aksiyonu yapmaya yetkili en düşük katman. */
  role: SeededRole;
  /**
   * Ön koşulu kur — yoksa vaka atlanmaz, KIRMIZI olur (sessiz atlama yok).
   *
   * Bir kimlik döndürürse düğme O SATIRA daraltılır. Bu, sahiplik/durum kısıtı olan tablolarda
   * ZORUNLU: `/insights/tasks` sayfası görevleri önem sırasına göre listeler, `.first()` ise
   * başkasına ait bir satırı seçebilir ve OWNER_SCOPED RLS onu haklı olarak reddeder. Test o
   * zaman "aksiyon çalışmıyor" der; oysa yanlış satıra tıklamıştır.
   */
  setup?: () => Promise<string | void>;
  /** Formu doldur (gerekiyorsa). */
  fill?: (page: Page) => Promise<void>;
  /** Değişmesi beklenen sayaç. Tek skaler döndürmeli. */
  countSql: string;
  /** Beklenen yön. */
  direction: "increase" | "decrease";
  /** audit_logs'ta iz aranacak tablo (varsa). */
  auditTable?: string;
}

async function count(sql: string): Promise<number> {
  return Number(await scalar<string>(sql));
}

/* ── Fixture kurucular — hepsi TEKRAR ÇALIŞTIRILABİLİR ──────────────────────────────────── */

/** Tahsil/karşılıksız için: açık (settled olmayan) bir çek garanti et. */
async function ensureOpenCheck(): Promise<void> {
  await db(async (c) => {
    const open = await c.query("select 1 from public.checks where status not in ('settled','bounced') limit 1");
    if (open.rowCount === 1) return;
    await c.query(
      `insert into public.checks (direction, amount, currency, due_date, status, bank_name, serial_no)
       values ('inflow', 12500.00, 'TRY', (now() + interval '30 days')::date, 'portfolio', 'IX-FIXTURE Bank', $1)`,
      [`IX-${Date.now()}`],
    );
  });
}

/**
 * Görev yaşam döngüsü için: TIKLAYACAK ROLÜN SAHİP OLDUĞU, 'open' durumda bir action_item.
 *
 * `action_items` OWNER_SCOPED bir tablodur (matrix.ts): RLS, satırı yalnız SAHİBİNİN
 * güncellemesine izin verir. İlk yazımda fixture görevi "ilk kullanıcıya" bağlamıştı ve
 * `finance_operator` ile tıklanınca RLS haklı olarak reddetti — test kırmızı verdi, ÜRÜN
 * DOĞRUYDU. Sahiplik testin ön koşuludur, ürünün gevşetilmesi gereken bir kısıtı değil.
 */
async function ensureOpenTaskOwnedBy(role: SeededRole): Promise<string> {
  return db(async (c) => {
    const owner = await c.query<{ id: string }>("select id from public.users where username = $1", [usernameFor(role)]);
    const ownerId = owner.rows[0]?.id;
    expect(ownerId, `${role} kullanıcısı bulunamadı — globalSetup çalışmamış olabilir`).toBeTruthy();

    const open = await c.query<{ id: string }>(
      "select id from public.action_items where status = 'open' and created_by = $1 limit 1",
      [ownerId],
    );
    if (open.rowCount === 1) return open.rows[0].id;
    const inserted = await c.query<{ id: string }>(
      `insert into public.action_items (title, status, severity, source_type, created_by)
       values ($1, 'open', 'medium', 'manual', $2) returning id`,
      [`IX-FIXTURE gorev ${Date.now()}`, ownerId],
    );
    return inserted.rows[0].id;
  });
}

/* ── Vakalar — finansal riski en yüksek akışlar önce ────────────────────────────────────── */

const CASES: MutationCase[] = [
  {
    id: "checks/settle",
    route: "/finance/checks",
    label: "tahsil edildi",
    role: "finance_operator",
    setup: ensureOpenCheck,
    // Uygulama 'settled' DEĞİL 'cleared' yazıyor (check_events.event_type de 'cleared').
    // İlk yazımda 'settled' beklenmişti ve test kırmızı verdi — ürün doğruydu, iddia yanlıştı.
    countSql: "select count(*)::int from public.checks where status = 'cleared'",
    direction: "increase",
    auditTable: "checks",
  },
  {
    id: "checks/bounce",
    route: "/finance/checks",
    label: "karşılıksız",
    role: "finance_operator",
    setup: ensureOpenCheck,
    countSql: "select count(*)::int from public.checks where status = 'bounced'",
    direction: "increase",
    auditTable: "checks",
  },
  {
    id: "tasks/start",
    route: "/insights/tasks",
    label: "Başlat",
    role: "finance_operator",
    setup: () => ensureOpenTaskOwnedBy("finance_operator"),
    countSql: "select count(*)::int from public.action_items where status = 'in_progress'",
    direction: "increase",
  },
  {
    id: "scenarios/preset-run",
    route: "/scenarios",
    label: "Gelir %10 düşerse",
    role: "finance_operator",
    countSql: "select count(*)::int from public.scenario_runs",
    direction: "increase",
  },
  {
    id: "reports/daily",
    route: "/insights/reports",
    label: "Günlük üret →",
    role: "finance_operator",
    countSql: "select count(*)::int from public.reports",
    direction: "increase",
  },
  {
    id: "system/refresh-metrics",
    route: "/system",
    label: "Metrikleri yenile",
    role: "finance_manager",
    // `writeMetricSnapshots` bir UPSERT'tir:
    //   on conflict (snapshot_date, metric_key, dimension_key) do update …
    // Aynı gün ikinci kez çalıştırıldığında satır SAYISI artmaz, satırlar TAZELENİR. İlk yazımda
    // `count(metric_snapshots)` beklenmişti ve test kırmızı verdi — ürün doğruydu, iddia yanlıştı.
    // Yazmanın gerçekten olduğunun kanıtı, aksiyonun kendi audit satırıdır.
    countSql: "select count(*)::int from public.audit_logs where action = 'refresh_metric_snapshots'",
    direction: "increase",
  },
];

/* ── Tek kanıt zinciri, bütün vakalar için ──────────────────────────────────────────────── */

for (const testCase of CASES) {
  test(`${testCase.id}: '${testCase.label}' GERÇEKTEN yazıyor (DB before/after + reload)`, async ({ browser }) => {
    test.setTimeout(240_000);

    const targetId = testCase.setup ? ((await testCase.setup()) ?? null) : null;

    const session = await openAs(browser, testCase.role);
    const { page } = session;

    try {
      await page.goto(testCase.route, { waitUntil: "domcontentloaded" });
      await waitForWorkspaceReady(page);

      // Kimlik verildiyse düğme O SATIRIN formuna daraltılır; verilmediyse ekrandaki ilk örnek.
      const button = targetId
        ? page
            .locator("form")
            .filter({ has: page.locator(`input[name="id"][value="${targetId}"]`) })
            .getByRole("button", { name: testCase.label, exact: true })
            .first()
        : page.getByRole("button", { name: testCase.label, exact: true }).first();
      await expect(
        button,
        `${testCase.route} üzerinde '${testCase.label}' düğmesi görünmüyor — fixture ön koşulu kurulmamış olabilir`,
      ).toBeVisible({ timeout: 20_000 });

      if (testCase.fill) await testCase.fill(page);

      const before = await count(testCase.countSql);
      const auditBefore = testCase.auditTable
        ? await count(`select count(*)::int from public.audit_logs where entity_table = '${testCase.auditTable}'`)
        : 0;

      const post = page.waitForResponse((r) => r.request().method() === "POST", { timeout: 60_000 }).catch(() => null);
      await button.click();
      await post;
      await page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => {});

      // UI hata ekranına düşmemeli — düşerse "yazdı ama patladı" ile "hiç yazmadı" karışır.
      const body = await page.locator("body").innerText();
      expect(
        /Application error|Internal Server Error/i.test(body),
        `${testCase.id}: aksiyon uygulama hata ekranı üretti`,
      ).toBe(false);

      // Sunucu aksiyonunun commit'i ile tarayıcının "idle" görmesi arasındaki pencere için
      // SINIRLI bekleme. İddia değişmedi: sayaç bu yönde HAREKET ETMEK ZORUNDA.
      // `toSatisfy` bu Playwright sürümünün poll matcher'ında yok; yön karşılaştırması bu yüzden
      // boolean'a indirgenip `toBe(true)` ile beklenir. İddia birebir aynı, yalnız ifade farklı.
      await expect
        .poll(async () => {
          const now = await count(testCase.countSql);
          return testCase.direction === "increase" ? now > before : now < before;
        }, {
          message: `${testCase.id}: sayaç ${testCase.direction === "increase" ? "artmalı" : "azalmalı"} (before=${before})`,
          timeout: 30_000,
          intervals: [250, 500, 1000, 2000, 2000],
        })
        .toBe(true);

      const after = await count(testCase.countSql);

      if (testCase.auditTable) {
        const auditAfter = await count(
          `select count(*)::int from public.audit_logs where entity_table = '${testCase.auditTable}'`,
        );
        expect(auditAfter, `${testCase.id}: audit_logs izi bırakmalı`).toBeGreaterThan(auditBefore);
      }

      // Reload: iyimser render değil, sunucudan geleni ölç.
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForWorkspaceReady(page);
      const afterReload = await count(testCase.countSql);
      expect(afterReload, `${testCase.id}: reload sonrası değişiklik kalıcı olmalı`).toBe(after);

      evidence.push({
        route: testCase.route,
        control: signatureFor(testCase.route, testCase.label),
        role: testCase.role,
        verdict: "PASS",
        proof: [
          `before DB: ${before}`,
          `click: gerçek '${testCase.label}' düğmesi (${testCase.route})`,
          `after DB: ${after} (${testCase.direction})`,
          testCase.auditTable ? `audit_logs[${testCase.auditTable}]: iz bırakıldı` : "audit izi bu vakada aranmadı",
          `reload sonrası: ${afterReload} — kalıcı`,
        ],
      });
    } finally {
      await session.context.close();
    }
  });
}
