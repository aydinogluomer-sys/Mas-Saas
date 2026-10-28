// `pg_restore --list` çıktısının SAF ayrıştırıcısı (native yol).
//
// NEDEN AYRI BİR DOSYA. Docker yolu bu kuralları `backup-docker-postgres.ts` içinde satır içi
// taşıyor ve o dosya bayt-bayt korunuyor: legacy-repair-verify.ts ve phase33-verify.ts onun
// KAYNAK METNİNİ doğruluyor. Native yol aynı sözleşmeye — aynı kurallar, aynı Türkçe mesajlar —
// uymak zorunda; bu yüzden kurallar burada, veritabanı ve PostgreSQL ikilisi olmadan birim
// testle (tests/pg-restore-listing.test.ts) kanıtlanabilen tek bir fonksiyonda yaşar. İki kopyayı
// birleştirmek ancak o kaynak-metin doğrulamaları güncellendiğinde mümkün; o güne kadar
// sözleşmenin eşitliğini testler taşır.
//
// Windows'taki pg_restore satırları CRLF ile yazar; ayrıştırıcı ikisini de kabul eder.
import type { RestoreVerificationResult } from "./backup-docker-postgres";

export const CRITICAL_TABLES = ["payment_instances", "payments", "audit_logs", "schema_migrations"] as const;

const CRITICAL_TABLE_PROPERTY: Record<
  (typeof CRITICAL_TABLES)[number],
  keyof RestoreVerificationResult["criticalTablesPresent"]
> = {
  payment_instances: "paymentInstances",
  payments: "payments",
  audit_logs: "auditLogs",
  schema_migrations: "schemaMigrations",
};

/**
 * Arşivin içindekiler listesini doğrular ve YAPISAL kanıt döndürür.
 *
 * - boş çıktı → hata (ayrıştırılamayan arşiv)
 * - `TOC Entries:` başlığı yok ya da pozitif değil → hata
 * - her kritik tablo için hem `TABLE public <t> ` hem `TABLE DATA public <t> ` aranır; sondaki
 *   boşluk bilerek orada: `payments_archive` satırı `payments`i karşılamaz
 * - eksik kritik tablo YALNIZ `requireCriticalTables` true iken reddedilir; migrate.ts'in
 *   ön-migrasyon yedekleri `schema_migrations`ı henüz taşımayan veritabanlarını da yedekler
 */
export function parseRestoreListing(
  listing: string,
  dumpPath: string,
  requireCriticalTables: boolean,
): RestoreVerificationResult {
  if (!listing || listing.trim().length === 0) {
    throw new Error(`Yedek doğrulanamadı: 'pg_restore --list' boş çıktı döndürdü (${dumpPath}).`);
  }
  const text = listing.replace(/\r\n?/g, "\n");

  const tocMatch = text.match(/TOC Entries:\s*(\d+)/);
  if (!tocMatch) {
    throw new Error(`Yedek doğrulanamadı: 'TOC Entries:' başlığı bulunamadı (${dumpPath}).`);
  }
  const tocEntryCount = Number(tocMatch[1]);
  if (!(tocEntryCount > 0)) {
    throw new Error(`Yedek doğrulanamadı: TOC Entries geçersiz (${tocEntryCount}) (${dumpPath}).`);
  }

  const criticalTablesPresent = { paymentInstances: false, payments: false, auditLogs: false, schemaMigrations: false };
  const missing: string[] = [];
  for (const tableName of CRITICAL_TABLES) {
    const hasTable = text.includes(`TABLE public ${tableName} `);
    const hasTableData = text.includes(`TABLE DATA public ${tableName} `);
    const present = hasTable && hasTableData;
    criticalTablesPresent[CRITICAL_TABLE_PROPERTY[tableName]] = present;
    if (!present) missing.push(tableName);
  }
  if (requireCriticalTables && missing.length > 0) {
    throw new Error(
      `Yedek doğrulanamadı: kritik tablo(lar) TOC'ta eksik (TABLE ve/veya TABLE DATA girdisi yok): ${missing.join(", ")} (${dumpPath}).`,
    );
  }

  return { restoreListable: true, tocEntryCount, criticalTablesPresent };
}
