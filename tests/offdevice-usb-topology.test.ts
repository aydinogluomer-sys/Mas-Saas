// USB fiziksel disk sınıflandırması — karar matrisi.
//
// NEDEN VAR. Bu makinede bağlı olan gerçek harici SSD (`D:`, 240 GB, USB) Windows'ta
// `Win32_LogicalDisk DriveType=3` döndürüyor: mantıksal olarak "sabit disk". Yalnız tipe bakan
// eski kapı onu `FIXED_SEPARATE_VOLUME` sayıp reddediyordu — doğru sebep, yanlış ölçü.
//
// Yeni karar fiziksel disk kimliğine dayanıyor ve tek bir gevşeme içermiyor: aşağıdaki her FAIL
// vakası, "farklı harf/bölüm gördüm, ayrı aygıt olmalı" kestirmesinin tam olarak nerede
// yanlış olduğunu tutuyor. Aynı fiziksel diskin ikinci bölümü, disk arızalandığında birinci
// bölümle birlikte gider; bir yedeğin var olduğunu iddia eden kapı bunu ayırt etmek zorundadır.
import { describe, expect, it } from "vitest";
import {
  decideUsbPhysicalVolume, parsePhysicalDiskJson, USB_BUS_TYPE,
  type PhysicalDiskIdentity, type TopologyMeasurements,
} from "../scripts/ops/offdevice-topology";
import { CLEANUP_GRADE_TARGET_KINDS } from "../scripts/ops/backup-lib";

/** Bu makinede GERÇEKTEN ölçülen kaynak disk (C:). */
const SOURCE_DISK: PhysicalDiskIdentity = {
  diskNumber: 0, busType: "RAID", isBoot: true, isSystem: true,
  operationalStatus: "Online", friendlyName: "NVMe WDC PC SN520 SDA",
};

/** Bu makinede GERÇEKTEN ölçülen hedef disk (D:, USB ile bağlı harici SSD). */
const USB_DISK: PhysicalDiskIdentity = {
  diskNumber: 1, busType: "USB", isBoot: false, isSystem: false,
  operationalStatus: "Online", friendlyName: "Min Yi U YZWY_TECH",
};

function m(over: Partial<TopologyMeasurements> = {}): TopologyMeasurements {
  return {
    driveType: 3,
    targetRoot: "d:\\",
    sourceRoot: "c:\\",
    sameVolumeAsSource: false,
    targetDisk: USB_DISK,
    sourceDisk: SOURCE_DISK,
    ...over,
  };
}

const disk = (over: Partial<PhysicalDiskIdentity>): PhysicalDiskIdentity => ({ ...USB_DISK, ...over });

describe("PASS — ölçümle kanıtlanan ayrı USB aygıtı", () => {
  it("DriveType=3 + BusType=USB + farklı disk + boot/system false → cleanup-grade", () => {
    const d = decideUsbPhysicalVolume(m());
    expect(d.cleanupGrade).toBe(true);
    expect(d.blockers).toEqual([]);
  });

  it("kanıt string'i fiziksel ölçümü AÇIKÇA taşıyor", () => {
    const { evidence } = decideUsbPhysicalVolume(m());
    expect(evidence).toContain("DriveType=3");
    expect(evidence).toContain("BusType=USB");
    expect(evidence).toContain("targetDisk=1");
    expect(evidence).toContain("sourceDisk=0");
    expect(evidence).toContain("IsBoot=false");
    expect(evidence).toContain("IsSystem=false");
  });

  it("BusType karşılaştırması büyük/küçük harfe takılmıyor", () => {
    expect(decideUsbPhysicalVolume(m({ targetDisk: disk({ busType: "usb" }) })).cleanupGrade).toBe(true);
    expect(decideUsbPhysicalVolume(m({ targetDisk: disk({ busType: " USB " }) })).cleanupGrade).toBe(true);
  });
});

describe("FAIL — fiziksel ayrılık kanıtlanamayan her durum", () => {
  const vakalar: Array<[string, Partial<TopologyMeasurements>, string]> = [
    ["SATA sabit disk", { targetDisk: disk({ busType: "SATA" }) }, "BusType"],
    ["NVMe sabit disk", { targetDisk: disk({ busType: "NVMe" }) }, "BusType"],
    ["RAID (bu makinenin kendi diski)", { targetDisk: disk({ busType: "RAID" }) }, "BusType"],
    ["USB ama AYNI fiziksel disk", { targetDisk: disk({ diskNumber: 0 }) }, "AYNI fiziksel diskte"],
    ["USB ama IsBoot=true", { targetDisk: disk({ isBoot: true }) }, "BOOT diski"],
    ["USB ama IsSystem=true", { targetDisk: disk({ isSystem: true }) }, "SYSTEM diski"],
    ["disk çevrimdışı", { targetDisk: disk({ operationalStatus: "Offline" }) }, "çevrimiçi değil"],
    ["hedef topolojisi ölçülemedi", { targetDisk: null }, "hedefin fiziksel disk topolojisi ÖLÇÜLEMEDİ"],
    ["kaynak topolojisi ölçülemedi", { sourceDisk: null }, "kaynağın fiziksel disk topolojisi ÖLÇÜLEMEDİ"],
    ["aynı volume (LOCAL_STANDIN yolu)", { sameVolumeAsSource: true, targetRoot: "c:\\" }, "aynı volume"],
    ["DriveType=3 değil", { driveType: 2 }, "yalnız DriveType=3"],
    ["DriveType ölçülemedi", { driveType: null }, "yalnız DriveType=3"],
  ];

  for (const [ad, over, iz] of vakalar) {
    it(`${ad} → REDDEDİLİR`, () => {
      const d = decideUsbPhysicalVolume(m(over));
      expect(d.cleanupGrade).toBe(false);
      expect(d.blockers.join(" | ")).toContain(iz);
    });
  }

  it("farklı BÖLÜM ama aynı fiziksel disk — tek başına farklı harf yetmiyor", () => {
    // Kritik vaka: `E:` ayrı bir harf, ayrı bir volume, ama disk 0'ın ikinci bölümü.
    // Disk arızalanınca yedek de kaynakla birlikte gider.
    const d = decideUsbPhysicalVolume(m({
      targetRoot: "e:\\",
      sameVolumeAsSource: false,
      targetDisk: disk({ diskNumber: 0, busType: "USB", isBoot: false, isSystem: false }),
    }));
    expect(d.cleanupGrade).toBe(false);
    expect(d.blockers.join(" ")).toContain("disk 0");
  });

  it("ölçüm hiç yapılamadıysa karar açık kalmıyor — fail-closed", () => {
    const d = decideUsbPhysicalVolume(m({ driveType: null, targetDisk: null, sourceDisk: null }));
    expect(d.cleanupGrade).toBe(false);
    expect(d.blockers.length).toBeGreaterThanOrEqual(3);
  });
});

