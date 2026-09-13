// PHASE 7.3 — yedek tazelik sözleşmesi: "doğrulanmış yedek" tanımının totoloji olmadığının kanıtı.
//
// Her ret sebebi AYRI AYRI ateşlenir (makbuz yok, sha uyuşmaz, boyut uyuşmaz, PGDMP yok, TOC
// kanıtı yok, 0 bayt, makbuz zamanı bozuk) ve tam geçerli aday temiz okunur. Yaş iki zamanın
// YAŞLI olanıdır — taze mtime'lı eski makbuz da, taze makbuzlu eski dosya da yedeği genç
// göstermez. Boş dizin ve "dizin yok" +Infinity döndürür ki mevcut backupAgeAlert alarm versin.

import { describe, expect, it } from "vitest";
import {
  BACKUP_RECEIPT_KIND,
  DISK_CRIT_GB,
  DISK_WARN_GB,
  describeFreshness,
  diskPressureLevel,
  evaluateBackupFreshness,
  type DumpCandidate,
  type FreshnessProbe,
  type ReceiptFields,
  type TocEvidence,
} from "@/lib/ops/backup-freshness";
import { backupAgeAlert } from "@/lib/ops/telemetry-alerts";

const NOW = Date.parse("2026-09-13T09:00:00.000Z");
const H = 3_600_000;

interface Fixture {
  candidate: DumpCandidate;
  header?: string;
  sha?: string;
  receipt?: ReceiptFields | null;
  toc?: TocEvidence | null;
}

function probeOf(fixtures: Fixture[]): FreshnessProbe {
  const byPath = new Map(fixtures.map((f) => [f.candidate.path, f]));
  return {
    listDumps: () => fixtures.map((f) => f.candidate),
    readReceipt: (p) => byPath.get(p)?.receipt ?? null,
    readHeader: (p) => byPath.get(p)?.header ?? "PGDMP",
    sha256: (p) => byPath.get(p)?.sha ?? "sha-A",
    tocEvidence: (p) => (byPath.get(p)?.toc === undefined ? { entries: 1391, source: "pg_restore_now" } : byPath.get(p)!.toc!),
  };
}

function good(name: string, ageHours: number, extra: Partial<Fixture> = {}): Fixture {
  const t = NOW - ageHours * H;
  return {
    candidate: { name, path: `/b/${name}`, bytes: 1000, mtimeMs: t },
    receipt: { receiptKind: BACKUP_RECEIPT_KIND, timestamp: new Date(t).toISOString(), sha256: "sha-A", file_size: 1000, source_db: "mas_radar_dev", schema_ledger: "94/0094" },
    ...extra,
  };
}

describe("evaluateBackupFreshness — geçerli yedek", () => {
  it("beş koşulu birden sağlayan en yeni aday doğrulanmış sayılır ve yaşı okunur", () => {
    const e = evaluateBackupFreshness(probeOf([good("daily-new.dump", 5), good("daily-old.dump", 30)]), { now: NOW });
    expect(e.verified?.name).toBe("daily-new.dump");
    expect(e.ageHours).toBeCloseTo(5, 6);
    expect(e.verified?.toc).toEqual({ entries: 1391, source: "pg_restore_now" });
    expect(e.verified?.schemaLedger).toBe("94/0094");
    expect(e.rejected).toEqual([]);
    expect(e.scanned).toBe(1); // ilk geçen durur
    expect(backupAgeAlert(e.ageHours, 36)).toBe(false);
  });

  it("en yeni aday bozuksa bir sonraki geçerli aday alınır ve ret sebebi kaydedilir", () => {
    const e = evaluateBackupFreshness(probeOf([good("daily-new.dump", 1, { receipt: null }), good("daily-old.dump", 20)]), { now: NOW });
    expect(e.verified?.name).toBe("daily-old.dump");
    expect(e.ageHours).toBeCloseTo(20, 6);
    expect(e.rejected).toEqual([{ name: "daily-new.dump", reason: "stage07 makbuzu yok/okunamıyor" }]);
  });

  it("yaş, makbuz zamanı ile mtime'ın YAŞLI olanıdır (hiçbir tek alan yedeği genç gösteremez)", () => {
    const freshMtimeOldReceipt = good("copied.dump", 1);
    freshMtimeOldReceipt.receipt = { ...freshMtimeOldReceipt.receipt, timestamp: new Date(NOW - 50 * H).toISOString() };
    const e1 = evaluateBackupFreshness(probeOf([freshMtimeOldReceipt]), { now: NOW });
    expect(e1.ageHours).toBeCloseTo(50, 6);
    expect(backupAgeAlert(e1.ageHours, 36)).toBe(true);

    const freshReceiptOldMtime = good("touched.dump", 50);
    freshReceiptOldMtime.receipt = { ...freshReceiptOldMtime.receipt, timestamp: new Date(NOW - 1 * H).toISOString() };
    const e2 = evaluateBackupFreshness(probeOf([freshReceiptOldMtime]), { now: NOW });
    expect(e2.ageHours).toBeCloseTo(50, 6);
  });

  it("sha-bağlı TOC kanıtı (koşu kaydı / off-device kaydı) da kabul edilir ve kaynağı adıyla raporlanır", () => {
    const e = evaluateBackupFreshness(probeOf([good("d.dump", 2, { toc: { entries: 7, source: "run_log_sha_bound" } })]), { now: NOW });
    expect(e.verified?.toc.source).toBe("run_log_sha_bound");
    expect(describeFreshness(e, 36)).toContain("yedek anında ölçüldü, sha256 ile bağlı");
  });
});

