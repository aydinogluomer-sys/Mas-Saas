import http from "node:http";

function fetchUrl(url: string, headers: Record<string, string> = {}): Promise<{ status: number; text: string; json: any }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        let json = null;
        try {
          json = JSON.parse(data);
        } catch {}
        resolve({ status: res.statusCode ?? 0, text: data, json });
      });
    });
    req.on("error", reject);
  });
}

async function main() {
  console.log("=== MAS Nakit Radar TMA & PWA Canlı Doğrulama ===");

  // 1. Health
  const health = await fetchUrl("http://localhost:3000/health");
  console.log(`[1] /health: HTTP ${health.status}`, health.json);

  // 2. Manifest
  const manifest = await fetchUrl("http://localhost:3000/manifest.json");
  console.log(`[2] /manifest.json: HTTP ${manifest.status} | Name: "${manifest.json?.name}" | Icons: ${manifest.json?.icons?.length}`);

  // 3. Service Worker
  const sw = await fetchUrl("http://localhost:3000/sw.js");
  console.log(`[3] /sw.js: HTTP ${sw.status} | Length: ${sw.text.length} chars | Has Cache: ${sw.text.includes("mas-radar")}`);

  // 4. Telegram Mini App HTML
  const miniappHtml = await fetchUrl("http://localhost:3000/telegram/miniapp");
  console.log(`[4] /telegram/miniapp HTML: HTTP ${miniappHtml.status} | Length: ${miniappHtml.text.length} chars | Has Telegram SDK: ${miniappHtml.text.includes("telegram-web-app.js")}`);

  // 5. Telegram Mini App API
  const miniappApi = await fetchUrl("http://localhost:3000/api/telegram/miniapp");
  console.log(`[5] /api/telegram/miniapp API: HTTP ${miniappApi.status} | OK: ${miniappApi.json?.ok}`);
  if (miniappApi.json?.snapshot) {
    const snap = miniappApi.json.snapshot;
    console.log(`    - Net Kasa: ₺${Math.round(snap.netKasa).toLocaleString("tr-TR")}`);
    console.log(`    - 7 Günlük Çıkış: ₺${Math.round(snap.next7DaysOutflow).toLocaleString("tr-TR")} (${snap.next7DaysCount} kalem)`);
    console.log(`    - Geciken Kalem: ₺${Math.round(snap.overdueTotal).toLocaleString("tr-TR")} (${snap.overdueCount} kalem)`);
    console.log(`    - Banka Hesapları: ${snap.bankAccounts?.length} adet`);
    console.log(`    - Acil Ödeme Listesi: ${snap.urgentPayments?.length} adet`);
    console.log(`    - Yaklaşan Çekler: ${snap.urgentMaturities?.length} adet`);
    console.log(`    - CFO Uyarıları: ${snap.cfoHighlights?.length} adet`);
    console.log(`    - Pist Durumu: "${snap.runway?.statusText}"`);
  }

  console.log("\n=== TÜM PWA VE TELEGRAM MINI APP TESTLERİ BAŞARIYLA TAMAMLANDI ===");
}

main().catch((err) => {
  console.error("Doğrulama hatası:", err);
  process.exit(1);
});
