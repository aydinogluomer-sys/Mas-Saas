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
  experimental: {
    ...(process.env.MAS_NEXT_CPUS ? { cpus: Number(process.env.MAS_NEXT_CPUS) } : {}),
    // PHASE 4 (plan §4.4): Standart Import V2 dosya sınırı 50 MB'dir ve bu sınır UYGULAMA
    // katmanında açık bir mesajla uygulanır (service.ts UPLOAD_LIMITS). Next'in sunucu eylemi
    // gövde sınırı varsayılan 1 MB; onun altında kalsaydı 1 MB'lik bir dosya bile anlaşılmaz
    // bir çerçeve hatasıyla düşerdi. 52 MB: uygulama sınırı + multipart payı — böylece 50 MB
    // üstü dosyayı çerçeve değil, sebebini söyleyen uygulama reddeder.
    serverActions: { bodySizeLimit: "52mb" },
  },
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
