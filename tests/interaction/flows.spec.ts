/**
 * MUTASYON AKIŞLARI — "bu düğme vaat ettiği işi GERÇEKTEN yaptı mı?"
 *
 * ═══ HER TESTİN ZORUNLU İSKELETİ ═══
 *
 *   1. BEFORE  durumu VERİTABANINDAN, uygulamanın havuzundan BAĞIMSIZ bir bağlantıyla oku
 *   2. CLICK   tarayıcıda gerçek düğmeye tıkla (fetch/POST taklidi değil)
 *   3. UI      kullanıcının gördüğü sonucu doğrula
 *   4. AFTER   durumu YİNE doğrudan veritabanından oku
 *   5. DELTA   beklenen kolon/satır değişimini doğrula
 *   6. AUDIT   gerekiyorsa audit_logs / event / delivery satırını doğrula
 *   7. RELOAD  sayfayı yeniden yükle
 *   8. KALICI  durumun hâlâ doğru olduğunu doğrula
 *
 * 3. adım TEK BAŞINA geçer not değildir ve bu dosyanın varlık sebebi odur: bir server action
 * `redirect()` ile geri dönerse sayfa yenilenir, toast çıkar, satır "ödendi" görünür — ve
 * altında hiçbir şey yazılmamış olabilir. 4-8 arası adımlar bunu imkânsız kılar.
 *
 * ═══ HANGİ SATIRA DOKUNULACAĞI NASIL SEÇİLİYOR ═══
 *
 * Test, DB'den bir kimlik seçip onu ekranda ARAMAZ — tersini yapar: ekranda GÖRÜNEN ilk uygun
 * kontrolü bulur, onun formundaki gizli `id` alanını okur ve doğrulamayı O kimlik üzerinden
 * yapar. Sebebi şu: DB'den seçilen bir satır o ekranda hiç render edilmiyor olabilir (filtre,
 * ay penceresi, rol) ve test "düğme yok" diye kırılır — ürün sağlamken. Ekrandan başlamak,
 * ölçülen şeyin GERÇEKTEN kullanıcının tıklayabildiği şey olmasını garanti eder.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { assertClean, clickAndSettle, hardReload, openAs, rows, scalar, signatureFor, signatureFromDom, type Evidence, type SeededRole } from "./harness";

const OUT = path.join(process.cwd(), "docs", "interaction-audit");

/** Ödenebilir örneklerin GERÇEKTEN render edildiği ekran (taramayla doğrulandı). */
const PAID_ROUTE = "/payments/missing";
const evidence: Evidence[] = [];

function note(route: string, control: string, role: SeededRole | "n/a", proof: string[]): void {
  evidence.push({ route, control, role, verdict: "PASS", proof });
}

test.afterAll(() => {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(path.join(OUT, "evidence-flows.json"), JSON.stringify({ rows: evidence }, null, 2) + "\n", "utf8");
});

/** Bir formun gizli `id` alanını oku — doğrulama bu kimlik üzerinden yapılır. */
async function formEntityId(page: Page, buttonLabel: string): Promise<string> {
  const id = await page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: buttonLabel, exact: true }) })
    .first()
    .locator('input[name="id"]')
    .first()
    .inputValue();
  expect(id, `${buttonLabel}: formda gizli id alanı yok — doğrulama kimliği okunamadı`).toMatch(/^[0-9a-f-]{36}$/i);
  return id;
}

async function instanceRow(id: string) {
  const r = await rows<{ status: string; paid_at: string | null; amount: string | null; paid_amount: string | null }>(
    "select status, paid_at::text, amount::text, paid_amount::text from public.payment_instances where id = $1",
    [id],
  );
  expect(r.length, `payment_instances ${id} bulunamadı`).toBe(1);
  return r[0];
}

async function auditCount(table: string, entityId: string): Promise<number> {
  return Number(
    await scalar<string>("select count(*)::int from public.audit_logs where entity_table = $1 and entity_id = $2", [table, entityId]),
  );
}

/* ════════════════════════════════════════════════════════════════════════════════════════
 * ÖDEMELER
 * ════════════════════════════════════════════════════════════════════════════════════════ */

