// Gerçek DB'de yıkıcı işlem açan off-device kapısının testleri.
//
// NEDEN VAR. Bu kapı `scripts/db/fixture-cleanup.ts`'in gerçek `public.users` /
// `public.payments` satırlarını silmesine izin veren tek şeydir. Kapının kendisi bir kez
// SESSİZCE bozuktu: cleanup `targetSha256Verified` arıyordu, `offdevice-copy.ts` ise
// `sha256VerifiedAtDestination` üretiyordu. İkisi hiç karşılaşmadığı için hata gizli kaldı ve
// ancak harici disk takıldığı gün — yani en kötü anda — ortaya çıkacaktı. Aşağıdaki
// "gerçek üretilen kayıt" ve "eski yanlış alan adları" testleri tam olarak bunu bekler.
import { describe, expect, it } from "vitest";
import {
  offDeviceCleanupBlockers,
  CLEANUP_GRADE_TARGET_KINDS,
  OFFDEVICE_RECORD_KIND,
  type OffDeviceCopyRecord,
} from "../scripts/ops/backup-lib";

/** `offdevice-copy.ts`'in GERÇEKTEN ürettiği kaydın birebir şekli. */
function realRecord(over: Partial<OffDeviceCopyRecord> = {}): OffDeviceCopyRecord {
  return {
    receiptKind: OFFDEVICE_RECORD_KIND,
    copiedAt: "2026-08-26T09:00:00.000Z",
    sourcePath: "backups/stage07_real-2026-08-26.dump",
    sourceSha256: "a".repeat(64),
    sourceBytes: 1_393_193,
    destPath: "E:/mas-yedek/stage07_real-2026-08-26.dump",
    destSha256: "a".repeat(64),
    destBytes: 1_393_193,
    sha256VerifiedAtDestination: true,
    bytesVerifiedAtDestination: true,
    destRestoreListable: true,
    destTocEntryCount: 1387,
    sidecarsCopied: ["stage07_real-2026-08-26.dump.receipt.json"],
    targetKind: "REMOVABLE_VOLUME",
    offDeviceSatisfied: true,
    targetEvidence: "Win32_LogicalDisk DriveType=2 (çıkarılabilir) — kök E:\\",
    durability: { platform: "win32", durabilityMode: "full-directory-fsync" } as OffDeviceCopyRecord["durability"],
    ...over,
  };
}

describe("off-device kapısı — geçerli kayıt", () => {
  it("gerçek üretilen kayıt şekli kabul edilir (alan adları iki script arasında UYUŞUYOR)", () => {
    expect(offDeviceCleanupBlockers(realRecord())).toEqual([]);
  });

  it("ağ sürücüsü ve UNC payı da kabul edilir — aynı fiziksel ayrılık", () => {
    expect(offDeviceCleanupBlockers(realRecord({ targetKind: "NETWORK_DRIVE" }))).toEqual([]);
    expect(offDeviceCleanupBlockers(realRecord({ targetKind: "UNC_NETWORK_SHARE" }))).toEqual([]);
  });

  it("ölçümle kanıtlanmış USB fiziksel diski kabul edilir", () => {
    // DriveType=3 görünen ama Get-Disk ile ayrı USB aygıtı olduğu ÖLÇÜLEN hedef.
    // Sınıfı üreten karar `offdevice-usb-topology.test.ts`'de ayrıca sınanıyor.
    const rec = realRecord({
      targetKind: "USB_PHYSICAL_VOLUME",
      destPath: "D:/MAS-Backups/stage07_real-2026-08-26.dump",
      targetEvidence:
        "USB ile bağlı ayrı fiziksel disk ÖLÇÜLDÜ — DriveType=3, BusType=USB, " +
        "targetDisk=1, sourceDisk=0, IsBoot=false, IsSystem=false",
    });
    expect(offDeviceCleanupBlockers(rec)).toEqual([]);
  });
});

describe("off-device kapısı — REGRESYON: alan adı ayrışması", () => {
  it("ESKİ yanlış alan adlarını taşıyan kayıt REDDEDİLİR", () => {
    // Cleanup'ın bir zamanlar aradığı adlar. Bu şekil asla üretilmedi; kapı onu
    // "doğrulanmamış" saymalı, sessizce geçirmemeli.
    const eski = {
      receiptKind: OFFDEVICE_RECORD_KIND,
      offDeviceSatisfied: true,
      targetSha256Verified: true,
      sha256Verified: true,
      targetKind: "REMOVABLE_VOLUME",
    };
    const blockers = offDeviceCleanupBlockers(eski);
    expect(blockers.length).toBeGreaterThan(0);
    expect(blockers.join(" ")).toContain("sha256VerifiedAtDestination");
    expect(blockers.join(" ")).toContain("bytesVerifiedAtDestination");
    expect(blockers.join(" ")).toContain("destRestoreListable");
  });
});

