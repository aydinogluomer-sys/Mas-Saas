import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    globals: true,
    environment: "node",
    // Genel bir testTimeout BİLEREK yok (vitest varsayılanı 5 sn). Katmanın eklediği 20 sn'lik genel
    // sınır, bir avuç yavaş vaka yüzünden iki binden fazla testin takılma sinyalini körleştiriyordu.
    // Süresi başka bir şeyden gelen iki sınıf — gerçek bir alt süreç başlatanlar ve bütün bir kaynak
    // ağacını ayrıştıranlar — sınırlarını kendileri, test başına alır: tests/setup/test-timeouts.ts
    // (gerekçe ve ölçümler orada).
    include: ["src/**/*.test.{ts,tsx}", "tests/**/*.test.{ts,tsx}"],
    // QA-F7: jsdom'u worker çatallanmadan önce, süre sınırı olmayan aşamada bir kez yükler.
    // Gerekçe ve ölçümler dosyanın kendi başlığında; özet: jsdom ortam kurulumu vitest'in
    // SABİT KODLU 60 sn'lik worker açılış bütçesi içinde koşuyor ve soğuk dosya önbelleğinde
    // (bu makinede 71 sn ölçüldü) o bütçeyi aşıp süiti rastgele kırmızıya düşürüyordu.
    globalSetup: ["./tests/setup/warm-dom-environment.ts"],
  },
});