test.describe("ödemeler", () => {
  test("ödendi → geri al: DB, audit ve reload kalıcılığı", async ({ browser }) => {
    test.setTimeout(180_000);
    const s = await openAs(browser, "finance_operator");
    const { page } = s;

    // ROTA ENVANTERDEN GELİR, TAHMİNDEN DEĞİL.
    //
    // İlk yazımda bu test `/payments`e gidiyordu ve "ödendi düğmesi yok" diye kırıldı. Ürün
    // sağlamdı: `/payments` bugün/yarın/hafta pencerelerini gösterir ve bu fixture'da o
    // pencereler boş; ödenebilir örnekler `/payments/missing` ekranında render ediliyor.
    // Taramanın gördüğü yer neresiyse test de oraya gider — aksi hâlde "düğme çalışmıyor" ile
    // "düğme burada değil" birbirine karışır.
    await page.goto(PAID_ROUTE, { waitUntil: "networkidle" });

    const paidButton = page.getByRole("button", { name: "ödendi", exact: true }).first();
    await expect(paidButton, `${PAID_ROUTE} üzerinde 'ödendi' düğmesi görünmüyor`).toBeVisible();

    const id = await formEntityId(page, "ödendi");
    const before = await instanceRow(id);
    const auditBefore = await auditCount("payment_instances", id);
    expect(before.status, "ön koşul: seçilen örnek ödenmemiş olmalı").not.toBe("paid");
    expect(before.paid_at, "ön koşul: paid_at null olmalı").toBeNull();

    await clickAndSettle(page, () => paidButton.click());

    const after = await instanceRow(id);
    expect(after.status, "DB: status paid olmalı").toBe("paid");
    expect(after.paid_at, "DB: paid_at dolmalı").not.toBeNull();

    const auditAfter = await auditCount("payment_instances", id);
    expect(auditAfter, "audit_logs: mutasyon iz bırakmalı").toBeGreaterThan(auditBefore);

    // Reload: iyimser render değil, sunucudan geleni ölç.
    await hardReload(page);
    const afterReload = await instanceRow(id);
    expect(afterReload.status, "reload sonrası hâlâ paid").toBe("paid");

    note(PAID_ROUTE, signatureFor(PAID_ROUTE, "ödendi"), "finance_operator", [
      `before: status=${before.status} paid_at=null`,
      `click: gerçek 'ödendi' düğmesi (instance ${id})`,
      `after DB: status=paid paid_at=${after.paid_at}`,
      `audit_logs: ${auditBefore} → ${auditAfter}`,
      "reload sonrası kalıcı",
    ]);

    /* ── Tersine akış: GERİ AL ────────────────────────────────────────────────────────── */
    //
    // GERİ ALMA HANGİ EKRANDA? Ölçüldü, tahmin edilmedi. Ödenmiş bir örneği `InstanceRowView`
    // ile (yani "geri al" düğmesiyle) render eden tek yol, TAKVİMİN GÜN GÖRÜNÜMÜDÜR:
    //
    //   /payments/calendar                  satır=0  'geri al'=0   ← ay ızgarası, satır listelemez
    //   /payments/calendar?date=2026-08-05  satır=2  'geri al'=1   ← gün seçili
    //   /payments?view=history              satır=0  'geri al'=0   ← bu ekran artık pano
    //   /payments/history                   satır=0  'geri al'=0   ← salt-okur olay günlüğü
    //
    // Bir ara bu "geri alma UI'da yok" sanıldı; yanlıştı — gün seçilmeden takvim satır
    // listelemiyor, o kadar. Test bu yüzden örneğin KENDİ vade tarihine gider.
    const dueDate = await scalar<string>(
      "select to_char(due_date,'YYYY-MM-DD') from public.payment_instances where id = $1",
      [id],
    );
    await page.goto(`/payments/calendar?date=${dueDate}`, { waitUntil: "networkidle" });
    const undo = page
      .locator("form")
      .filter({ has: page.locator(`input[name="id"][value="${id}"]`) })
      .getByRole("button", { name: "geri al", exact: true })
      .first();
    await expect(undo, "ödenen örnek için 'geri al' düğmesi görünmüyor").toBeVisible();

    // İmza TIKLAMADAN ÖNCE alınır: geri alma sonrası satır ödenmemiş olur ve "geri al" düğmesi
    // DOM'dan kaybolur, imza da onunla birlikte.
    const undoSignature = await signatureFromDom(page, "geri al");

    await clickAndSettle(page, () => undo.click());

    const undone = await instanceRow(id);
    expect(undone.status, "DB: geri alma sonrası paid OLMAMALI").not.toBe("paid");
    expect(undone.paid_at, "DB: paid_at null'a dönmeli").toBeNull();
    const auditUndo = await auditCount("payment_instances", id);
    expect(auditUndo, "audit_logs: geri alma da iz bırakmalı").toBeGreaterThan(auditAfter);

    await hardReload(page);
    expect((await instanceRow(id)).status, "reload sonrası hâlâ ödenmemiş").not.toBe("paid");

    // "geri al" duruma bağlı bir kontroldür: yalnız ÖDENMİŞ bir örnekte render edilir, o yüzden
    // tarama onu fixture'ın başlangıç durumunda göremedi. İmza canlı DOM'dan, taramanın
    // kullandığı formülle çıkarılır (bkz. signatureFromDom gerekçesi).
    note("/payments/calendar", undoSignature, "finance_operator", [
      `before: status=paid`,
      `click: gerçek 'geri al' düğmesi (/payments/calendar?date=${dueDate}, instance ${id})`,
      `after DB: status=${undone.status} paid_at=null`,
      `audit_logs: ${auditAfter} → ${auditUndo}`,
      "reload sonrası kalıcı",
    ]);

    assertClean(s, "ödendi/geri al akışı");
    await s.context.close();
  });

  test("eksik tutarı kaydet: null → değer (sıfır DEĞİL)", async ({ browser }) => {
    test.setTimeout(180_000);
    const s = await openAs(browser, "finance_operator");
    const { page } = s;
    await page.goto("/payments/missing", { waitUntil: "networkidle" });

    const save = page.getByRole("button", { name: "kaydet", exact: true }).first();
    if (!(await save.isVisible().catch(() => false))) {
      // Eksik tutarlı örnek yoksa test SESSİZCE geçmez: kanıt "ölçülemedi" olarak yazılır.
      evidence.push({
        route: "/payments/missing",
        control: signatureFor("/payments/missing", "kaydet"),
        role: "finance_operator",
        verdict: "FAIL",
        proof: [],
        error: "fixture'da tutarı eksik örnek yok — kontrol doğrulanamadı (sessizce geçilmedi)",
      });
      await s.context.close();
      return;
    }

    const id = await formEntityId(page, "kaydet");
    const before = await instanceRow(id);
    expect(before.amount, "ön koşul: tutar null olmalı").toBeNull();

    const form = page.locator("form").filter({ has: page.locator(`input[name="id"][value="${id}"]`) }).first();
    await form.locator('input[name="amount"]').fill("12345");
    await clickAndSettle(page, () => form.getByRole("button", { name: "kaydet", exact: true }).click());

    const after = await instanceRow(id);
    expect(after.amount, "DB: tutar yazılmalı").not.toBeNull();
    expect(Number(after.amount), "DB: yazılan tutar girilen değer olmalı").toBe(12345);

    await hardReload(page);
    expect(Number((await instanceRow(id)).amount), "reload sonrası kalıcı").toBe(12345);

    note("/payments/missing", signatureFor("/payments/missing", "kaydet"), "finance_operator", [
      "before DB: amount=NULL (bilinmeyen, sıfır değil)",
      `click: 'kaydet' (instance ${id}, girilen 12345)`,
      `after DB: amount=${after.amount}`,
      "reload sonrası kalıcı",
    ]);
    assertClean(s, "eksik tutar kaydet");
    await s.context.close();
  });

  test("ödeme oluştur: pozitif kayıt + negatif doğrulama (yarım yazım YOK)", async ({ browser }) => {
    test.setTimeout(180_000);
    const s = await openAs(browser, "finance_operator");
    const { page } = s;

    /* ── NEGATİF: zorunlu alan boş ──────────────────────────────────────────────────── */
    const countBefore = Number(await scalar<string>("select count(*)::int from public.payments"));
    await page.goto("/payments/new", { waitUntil: "networkidle" });
    // Ad boş bırakılır; tekrar tipi aylık, gün verilmez → iki kural birden ihlal.
    await clickAndSettle(page, () => page.getByRole("button", { name: "kaydet", exact: true }).click());

    const countAfterInvalid = Number(await scalar<string>("select count(*)::int from public.payments"));
    expect(countAfterInvalid, "NEGATİF: geçersiz form DB'ye satır YAZMAMALI").toBe(countBefore);

    const bodyText = await page.locator("body").innerText();
    expect(/Application error|Internal Server Error/i.test(bodyText), "NEGATİF: 500 üretmemeli").toBe(false);
    // Hata kullanıcıya SÖYLENMELİ — sessiz reddediş kabul edilmez.
    const landed = new URL(page.url());
    const toldTheUser = landed.searchParams.has("error") || /zorunlu|geçersiz|hata/i.test(bodyText);
    expect(toldTheUser, "NEGATİF: kullanıcıya neyin yanlış olduğu söylenmeli").toBe(true);

    /* ── POZİTİF: geçerli değerler ──────────────────────────────────────────────────── */
    const uniqueName = `ETKILESIM-KAPISI-${Date.now()}`;
    await page.goto("/payments/new", { waitUntil: "networkidle" });
    await page.locator('input[name="name"]').fill(uniqueName);
    await page.locator('select[name="recurrence_type"]').selectOption("monthly");
    await page.locator('input[name="due_day"]').fill("15");
    await page.locator('input[name="default_amount"]').fill("7500");
    await clickAndSettle(page, () => page.getByRole("button", { name: "kaydet", exact: true }).click());

    const created = await rows<{ id: string; name: string; due_day: number; default_amount: string | null; status: string }>(
      "select id, name, due_day, default_amount::text, status from public.payments where name = $1",
      [uniqueName],
    );
    expect(created.length, "POZİTİF: DB'de tam olarak bir satır oluşmalı").toBe(1);
    expect(created[0].due_day, "POZİTİF: seçilen gün yazılmalı").toBe(15);
    expect(Number(created[0].default_amount), "POZİTİF: tutar yazılmalı").toBe(7500);

    // Ödeme örnekleri de üretilmiş olmalı — "oluştur" düğmesinin vaadi yalnız satır değil, takvimdir.
    const instances = Number(
      await scalar<string>("select count(*)::int from public.payment_instances where payment_id = $1", [created[0].id]),
    );
    expect(instances, "POZİTİF: ödeme örnekleri üretilmeli").toBeGreaterThan(0);

    note("/payments/new", signatureFor("/payments/new", "kaydet"), "finance_operator", [
      `NEGATİF: boş form → payments sayısı ${countBefore} (değişmedi), kullanıcıya hata gösterildi, 500 yok`,
      `POZİTİF: '${uniqueName}' → payments 1 satır, due_day=15, default_amount=7500`,
      `POZİTİF: payment_instances ${instances} örnek üretildi`,
    ]);
    assertClean(s, "ödeme oluştur");
    await s.context.close();
  });
});

