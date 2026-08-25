import type { NextConfig } from "next";

const projectRoot = process.cwd();

const nextConfig: NextConfig = {
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
