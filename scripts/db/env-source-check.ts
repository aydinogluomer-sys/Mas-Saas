// AŞAMA 11 / B5 — cutover C1 adımının ("environment hygiene") çalıştırılabilir hâli.
//
// Rehber §20-C1 operatörden "eski shell environment değerlerini listele, yanlışsa temizle,
// yeni temiz shell kullan, connection string'i loglama" diyor. Bu üç cümlenin gözle yapılan
// hâli bu makinede bir kez başarısız oldu; bu script onu bir kapıya çevirir.
//
// ÇIKTI SÖZLEŞMESİ: yalnız değişken adı, kaynağı ve hedefin `kullanıcı@veritabanı` etiketi.
// Bağlantı dizesi, parola ve host hiçbir kolda yazdırılmaz.
//
// EXIT KODU: gölgeleme varsa 1. Bu script'i operatör BİLEREK çalıştırır (C1 adımı), dolayısıyla
// yüksek sesle durmak doğru davranıştır — `scripts/db/migrate.ts`'e eklenen aynı uyarı ise
// varsayılan olarak ÖLDÜRMEZ, çünkü release gate'leri (golden-fingerprint, real-clone-gate)
// hedefi bilerek çocuk ortamda değiştirir ve o kasıtlı gölgeleme bir hata değildir.
//
// Kullanım:
//   pnpm db:env:source
import { readEnvLocal } from "./app-url";
import {
  CONNECTION_ENV_NAMES,
  describeEnvSource,
  inspectEnvSources,
  shadowedNames,
} from "./env-source";

function main(): void {
  let fileEnv: Record<string, string> = {};
  let fileNote = ".env.local okundu";
  try {
    fileEnv = readEnvLocal();
  } catch {
    fileNote = ".env.local YOK — yalnız kabuk değerleri raporlanıyor";
  }

  const findings = inspectEnvSources(CONNECTION_ENV_NAMES, process.env, fileEnv);

  console.log(`BAĞLANTI ORTAMI KAYNAK RAPORU (${fileNote})`);
  console.log("Değerler yazdırılmaz — yalnız kaynak ve kullanıcı@veritabanı etiketi.\n");
  for (const finding of findings) console.log(`  ${describeEnvSource(finding)}`);

  const shadowed = shadowedNames(findings);
  console.log("");
  if (shadowed.length > 0) {
    console.error(
      `ENV SHADOWING: ${shadowed.join(", ")} — kabuktaki değer .env.local'ı geçersiz kılıyor.\n` +
        "Bu tam olarak 2026-08-25 canlı denemesinde yaşanan durumdur: .env.local düzeltildi,\n" +
        "hata sürdü, çünkü eski oturumdaki değer kazanıyordu. Cutover C1 adımı BURADA durur.\n" +
        "Düzeltme: yeni bir PowerShell penceresi açın (ya da\n" +
        "  Remove-Item Env:DATABASE_URL; Remove-Item Env:MIGRATION_DATABASE_URL\n" +
        "ile temizleyin) ve değişkenleri o oturumda AÇIKÇA tanımlayın.",
    );
    process.exit(1);
  }

  const invisible = findings.filter((f) => f.source === "env-local-only");
  if (invisible.length > 0) {
    console.log(
      `NOT: ${invisible.map((f) => f.name).join(", ")} yalnız .env.local'da tanımlı. Next runtime\n` +
        "bunu okur; `tsx` script'leri (migrate, seed, verify) OKUMAZ ve o değişkeni görmez.\n" +
        "Cutover adımlarını çalıştıracak kabukta AÇIKÇA tanımlanmalıdır.",
    );
  }
  console.log("ENV SOURCE: gölgeleme yok.");
}

main();
