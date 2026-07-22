import { chromium } from "@playwright/test";

const base = process.env.BASE_URL ?? "http://127.0.0.1:3103";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(15_000);
page.setDefaultNavigationTimeout(30_000);
const results = [];

async function check(name, action) {
  if (process.env.AUDIT_FILTER && !name.toLocaleLowerCase("tr-TR").includes(process.env.AUDIT_FILTER.toLocaleLowerCase("tr-TR"))) return;
  console.error(`START ${name}`);
  const errors = [];
  const onPageError = (error) => errors.push(error.message);
  const onConsole = (message) => message.type() === "error" && errors.push(message.text());
  page.on("pageerror", onPageError);
  page.on("console", onConsole);
  try {
    await action();
    const body = await page.locator("body").innerText();
    if (/Application error|Internal Server Error|This page could not be found/i.test(body)) throw new Error("Sayfa hata ekranına düştü");
    if (errors.length) throw new Error(`İstemci hatası: ${[...new Set(errors)].join(" | ")}`);
    results.push({ name, status: "PASS", url: page.url() });
    console.error(`PASS ${name}`);
  } catch (error) {
    results.push({ name, status: "FAIL", url: page.url(), error: error instanceof Error ? error.message : String(error) });
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    page.off("pageerror", onPageError);
    page.off("console", onConsole);
  }
}

const open = (path) => page.goto(`${base}${path}`, { waitUntil: "networkidle", timeout: 60_000 });

await check("Sol menüyü daralt / genişlet", async () => {
  await open("/overview");
  const button = page.locator(".sidebar-collapse");
  const before = await button.getAttribute("aria-label");
  await button.click();
  if ((await button.getAttribute("aria-label")) === before) throw new Error("Menü durumu değişmedi");
  await button.click();
});

await check("Hızlı erişim komut menüsü", async () => {
  await open("/overview");
  await page.locator(".sidebar-command").first().click();
  await page.getByLabel("Komut ara").fill("Nakit Akışı");
  await page.getByRole("button", { name: /Nakit Akışı/i }).first().click();
  await page.waitForURL(/\/cashflow/);
});

await check("Ödendi / geri al", async () => {
  await open("/payments");
  const paid = page.getByRole("button", { name: "ödendi", exact: true }).first();
  await paid.click();
  await page.waitForLoadState("networkidle");
  await open("/payments?view=history");
  const undo = page.getByRole("button", { name: "geri al", exact: true }).first();
  await undo.click();
  await page.waitForLoadState("networkidle");
});

await check("Ödeme oluştur / düzenle / arşivle", async () => {
  const marker = `AUDIT ${Date.now()}`;
  await open("/payments/new");
  await page.locator('[name="name"]').fill(marker);
  await page.locator('[name="due_day"]').fill("15");
  await page.locator('[name="default_amount"]').fill("123");
  await page.getByRole("button", { name: "kaydet", exact: true }).click();
  await page.waitForURL(/\/payments\/items/);
  await page.getByRole("link", { name: marker }).click();
  await page.locator('[name="default_amount"]').fill("124");
  await page.getByRole("button", { name: "kaydet", exact: true }).click();
  await page.waitForURL(/\/payments\/items/);
  await page.getByRole("link", { name: marker }).click();
  await page.getByRole("button", { name: "arşivle", exact: true }).click();
  await page.waitForURL(/\/payments\/items/);
});

await check("Hazır senaryo çalıştır / sil", async () => {
  await open("/scenarios");
  await page.getByRole("button", { name: /Gelir %10 düşerse/ }).click();
  await page.waitForURL(/\/scenarios\//);
  await page.getByRole("button", { name: /sil/i }).click();
  await page.waitForURL(/\/scenarios$/);
});

await check("Finansal soru-cevap", async () => {
  await open("/insights/ask");
  await page.getByRole("button", { name: "Bugun ne odenecek?", exact: true }).click();
  await page.waitForURL(/response=/);
});

await check("Günlük rapor üret", async () => {
  await open("/insights/reports");
  await page.getByRole("button", { name: /Günlük üret/ }).click();
  await page.waitForURL(/\/reports\//);
});

await check("Hatırlatmaları planla", async () => {
  await open("/insights/reminders");
  await page.getByRole("button", { name: /bugünü planla/i }).click();
  await page.waitForLoadState("networkidle");
});

await check("Telegram gönderimini dürüst durumla kaydet", async () => {
  await open("/insights/reminders");
  await page.getByRole("button", { name: /bekleyenleri gönder/i }).click();
  await page.waitForLoadState("networkidle");
});

await check("Excel yükle / dört modüle aktar", async () => {
  await open("/data/imports");
  await page.locator('input[type="file"]').setInputFiles("data/source/mesaili_nakit_akış_tek_vardiya_TEMİZ.xlsx");
  await page.getByRole("button", { name: "İÇE AKTAR", exact: true }).click();
  await page.waitForURL(/\/imports\//, { timeout: 60_000 });
  const detailUrl = page.url();
  for (const label of [/radar.*aktar/i, /nakit akışı.*aktar/i, /çek.*kredi.*aktar/i, /üretim analitiğini aktar/i]) {
    const button = page.getByRole("button", { name: label });
    if (await button.count()) {
      await button.click();
      await page.waitForLoadState("networkidle");
      await page.goto(detailUrl, { waitUntil: "networkidle" });
    }
  }
});

await check("Manuel görev oluştur / başlat / tamamla", async () => {
  const marker = `AUDIT TASK ${Date.now()}`;
  await open("/data/quality");
  await page.locator('[name="title"]').last().fill(marker);
  await page.getByRole("button", { name: "olustur", exact: true }).click();
  await page.waitForLoadState("networkidle");
  const task = page.getByText(marker, { exact: true }).locator("xpath=ancestor::div[contains(@class,'border')][1]");
  await task.getByRole("button", { name: "basla", exact: true }).click();
  await page.waitForLoadState("networkidle");
  const updated = page.getByText(marker, { exact: true }).locator("xpath=ancestor::div[contains(@class,'border')][1]");
  await updated.locator('[name="completionNote"]').fill("audit tamamlandı");
  await updated.getByRole("button", { name: "bitti", exact: true }).click();
  await page.waitForLoadState("networkidle");
});

await check("Dış varsayım kaydet / onayla", async () => {
  const marker = `AUDIT ASSUMPTION ${Date.now()}`;
  await open("/data/assumptions");
  await page.locator('[name="label"]').fill(marker);
  await page.locator('[name="valueNumeric"]').fill("42");
  await page.locator('[name="unit"]').fill("percent");
  await page.locator('[name="sourceName"]').fill("Yerel audit");
  await page.locator('[name="sourceDate"]').fill("2026-07-13");
  await page.getByRole("button", { name: "kaydet", exact: true }).click();
  await page.waitForLoadState("networkidle");
  const row = page.locator("tr", { hasText: marker });
  await row.getByRole("button", { name: "onay", exact: true }).click();
  await page.waitForLoadState("networkidle");
});

console.log(JSON.stringify(results, null, 2));
await browser.close();
if (results.some((result) => result.status === "FAIL")) process.exitCode = 1;
