// Windows depolama topolojisi — "ayrı fiziksel aygıt" kararının SAF yarısı.
//
// NEDEN AYRI DOSYA. `classifyOffDeviceTarget()` ölçüm yapar (PowerShell çağırır); buradaki
// karar saf bir yüklemdir. İkisi tek fonksiyonda olduğunda matrisi sınamanın tek yolu
// subprocess olurdu — v2.3.1'de ölçülmüştü: 15 µs'lik mantığı denemek 11–22 saniye sürüyordu.
// Ölçüm ile karar ayrılınca on iki vakalık matris aynı process'te, mikrosaniyelerle koşar.
//
// NEDEN DriveType TEK BAŞINA YETMİYOR. Windows, USB ile bağlı bir SSD/HDD'yi
// `Win32_LogicalDisk`'te DriveType=3 (sabit disk) gösterir; DriveType=2 yalnız
// "çıkarılabilir ORTAM" içindir (flash bellek, kart okuyucu). Yani gerçek bir harici SSD,
// yalnız sürücü tipine bakan bir kapı tarafından "makinenin kendi diski" sanılır. Bu makinede
// ölçülen tam olarak budur: `D:` → DriveType=3, ama fiziksel disk 1, BusType USB.
//
// Ayrımı yapabilen tek şey FİZİKSEL DİSK KİMLİĞİDİR: hangi disk numarası, hangi veri yolu,
// boot/system diski mi. Farklı sürücü harfi ASLA yetmez — aynı fiziksel diskin ikinci bölümü
// de farklı harf alır, ve disk kaybedildiğinde iki bölüm birlikte gider.
//
// FAIL-CLOSED. Ölçülemeyen her şey RED sebebidir; burada "bilinmiyor" ile "güvenli" aynı
// anlama gelmez.

/** `Get-Partition -DriveLetter X | Get-Disk` çıktısının karar için gereken alanları. */
export interface PhysicalDiskIdentity {
  diskNumber: number;
  /** `USB`, `RAID`, `SATA`, `NVMe`, … — Get-Disk'in bildirdiği veri yolu. */
  busType: string;
  isBoot: boolean;
  isSystem: boolean;
  operationalStatus: string;
  friendlyName: string | null;
}

export interface UsbVolumeDecision {
  cleanupGrade: boolean;
  /** Boş dizi = engel yok. Her madde tek başına yeterli bir RED sebebidir. */
  blockers: string[];
  /** Kararın dayandığı ölçümü AÇIKÇA taşır — sonuç değil, veri. */
  evidence: string;
}

/** Cleanup-grade sayılabilen tek veri yolu. Karşılaştırma büyük/küçük harf duyarsız. */
export const USB_BUS_TYPE = "USB";

/** Disk çevrimiçi değilse ölçüm anlık doğru olsa bile hedef yazılabilir değildir. */
const ONLINE_STATUS = "online";

export interface TopologyMeasurements {
  driveType: number | null;
  targetRoot: string;
  sourceRoot: string;
  sameVolumeAsSource: boolean;
  targetDisk: PhysicalDiskIdentity | null;
  sourceDisk: PhysicalDiskIdentity | null;
}

function fmt(d: PhysicalDiskIdentity | null): string {
  return d === null ? "ÖLÇÜLEMEDİ" : `${d.diskNumber}`;
}

/**
 * DriveType=3 görünen bir hedefin GERÇEKTEN ayrı bir USB aygıtı olup olmadığına karar verir.
 *
 * Yedi koşulun TAMAMI sağlanmadıkça `cleanupGrade` false döner. Koşullar birbirinin yerine
 * geçmez: USB olması diskin ayrı olduğunu, ayrı olması boot diski olmadığını kanıtlamaz.
 */