describe("off-device kapısı — OPERATOR_ATTESTED yıkıcı işlem açamaz", () => {
  it("yalnız BEYANLA üretilen sınıf reddedilir (offDeviceSatisfied true olsa bile)", () => {
    const rec = realRecord({ targetKind: "OPERATOR_ATTESTED", offDeviceSatisfied: true });
    const blockers = offDeviceCleanupBlockers(rec);
    expect(blockers.length).toBe(1);
    expect(blockers[0]).toContain("OPERATOR_ATTESTED");
    expect(blockers[0]).toContain("beyandır");
  });

  it("izinli sınıf kümesi OPERATOR_ATTESTED içermez", () => {
    expect(CLEANUP_GRADE_TARGET_KINDS.has("OPERATOR_ATTESTED" as never)).toBe(false);
    expect([...CLEANUP_GRADE_TARGET_KINDS].sort()).toEqual(
      ["NETWORK_DRIVE", "REMOVABLE_VOLUME", "UNC_NETWORK_SHARE", "USB_PHYSICAL_VOLUME"],
    );
  });

  it("beyan, ölçülmüş bir USB kaydını taklit ederek kapıdan geçemez", () => {
    // Aynı kanıt metni, ama sınıf beyana dayanıyor: yine reddedilir. Kapı metne değil
    // SINIFA bakar, çünkü kanıt string'ini kopyalamak ölçüm yapmak değildir.
    const rec = realRecord({
      targetKind: "OPERATOR_ATTESTED",
      targetEvidence: "DriveType=3, BusType=USB, targetDisk=1, sourceDisk=0, IsBoot=false, IsSystem=false",
    });
    expect(offDeviceCleanupBlockers(rec).join(" ")).toContain("OPERATOR_ATTESTED");
  });
});

describe("off-device kapısı — dört zorunlu doğrulamanın her biri tek başına engeller", () => {
  const zorunlu = [
    "offDeviceSatisfied",
    "sha256VerifiedAtDestination",
    "bytesVerifiedAtDestination",
    "destRestoreListable",
  ] as const;

  for (const alan of zorunlu) {
    it(`${alan} = false ise REDDEDİLİR`, () => {
      const blockers = offDeviceCleanupBlockers(realRecord({ [alan]: false } as Partial<OffDeviceCopyRecord>));
      expect(blockers.some((b) => b.startsWith(alan))).toBe(true);
    });

    it(`${alan} eksikse REDDEDİLİR (undefined true sayılmaz)`, () => {
      const rec: Record<string, unknown> = { ...realRecord() };
      delete rec[alan];
      expect(offDeviceCleanupBlockers(rec).some((b) => b.startsWith(alan))).toBe(true);
    });
  }
});

describe("off-device kapısı — sabit diskteki hedefler", () => {
  it("LOCAL_STANDIN reddedilir", () => {
    const blockers = offDeviceCleanupBlockers(realRecord({ targetKind: "LOCAL_STANDIN", offDeviceSatisfied: false }));
    expect(blockers.length).toBeGreaterThanOrEqual(2);
  });

  it("FIXED_SEPARATE_VOLUME reddedilir — aynı makinedeki ikinci bölüm ayrı aygıt değildir", () => {
    const blockers = offDeviceCleanupBlockers(realRecord({ targetKind: "FIXED_SEPARATE_VOLUME", offDeviceSatisfied: false }));
    expect(blockers.join(" ")).toContain("FIXED_SEPARATE_VOLUME");
  });
});

describe("off-device kapısı — bozuk girdi", () => {
  it("yanlış receiptKind reddedilir", () => {
    expect(offDeviceCleanupBlockers(realRecord({ receiptKind: "baska-sema" as never })).join(" "))
      .toContain("receiptKind");
  });

  it("nesne olmayan girdi reddedilir", () => {
    expect(offDeviceCleanupBlockers(null)).toEqual(["makbuz bir JSON nesnesi değil"]);
    expect(offDeviceCleanupBlockers("makbuz")).toEqual(["makbuz bir JSON nesnesi değil"]);
  });

  it("boş nesne reddedilir ve TÜM eksikleri adıyla sayar", () => {
    const blockers = offDeviceCleanupBlockers({});
    expect(blockers.length).toBe(6); // receiptKind + 4 bayrak + targetKind
  });
});
