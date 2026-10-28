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
    testTimeout: 20000,
    include: ["src/**/*.test.{ts,tsx}", "tests/**/*.test.{ts,tsx}"],
    // QA-F7: jsdom'u worker çatallanmadan önce, süre sınırı olmayan aşamada bir kez yükler.
    // Gerekçe ve ölçümler dosyanın kendi başlığında; özet: jsdom ortam kurulumu vitest'in
    // SABİT KODLU 60 sn'lik worker açılış bütçesi içinde koşuyor ve soğuk dosya önbelleğinde
    // (bu makinede 71 sn ölçüldü) o bütçeyi aşıp süiti rastgele kırmızıya düşürüyordu.
    globalSetup: ["./tests/setup/warm-dom-environment.ts"],
  },
});
