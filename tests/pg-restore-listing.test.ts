/**
 * `scripts/db/pg-restore-listing.ts` — native yolun `pg_restore --list` sözleşmesi.
 *
 * Docker yolu aynı kuralları backup-docker-postgres.ts içinde satır içi taşıyor ve o dosya bayt-bayt
 * korunuyor. Bu testler native kopyanın AYNI sözleşmeye uyduğunu sabitler: TOC başlığı pozitif,
 * dört kritik tablonun hem TABLE hem TABLE DATA girdisi, eksik tablo yalnız istendiğinde ret, ve
 * Windows pg_restore'unun CRLF çıktısı.
 */
import { describe, expect, it } from "vitest";
import { parseRestoreListing } from "../scripts/db/pg-restore-listing";

const LISTING = [
  ";",
  "; Archive created at 2026-10-28 03:00:01 UTC",
  ";     dbname: mas_radar_dev",
  ";     TOC Entries: 1391",
  ";     Compression: gzip",
  ";     Dump Version: 1.15-0",
  ";     Format: CUSTOM",
  ";     Dumped from database version: 16.14",
  ";     Dumped by pg_dump version: 16.14",
  ";",
  "; Selected TOC Entries:",
  ";",
  "223; 1259 16399 TABLE public payment_instances postgres",
  "224; 1259 16410 TABLE public payments postgres",
  "225; 1259 16420 TABLE public audit_logs postgres",
  "226; 1259 16430 TABLE public schema_migrations postgres",
  "4990; 0 16399 TABLE DATA public payment_instances postgres",
  "4991; 0 16410 TABLE DATA public payments postgres",
  "4992; 0 16420 TABLE DATA public audit_logs postgres",
  "4993; 0 16430 TABLE DATA public schema_migrations postgres",
  "",
].join("\n");

const ALL_PRESENT = { paymentInstances: true, payments: true, auditLogs: true, schemaMigrations: true };

describe("parseRestoreListing", () => {
  it("LF çıktı: TOC sayısı ve dört kritik tablo", () => {
    expect(parseRestoreListing(LISTING, "x.dump", true)).toEqual({
      restoreListable: true, tocEntryCount: 1391, criticalTablesPresent: ALL_PRESENT,
    });
  });

  it("CRLF çıktı (Windows pg_restore) aynı sonucu verir", () => {
    expect(parseRestoreListing(LISTING.replace(/\n/g, "\r\n"), "x.dump", true)).toEqual({
      restoreListable: true, tocEntryCount: 1391, criticalTablesPresent: ALL_PRESENT,
    });
  });

  it("payment_instances'ın TABLE DATA girdisi yoksa: istenmediyse yalnız raporlanır, istendiyse RED", () => {
    const withoutData = LISTING.replace("4990; 0 16399 TABLE DATA public payment_instances postgres\n", "");
    const lenient = parseRestoreListing(withoutData, "x.dump", false);
    expect(lenient.criticalTablesPresent.paymentInstances).toBe(false);
    expect(lenient.criticalTablesPresent.payments).toBe(true);
    expect(() => parseRestoreListing(withoutData, "x.dump", true)).toThrow(/payment_instances/);
  });

  it("'payments_archive' satırı 'payments'i karşılamaz", () => {
    const archiveOnly = LISTING
      .replace("TABLE public payments postgres", "TABLE public payments_archive postgres")
      .replace("TABLE DATA public payments postgres", "TABLE DATA public payments_archive postgres");
    expect(parseRestoreListing(archiveOnly, "x.dump", false).criticalTablesPresent.payments).toBe(false);
    expect(() => parseRestoreListing(archiveOnly, "x.dump", true)).toThrow(/kritik tablo\(lar\) TOC'ta eksik.*payments/);
  });

  it("boş çıktı reddedilir", () => {
    expect(() => parseRestoreListing("", "x.dump", false)).toThrow(/boş çıktı/);
    expect(() => parseRestoreListing("  \r\n ", "x.dump", false)).toThrow(/boş çıktı/);
  });

  it("TOC başlığı yoksa reddedilir", () => {
    expect(() => parseRestoreListing(LISTING.replace(";     TOC Entries: 1391\n", ""), "x.dump", false))
      .toThrow(/'TOC Entries:' başlığı bulunamadı/);
  });

  it("sıfır TOC girdisi reddedilir", () => {
    expect(() => parseRestoreListing(LISTING.replace("TOC Entries: 1391", "TOC Entries: 0"), "x.dump", false))
      .toThrow(/TOC Entries geçersiz \(0\)/);
  });

  it("hata mesajı dump yolunu taşır (hangi dosyanın düştüğü bellidir)", () => {
    expect(() => parseRestoreListing("", "backups\\daily-2026.dump", false)).toThrow(/backups\\daily-2026\.dump/);
  });
});
