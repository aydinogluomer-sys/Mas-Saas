/**
 * `scripts/ops/backup-daily.ts` — kaynak kapısı ve başarısız koşu kaydı.
 *
 * ═══ ÖLÇÜLEN İKİ KUSUR ═══
 *
 *   1. 2026-10-18 ile 10-28 arasında owner URL'i bir bulut kiracısının `postgres` veritabanına
 *      çevrilmişti ve günlük görev her gece onu yedeklemeye çalıştı. Kaynak artık sabittir: bu
 *      makinedeki `mas_radar_dev`; başka her şey HİÇBİR bağlantı açılmadan reddedilir.
 *   2. Başarısız geceler `backups/daily-runs.jsonl`e hiçbir şey yazmıyordu (son kayıt
 *      2026-09-15). Artık her sıfırdan farklı çıkış bir `{ ok:false, exitCode, stage, error }`
 *      satırı bırakır — hata metni parolalardan arındırılmış olarak.
 */
import { describe, expect, it } from "vitest";
import { assertCanonicalBackupSource, buildDailyRunRecord, CANONICAL_BACKUP_SOURCE_DB } from "../scripts/ops/backup-daily";

const SECRET = "Gece-Yedegi-Parola-1";

describe("assertCanonicalBackupSource", () => {
  it("bu makinedeki mas_radar_dev kabul edilir", () => {
    expect(CANONICAL_BACKUP_SOURCE_DB).toBe("mas_radar_dev");
    expect(() => assertCanonicalBackupSource(`postgres://postgres:${SECRET}@127.0.0.1:5432/mas_radar_dev`)).not.toThrow();
  });

  it("aynı makinede başka bir veritabanı reddedilir", () => {
    expect(() => assertCanonicalBackupSource(`postgres://postgres:${SECRET}@127.0.0.1:5432/postgres`)).toThrow(/mas_radar_dev/);
    expect(() => assertCanonicalBackupSource(`postgres://postgres:${SECRET}@127.0.0.1:5432/mas_radar_x_verify`)).toThrow(/mas_radar_dev/);
  });

  it("bulut host'u reddedilir — host ve parola mesajda yok", () => {
    let msg = "";
    try {
      assertCanonicalBackupSource(`postgresql://postgres.tenant:${SECRET}@aws-0-eu.pooler.example.com:6543/postgres`);
    } catch (err) {
      msg = (err as Error).message;
    }
    expect(msg).toMatch(/bu makine değil/);
    expect(msg).not.toContain("pooler.example.com");
    expect(msg).not.toContain(SECRET);
  });
});

describe("buildDailyRunRecord", () => {
  const startedAt = new Date("2026-10-28T03:00:00.000Z");
  const finishedAt = new Date("2026-10-28T03:00:04.000Z");

  it("ok:false, exitCode ve stage korunur; bağlantı dizesindeki parola maskelenir", () => {
    const record = buildDailyRunRecord({
      startedAt, finishedAt, exitCode: 1, stage: "dump", sourceDb: "mas_radar_dev",
      error: new Error(`pg_dump failed for postgres://postgres:${SECRET}@127.0.0.1:5432/mas_radar_dev`),
      secrets: [SECRET],
    });
    expect(record).toMatchObject({
      startedAt: "2026-10-28T03:00:00.000Z", finishedAt: "2026-10-28T03:00:04.000Z",
      ok: false, exitCode: 1, stage: "dump", source_db: "mas_radar_dev",
    });
    expect(String(record.error)).not.toContain(SECRET);
    expect(String(record.error)).toContain("postgres://postgres:***@127.0.0.1");
  });

  it("bağlantı dizesi dışında geçen çıplak parola da tam-değerle maskelenir", () => {
    const record = buildDailyRunRecord({
      startedAt, finishedAt, exitCode: 1, stage: "identity", sourceDb: null,
      error: `kimlik okunamadı (${SECRET})`, secrets: [SECRET],
    });
    expect(record.error).toBe("kimlik okunamadı (***)");
    expect(record.source_db).toBeNull();
  });

  it("hata metni sınırlı uzunlukta yazılır", () => {
    const record = buildDailyRunRecord({
      startedAt, finishedAt, exitCode: 1, stage: "config", sourceDb: null, error: new Error("x".repeat(5000)),
    });
    expect(String(record.error).length).toBe(2000);
  });
});