describe("parsePhysicalDiskJson — ayrıştıramadığını REDDEDER", () => {
  const gecerli = JSON.stringify({
    Number: 1, BusType: "USB", IsBoot: false, IsSystem: false,
    OperationalStatus: "Online", FriendlyName: "Min Yi U YZWY_TECH",
  });

  it("gerçek Get-Disk çıktısı ayrıştırılıyor", () => {
    expect(parsePhysicalDiskJson(gecerli)).toEqual(USB_DISK);
  });

  it("tek elemanlı dizi de kabul ediliyor (PowerShell iki biçimde de yazabilir)", () => {
    expect(parsePhysicalDiskJson(`[${gecerli}]`)?.diskNumber).toBe(1);
  });

  it("birden çok diske yayılan volume REDDEDİLİR — hangisi olduğu belirsiz", () => {
    expect(parsePhysicalDiskJson(`[${gecerli},${gecerli}]`)).toBeNull();
  });

  it.each([
    ["boş çıktı", ""],
    ["yalnız boşluk", "   \n "],
    ["JSON değil", "Get-Disk : Cannot find drive"],
    ["boş dizi", "[]"],
    ["null", "null"],
    ["disk numarası yok", '{"BusType":"USB","IsBoot":false,"IsSystem":false,"OperationalStatus":"Online"}'],
    ["disk numarası metin", '{"Number":"1","BusType":"USB","IsBoot":false,"IsSystem":false,"OperationalStatus":"Online"}'],
    ["BusType boş", '{"Number":1,"BusType":"","IsBoot":false,"IsSystem":false,"OperationalStatus":"Online"}'],
    ["IsBoot eksik", '{"Number":1,"BusType":"USB","IsSystem":false,"OperationalStatus":"Online"}'],
    ["IsBoot null", '{"Number":1,"BusType":"USB","IsBoot":null,"IsSystem":false,"OperationalStatus":"Online"}'],
    ["IsSystem eksik", '{"Number":1,"BusType":"USB","IsBoot":false,"OperationalStatus":"Online"}'],
    ["OperationalStatus eksik", '{"Number":1,"BusType":"USB","IsBoot":false,"IsSystem":false}'],
  ])("%s → null", (_ad, raw) => {
    expect(parsePhysicalDiskJson(raw)).toBeNull();
  });

  it("eksik bayrak 'false' sayılmıyor — ölçülmemiş, olumlu ölçüm değildir", () => {
    const eksik = parsePhysicalDiskJson('{"Number":1,"BusType":"USB","IsSystem":false,"OperationalStatus":"Online"}');
    expect(eksik).toBeNull();
    // Ve null topoloji kararı da düşürüyor:
    expect(decideUsbPhysicalVolume(m({ targetDisk: eksik })).cleanupGrade).toBe(false);
  });
});

describe("izinli sınıf kümesi — sözleşme", () => {
  it("USB_PHYSICAL_VOLUME yıkıcı işlem açabilir, FIXED_SEPARATE_VOLUME açamaz", () => {
    expect([...CLEANUP_GRADE_TARGET_KINDS].sort()).toEqual([
      "NETWORK_DRIVE", "REMOVABLE_VOLUME", "UNC_NETWORK_SHARE", "USB_PHYSICAL_VOLUME",
    ]);
    expect(CLEANUP_GRADE_TARGET_KINDS.has("FIXED_SEPARATE_VOLUME")).toBe(false);
    expect(CLEANUP_GRADE_TARGET_KINDS.has("LOCAL_STANDIN")).toBe(false);
    expect(CLEANUP_GRADE_TARGET_KINDS.has("OPERATOR_ATTESTED")).toBe(false);
    expect(CLEANUP_GRADE_TARGET_KINDS.has("UNKNOWN")).toBe(false);
  });

  it("kabul edilen tek veri yolu USB", () => {
    expect(USB_BUS_TYPE).toBe("USB");
  });
});
