import type { NextConfig } from "next";
import { execFileSync } from "node:child_process";

const projectRoot = process.cwd();

/**
 * PHASE 7.4 — runtime provenance. `/version` "commit: unknown" döndüremez.
 *
 * NEDEN BURADA. `APP_COMMIT_SHA` yalnız çalışma zamanı env'inden okunuyordu ve `next build`
 * hiçbir şey enjekte etmiyordu; operatör `next start` öncesi elle ayarlamazsa "unknown"
 * kalıyordu. Canlı örnek gerçekten "unknown" raporladı (2026-08-25). Hangi kodun çalıştığı
 * ispatlanamayan bir sistemin cutover kabulü yapılamaz.
 *
 * ÖNCELİK: açık env (CI `APP_COMMIT_SHA=${{github.sha}}` verir) > git HEAD > HATA.
 * "unknown"a düşmek YOK: derleme anında belirlenemeyen commit, plan §7.4 gereği kabul edilmez.
 * `next build` her zaman NODE_ENV=production ile koşar, dolayısıyla bu kural her derlemeye
 * uygulanır. Git olmayan bir ortamda derleme yapılıyorsa APP_COMMIT_SHA açıkça verilmelidir.
 *
 * SIR DEĞİL: commit SHA ve derleme zamanı istemci paketine de gömülür (Next `env` alanı
 * böyle çalışır). İkisi de kamusal provenance bilgisidir.
 */
function resolveCommitSha(): string {
  const fromEnv = process.env.APP_COMMIT_SHA?.trim();
  if (fromEnv) return fromEnv;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8" }).trim();
  } catch {
    throw new Error(
      "APP_COMMIT_SHA belirlenemedi: env'de yok ve `git rev-parse HEAD` başarısız. " +
        "/version 'unknown' döndüremez (plan §7.4). Derlemeden önce APP_COMMIT_SHA=<sha> verin.",
    );
  }
}
const commitSha = resolveCommitSha();
const buildTime = process.env.APP_BUILD_TIME?.trim() || new Date().toISOString();

const nextConfig: NextConfig = {
  // Derleme kimliği = commit SHA. `.next/BUILD_ID` artık hangi commit'ten üretildiğini kendi
  // adıyla söyler; /version'daki `buildId` ile `commit` aynı değeri taşımalıdır.
  generateBuildId: () => commitSha,
  env: {
    APP_COMMIT_SHA: commitSha,
    APP_BUILD_TIME: buildTime,
  },
  // Derleme çıktısı dizini — varsayılan `.next`, ortam değişkeniyle geçersiz kılınabilir.
  //
  // NEDEN VAR. Bu makinede canlı bir production sunucusu repo'nun `.next/` dizininden servis
  // ediyor. Bir release kapısı (scripts/release/real-clone-gate.ts) kendi doğrulama derlemesini
  // yaparken düz `pnpm build` çağırsa, çalışan sunucunun altındaki chunk'ları ezer: eksik/eskimiş
  // chunk, 500'ler, Windows'ta kilitli dosya hatası. Kapı kendi çıktısını ayrı bir dizine yazar
  // (MAS_NEXT_DIST_DIR=.next-real-clone-gate) ve canlı örneğe dokunmaz.
  //
  // Değişken tanımsızken davranış birebir eskisi: `.next`. Bu, "tek Next sunucusu `.next`'in
  // sahibidir" kuralını bozmadan ikinci bir derlemeye izin vermenin tek güvenli yolu.
  distDir: process.env.MAS_NEXT_DIST_DIR ?? ".next",
  // ESLint remains a required standalone quality gate (`npm run lint`).
  // The build worker cannot resolve pnpm's transitive plugin symlinks on this
  // Windows installation, so do not duplicate lint inside `next build`.
  eslint: { ignoreDuringBuilds: true },
  // No dev overlay indicator — keeps visual-regression screenshots deterministic.
  devIndicators: false,
  outputFileTracingRoot: projectRoot,
  // Derleme paralelliği — varsayılan `os.cpus()`, ortam değişkeniyle kısılabilir.
  //
  // NEDEN VAR. `next build` her CPU için bir worker süreci açar ve her biri kendi heap'ini
  // taşır. Bu makinede toplam 7.9 GB RAM var ve editör/Docker/WSL 5+ GB'ını tutuyor; ölçülen
  // boş bellek 0.4 GB'a kadar indi. O noktada worker'lar "Collecting page data" adımında
  // sessizce öldürülüyor ve `next build` çıktı vermeden exit 4294967295 (=-1) ile düşüyor —
  // hata mesajı YOK, çünkü süreç kendi hatasını yazamadan gidiyor. Bir derleme hatası gibi
  // görünen şey aslında OOM'du ve teşhisi bu yüzden pahalı: log boş kalıyor.
  //
  // Değişken tanımsızken davranış birebir eskisi (Next kendi varsayılanını seçer). Kısıtlı
  // makinede `MAS_NEXT_CPUS=1` derlemeyi yavaşlatır ama BİTİRİR.
  ...(process.env.MAS_NEXT_CPUS ? { experimental: { cpus: Number(process.env.MAS_NEXT_CPUS) } } : {}),
  turbopack: {
    root: projectRoot,
  },
  async redirects() {
    return [
      { source: "/ask", destination: "/insights/ask", permanent: true },
      { source: "/reports", destination: "/insights/reports", permanent: true },
      { source: "/reports/:reportId", destination: "/insights/reports/:reportId", permanent: true },
      { source: "/financing/loans/:loanId", destination: "/finance/loans/:loanId", permanent: true },
      { source: "/reminders", destination: "/insights/reminders", permanent: true },
      { source: "/assumptions", destination: "/data/assumptions", permanent: true },
      { source: "/data-quality", destination: "/data/quality", permanent: true },
      { source: "/imports", destination: "/data/imports", permanent: true },
      { source: "/imports/:workbookId", destination: "/data/imports/:workbookId", permanent: true },
      { source: "/imports/:workbookId/reviews", destination: "/data/imports/:workbookId/reviews", permanent: true },
      { source: "/imports/:workbookId/sheets/:sheetId", destination: "/data/imports/:workbookId/sheets/:sheetId", permanent: true },
      { source: "/financing", destination: "/finance", permanent: true },
      { source: "/radar", destination: "/payments", permanent: true },
      { source: "/calendar", destination: "/payments/calendar", permanent: true },
      { source: "/admin", destination: "/system", permanent: true },
      { source: "/phases", destination: "/system/features", permanent: true },
    ];
  },
};

export default nextConfig;
