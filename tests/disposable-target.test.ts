import { describe, expect, it } from "vitest";
import {
  DISPOSABLE_MARKERS,
  PROTECTED_DB_NAMES,
  databaseNameFromUrl,
  isDisposableDatabaseName,
} from "../scripts/db/owner-url";

/**
 * Faz 17-38 denetimi — fixture gate'lerinin hedef veritabanı kapısı.
 *
 * NEDEN SAF YÜKLEM AYRI TEST EDİLİYOR. Kapının kendisi (requireDisposableOwnerDatabaseUrl)
 * process.exit(1) çağırıyor ve bir birim testten çağrılamaz. Bu yüzden KARAR saf bir yükleme
 * ayrıldı ve gerçek kanıt burada üretiliyor — legacy-repair-verify.ts'in
 * isSafeDisposableName / assertSafeDisposableName ayrımıyla aynı desen.
 *
 * ÖLÇÜLEN KUSUR: scripts/phase*-verify.ts ailesinin 40 üyesi bağlantısını
 * requireOwnerDatabaseUrl() üzerinden çözüyordu ve 25'i bir TRUNCATE ile açılıyordu. Hiçbiri
 * hangi veritabanına bağlandığını sormuyordu. Disposable bir DB'de birebir üretildi: payments'a
 * ayırt edilebilir bir satır kondu, phase3-verify aynı DB'ye karşı koşturuldu, "ALL PASS" dedi,
 * satır yok oldu. mas_radar_dev'e çevrilmiş bir DATABASE_URL ile aynı koşu gerçek veriyi
 * silerdi.
 */
describe("disposable hedef kapısı — saf yüklem", () => {
  it("korunan adlar REDDEDİLİYOR", () => {
    for (const name of PROTECTED_DB_NAMES) {
      expect(isDisposableDatabaseName(name), name).toBe(false);
    }
    expect(isDisposableDatabaseName("mas_radar_dev")).toBe(false);
  });

  it("korunan ad, işaret taşısa BİLE reddediliyor (korunan olmak kazanır)", () => {
    // Büyük/küçük harf de kandırmamalı.
    expect(isDisposableDatabaseName("MAS_RADAR_DEV")).toBe(false);
    expect(isDisposableDatabaseName("Postgres")).toBe(false);
  });

  it("disposable işareti TAŞIMAYAN adlar reddediliyor", () => {
    for (const name of ["mas_radar_p0_p3", "mas_radar_prod", "musteri_db", "radar", "mas_radar"]) {
      expect(isDisposableDatabaseName(name), name).toBe(false);
    }
  });

  it("işaret taşıyan adlar kabul ediliyor", () => {
    for (const name of [
      "mas_radar_constraints_verify",
      "mas_radar_preflight_clone",
      "mas_radar_restored",
      "mas_radar_p0_probe",
      "mas_radar_testsprite",
      "bir_sandbox_db",
    ]) {
      expect(isDisposableDatabaseName(name), name).toBe(true);
    }
  });

  it("her işaretin gerçekten kabul ürettiği (liste ölü giriş taşımıyor)", () => {
    for (const marker of DISPOSABLE_MARKERS) {
      expect(isDisposableDatabaseName(`mas_radar_${marker}_x`), marker).toBe(true);
    }
  });

  it("boş / tanımsız ad KABUL DEĞİL reddedilir (fail-closed)", () => {
    expect(isDisposableDatabaseName(undefined)).toBe(false);
    expect(isDisposableDatabaseName("")).toBe(false);
    expect(isDisposableDatabaseName("   ")).toBe(false);
  });

  it("bağlantı dizesinden veritabanı adı doğru okunuyor", () => {
    expect(databaseNameFromUrl("postgres://postgres:postgres@127.0.0.1:5432/mas_radar_x_verify"))
      .toBe("mas_radar_x_verify");
    expect(databaseNameFromUrl("postgresql://u:p@host:5432/db_test?sslmode=disable")).toBe("db_test");
  });

  it("okunamayan bağlantı dizesi 'sorun yok' sayılmıyor", () => {
    // Bozuk bir URL'nin adsız görünüp kapıdan geçmesi, kapının en kötü başarısızlığı olurdu.
    expect(databaseNameFromUrl("bu bir url degil")).toBeUndefined();
    expect(isDisposableDatabaseName(databaseNameFromUrl("bu bir url degil"))).toBe(false);
    expect(isDisposableDatabaseName(databaseNameFromUrl("postgres://host:5432/"))).toBe(false);
  });
});
