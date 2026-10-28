// Version/build metadata. Exposes only non-sensitive provenance (name, version, commit,
// build time, runtime). NO secrets, NO env values, NO financial data.
import { NextResponse } from "next/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { env } from "@/lib/env";
import pkg from "../../../package.json";

export const dynamic = "force-dynamic";

/**
 * Çalışan sunucunun servis ettiği derlemenin kimliği. Next bunu `<distDir>/BUILD_ID` olarak
 * yazar; distDir `MAS_NEXT_DIST_DIR` ile değişebildiği için aynı değişken burada da okunur.
 * Okunamazsa "unreadable" — "unknown" DEĞİL, çünkü bu bir provenance eksikliği değil, dosya
 * erişim durumudur ve ayrı raporlanmalıdır.
 */
function readBuildId(): string {
  try {
    const distDir = process.env.MAS_NEXT_DIST_DIR ?? ".next";
    return readFileSync(path.join(process.cwd(), distDir, "BUILD_ID"), "utf8").trim();
  } catch {
    return "unreadable";
  }
}

export async function GET() {
  return NextResponse.json({
    name: pkg.name,
    version: pkg.version,
    commit: env.appCommitSha,
    buildTime: env.appBuildTime,
    // PHASE 7.4 — derleme kimliği. next.config.ts `generateBuildId` bunu commit SHA'ya eşitler;
    // ikisi farklıysa çalışan `.next` ile bildirilen commit AYRIŞMIŞ demektir (eski build
    // üstüne yeni env ile start edilmiş) ve bu, cutover'da tespit edilmesi gereken bir durumdur.
    buildId: readBuildId(),
    provenance: env.appCommitSha === "unknown" ? "MISSING" : "BUILD_EMBEDDED",
    node: process.version,
    // AŞAMA 09 — rehber §14 RUNTIME listesindeki "uptime". Süreç ne kadardır ayakta; bir
    // yeniden başlatma bunu sıfırlar, dolayısıyla iki ardışık telemetri anlık görüntüsü
    // arasında DÜŞMESİ, sayacı olmayan bir restart'ın gözlemlenebilir izidir (restart_count'un
    // kendisi bu mimaride ölçülemez — scripts/ops/telemetry-snapshot.ts NOT_OBTAINABLE).
    // Sır değil, finansal veri değil: yalnız saniye cinsinden bir sayı.
    uptimeSeconds: Math.round(process.uptime()),
    // NODE_ENV stays a direct read — Next.js inlines it at build time.
    env: process.env.NODE_ENV ?? "unknown",
  });
}