export function decideUsbPhysicalVolume(m: TopologyMeasurements): UsbVolumeDecision {
  const blockers: string[] = [];
  const { targetDisk: t, sourceDisk: s } = m;

  if (m.driveType !== 3) {
    blockers.push(`bu karar yalnız DriveType=3 için geçerli; ölçülen ${m.driveType ?? "ölçülemedi"}`);
  }
  if (t === null) blockers.push("hedefin fiziksel disk topolojisi ÖLÇÜLEMEDİ");
  if (s === null) blockers.push("kaynağın fiziksel disk topolojisi ÖLÇÜLEMEDİ");

  if (t !== null) {
    if (t.busType.trim().toUpperCase() !== USB_BUS_TYPE) {
      blockers.push(`hedef BusType='${t.busType}' — yalnız USB kabul edilir`);
    }
    if (t.isBoot) blockers.push("hedef BOOT diski (IsBoot=true) — makinenin kendi diski");
    if (t.isSystem) blockers.push("hedef SYSTEM diski (IsSystem=true) — makinenin kendi diski");
    if (t.operationalStatus.trim().toLowerCase() !== ONLINE_STATUS) {
      blockers.push(`hedef disk çevrimiçi değil (OperationalStatus='${t.operationalStatus}')`);
    }
  }

  // Asıl soru bu: iki yol AYNI fiziksel diskte mi? Farklı harf/bölüm bunu yanıtlamaz.
  if (t !== null && s !== null && t.diskNumber === s.diskNumber) {
    blockers.push(
      `hedef ve kaynak AYNI fiziksel diskte (disk ${t.diskNumber}) — ayrı bölüm ayrı AYGIT değildir`,
    );
  }
  if (m.sameVolumeAsSource) {
    blockers.push(`hedef kaynakla aynı volume üzerinde (${m.targetRoot})`);
  }

  const evidence =
    `DriveType=${m.driveType ?? "ölçülemedi"}, BusType=${t?.busType ?? "ÖLÇÜLEMEDİ"}, ` +
    `targetDisk=${fmt(t)}, sourceDisk=${fmt(s)}, ` +
    `IsBoot=${t === null ? "ÖLÇÜLEMEDİ" : t.isBoot}, IsSystem=${t === null ? "ÖLÇÜLEMEDİ" : t.isSystem}, ` +
    `Status=${t?.operationalStatus ?? "ÖLÇÜLEMEDİ"}, kök ${m.targetRoot} ≠ ${m.sourceRoot}` +
    (t?.friendlyName ? ` — '${t.friendlyName}'` : "");

  return { cleanupGrade: blockers.length === 0, blockers, evidence };
}

/**
 * `Get-Disk | ConvertTo-Json` çıktısını ayrıştırır. Ayrıştıramadığı her şey için `null` döner
 * — çağıran taraf bunu RED olarak yorumlar.
 *
 * TEK DİSK ŞARTI. PowerShell tek nesneyi nesne, birden çoğunu dizi olarak yazar. Bir volume
 * birden fazla fiziksel diske yayılmışsa (span/mirror) parçalarından biri kaynak diskte
 * olabilir; "hangisine bakalım" sorusunun güvenli cevabı yoktur, o yüzden reddedilir.
 */
export function parsePhysicalDiskJson(raw: string): PhysicalDiskIdentity | null {
  const text = raw.trim();
  if (text === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (Array.isArray(parsed)) {
    if (parsed.length !== 1) return null;
    parsed = parsed[0];
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;

  const diskNumber = o.Number;
  const busType = o.BusType;
  const isBoot = o.IsBoot;
  const isSystem = o.IsSystem;
  const status = o.OperationalStatus;

  if (typeof diskNumber !== "number" || !Number.isInteger(diskNumber) || diskNumber < 0) return null;
  if (typeof busType !== "string" || busType.trim() === "") return null;
  // undefined/null bir bayrak "false" sayılamaz: eksik ölçüm, olumlu ölçüm değildir.
  if (typeof isBoot !== "boolean" || typeof isSystem !== "boolean") return null;
  if (typeof status !== "string" || status.trim() === "") return null;

  return {
    diskNumber,
    busType,
    isBoot,
    isSystem,
    operationalStatus: status,
    friendlyName: typeof o.FriendlyName === "string" ? o.FriendlyName : null,
  };
}