describe("evaluateBackupFreshness — her ret sebebi ayrı ayrı ateşlenir", () => {
  const cases: Array<[string, Partial<Fixture>, string]> = [
    ["makbuz yok", { receipt: null }, "stage07 makbuzu yok"],
    ["makbuz türü yanlış", { receipt: { receiptKind: "baska-v9", sha256: "sha-A", file_size: 1000, timestamp: new Date(NOW).toISOString() } }, "makbuz türü"],
    ["sha256 uyuşmuyor", { sha: "sha-B" }, "sha256 makbuzla EŞLEŞMİYOR"],
    ["boyut uyuşmuyor", { candidate: { name: "x.dump", path: "/b/x.dump", bytes: 999, mtimeMs: NOW } }, "boyut makbuzla eşleşmiyor"],
    ["PGDMP başlığı yok", { header: "-- SQ" }, "PGDMP başlığı yok"],
    ["0 bayt", { candidate: { name: "x.dump", path: "/b/x.dump", bytes: 0, mtimeMs: NOW } }, "0 bayt"],
    ["TOC kanıtı yok", { toc: null }, "pg_restore --list kanıtı yok"],
    ["TOC boş", { toc: { entries: 0, source: "pg_restore_now" } }, "boş arşiv"],
  ];
  for (const [label, extra, reason] of cases) {
    it(`${label} → doğrulanmış yedek YOK, yaş sonsuz, alarm`, () => {
      const f = good("x.dump", 1, extra);
      const e = evaluateBackupFreshness(probeOf([f]), { now: NOW });
      expect(e.verified).toBeNull();
      expect(e.ageHours).toBe(Number.POSITIVE_INFINITY);
      expect(e.rejected[0]?.reason).toContain(reason);
      expect(backupAgeAlert(e.ageHours, 36)).toBe(true);
      expect(describeFreshness(e, 36)).toContain("DOĞRULANMIŞ YEDEK YOK");
    });
  }

  it("makbuz zamanı bozuksa reddedilir", () => {
    const f = good("x.dump", 1);
    f.receipt = { ...f.receipt, timestamp: "dün gece" };
    const e = evaluateBackupFreshness(probeOf([f]), { now: NOW });
    expect(e.verified).toBeNull();
    expect(e.rejected[0]?.reason).toBe("makbuz zamanı okunamıyor");
  });

  it("boş dizin → sonsuz yaş ve 0 aday", () => {
    const e = evaluateBackupFreshness(probeOf([]), { now: NOW });
    expect(e).toEqual({ verified: null, ageHours: Number.POSITIVE_INFINITY, scanned: 0, rejected: [] });
  });

  it("yalnız en yeni N aday incelenir (800+ dosyalı dizinde hepsinin sha256'sı hesaplanmaz)", () => {
    const fixtures = Array.from({ length: 12 }, (_, i) => good(`d${i}.dump`, i + 1, { receipt: null }));
    fixtures.push(good("ancient-good.dump", 400));
    const e = evaluateBackupFreshness(probeOf(fixtures), { now: NOW, maxCandidates: 5 });
    expect(e.scanned).toBe(5);
    expect(e.verified).toBeNull(); // geçerli olan 13. sırada — tarama sınırı onu görmez ve bu doğrudur: 400 saatlik yedek zaten bayattır
  });
});

describe("diskPressureLevel — yalnız uyarır, hiçbir şey silmez", () => {
  it("eşikler: <5 kritik, <10 uyarı, ≥10 normal; ölçülemeyen = unknown (alarm)", () => {
    expect(DISK_WARN_GB).toBe(10);
    expect(DISK_CRIT_GB).toBe(5);
    expect(diskPressureLevel(2.21)).toBe("critical");
    expect(diskPressureLevel(4.99)).toBe("critical");
    expect(diskPressureLevel(5)).toBe("warning");
    expect(diskPressureLevel(9.99)).toBe("warning");
    expect(diskPressureLevel(10)).toBe("ok");
    expect(diskPressureLevel(237)).toBe("ok");
    expect(diskPressureLevel(null)).toBe("unknown");
    expect(diskPressureLevel(Number.NaN)).toBe("unknown");
  });
  it("eşikler parametreyle yükseltilebilir (negatif kontrol: gerçek ölçümle alarm tetiklemek için)", () => {
    expect(diskPressureLevel(200, 999_999, 999_998)).toBe("critical");
    expect(diskPressureLevel(200, 999_999, 1)).toBe("warning");
  });
});