/* ════════════════════════════════════════════════════════════════════════════════════════
 * OTURUM — çıkış GERÇEKTEN iptal ediyor mu
 * ════════════════════════════════════════════════════════════════════════════════════════ */

test.describe("kabuk", () => {
  test("çıkış yap: oturum DB'de iptal edilir ve korunan rota artık açılmaz", async ({ browser }) => {
    test.setTimeout(120_000);
    const s = await openAs(browser, "viewer");
    const { page } = s;

    await page.goto("/overview", { waitUntil: "networkidle" });

    const liveBefore = Number(
      await scalar<string>(
        `select count(*)::int from public.sessions s join public.users u on u.id = s.user_id
          where u.username = 'visual_viewer' and s.revoked_at is null and s.expires_at > now()`,
      ),
    );
    expect(liveBefore, "ön koşul: canlı bir viewer oturumu olmalı").toBeGreaterThan(0);

    await clickAndSettle(page, () => page.getByRole("button", { name: /Çıkış yap/ }).first().click());

    const liveAfter = Number(
      await scalar<string>(
        `select count(*)::int from public.sessions s join public.users u on u.id = s.user_id
          where u.username = 'visual_viewer' and s.revoked_at is null and s.expires_at > now()`,
      ),
    );
    expect(liveAfter, "DB: çıkış sonrası canlı oturum sayısı azalmalı").toBeLessThan(liveBefore);

    // UI gizlemek yeterli değil: korunan rota GERÇEKTEN reddedilmeli.
    await page.goto("/overview", { waitUntil: "domcontentloaded" });
    expect(new URL(page.url()).pathname, "çıkış sonrası korunan rota /login'e dönmeli").toBe("/login");

    note("/overview", signatureFor("/overview", "↪Çıkış yap"), "viewer", [
      `before: canlı viewer oturumu ${liveBefore}`,
      "click: gerçek 'Çıkış yap' düğmesi",
      `after DB: canlı oturum ${liveAfter} (iptal edildi)`,
      "korunan rota /overview → /login (UI gizleme değil, backend reddi)",
    ]);
    await s.context.close();
  });
});
