// Standart Import V2 — ZIP zaman damgası kanonikleştirme (plan §3.7, byte-determinizm).
//
// NEDEN VAR. XLSX bir ZIP arşividir. ExcelJS arşivi JSZip ile paketler ve JSZip her girdinin
// başlığına (local file header + central directory) üretim ANININ DOS tarih/saatini yazar.
// Belge içeriği (XML'ler) tamamen deterministik olduğu hâlde bu 4 baytlık alanlar yüzünden
// iki ardışık üretim farklı SHA256 veriyordu (kanıt: docs/release-evidence/standard-import-v2/
// 02-template-generation.json → determinism.byteEvidence). Release-asset hash'i sabit olmalı;
// aksi hâlde "hangi şablon dağıtıldı" sorusu içerik karşılaştırmasına düşer.
//
// NE YAPAR. Arşivi EOCD → central directory → local header zinciriyle DOĞRU yerinden yürür
// (imza taraması değil: sıkıştırılmış veri içinde imza taklidi olasılığı sıfırlanır) ve her
// girdinin mtime/mdate alanlarını sabit bir değere yazar. Uzunluklar, CRC'ler, sıkıştırılmış
// içerik DEĞİŞMEZ; yalnız zaman damgası alanları üzerine yazılır. Ek bağımlılık yok.
//
// SINIR. ZIP64 (>4 GiB, >65535 girdi) desteklenmez — şablon 100 KB mertebesinde; ZIP64
// görülürse sessizce geçmek yerine hata atılır. Extra field'lardaki genişletilmiş zaman
// damgaları (0x5455/0x000a) JSZip tarafından yazılmaz; görülürse yine hata atılır ki
// "deterministik" iddiası yanlış pozitif olmasın.

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const EOCD_MIN = 22;
const CENTRAL_MIN = 46;
const LOCAL_MIN = 30;
const EXTRA_UNIX_TIME = 0x5455;
const EXTRA_NTFS_TIME = 0x000a;

/** MS-DOS tarih/saat çifti (2×16 bit). ZIP formatının yerel biçimi budur. */
export interface DosDateTime {
  readonly date: number;
  readonly time: number;
}

/** UTC bileşenlerinden DOS tarih/saat üretir. Saniye çözünürlüğü 2 sn'dir (format kısıtı). */
export function toDosDateTime(d: Date): DosDateTime {
  const year = d.getUTCFullYear();
  if (year < 1980 || year > 2107) {
    throw new Error(`DOS tarih aralığı dışında: ${d.toISOString()} (1980–2107)`);
  }
  const date = ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1);
  return { date, time };
}

/** Şablon için sabit damga: 2026-01-01T00:00:00Z — generator'daki wb.created ile aynı an. */
export const TEMPLATE_ZIP_TIMESTAMP: DosDateTime = toDosDateTime(new Date(Date.UTC(2026, 0, 1)));

function findEocd(buf: Buffer): number {
  // EOCD arşivin sonundadır; yorum alanı (≤65535 bayt) olabilir → geriye doğru tara.
  const floor = Math.max(0, buf.length - EOCD_MIN - 0xffff);
  for (let i = buf.length - EOCD_MIN; i >= floor; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  throw new Error("ZIP EOCD kaydı bulunamadı — geçerli bir arşiv değil");
}

function assertNoTimestampExtra(buf: Buffer, start: number, len: number, where: string): void {
  let p = start;
  const end = start + len;
  while (p + 4 <= end) {
    const id = buf.readUInt16LE(p);
    const size = buf.readUInt16LE(p + 2);
    if (id === EXTRA_UNIX_TIME || id === EXTRA_NTFS_TIME) {
      throw new Error(`${where}: genişletilmiş zaman damgası extra field'ı (0x${id.toString(16)}) var; kanonikleştirme kapsam dışı`);
    }
    p += 4 + size;
  }
}

export interface CanonicalizeResult {
  readonly buffer: Buffer;
  readonly entries: number;
}

/**
 * Arşivdeki HER girdinin (local header + central directory) mtime/mdate alanını `stamp`
 * ile değiştirir. Girdi buffer'ı değiştirilmez; kopya döner.
 */
export function canonicalizeZipTimestamps(
  input: Buffer,
  stamp: DosDateTime = TEMPLATE_ZIP_TIMESTAMP,
): CanonicalizeResult {
  const buf = Buffer.from(input);
  const eocd = findEocd(buf);
  if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === SIG_ZIP64_LOCATOR) {
    throw new Error("ZIP64 arşivi desteklenmiyor");
  }
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new Error("ZIP64 alanları işaretli; desteklenmiyor");
  }

  let p = cdOffset;
  for (let i = 0; i < total; i++) {
    if (p + CENTRAL_MIN > buf.length || buf.readUInt32LE(p) !== SIG_CENTRAL) {
      throw new Error(`central directory girdisi #${i} bozuk (offset ${p})`);
    }
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + CENTRAL_MIN, p + CENTRAL_MIN + nameLen);
    assertNoTimestampExtra(buf, p + CENTRAL_MIN + nameLen, extraLen, `central[${name}]`);

    // central directory: time @12, date @14
    buf.writeUInt16LE(stamp.time, p + 12);
    buf.writeUInt16LE(stamp.date, p + 14);

    if (localOffset + LOCAL_MIN > buf.length || buf.readUInt32LE(localOffset) !== SIG_LOCAL) {
      throw new Error(`local header bozuk: ${name} (offset ${localOffset})`);
    }
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    assertNoTimestampExtra(buf, localOffset + LOCAL_MIN + lNameLen, lExtraLen, `local[${name}]`);
    // local header: time @10, date @12
    buf.writeUInt16LE(stamp.time, localOffset + 10);
    buf.writeUInt16LE(stamp.date, localOffset + 12);

    p += CENTRAL_MIN + nameLen + extraLen + commentLen;
  }
  if (p !== cdOffset + cdSize) {
    throw new Error(`central directory boyutu tutmuyor: yürünen ${p - cdOffset}, beyan ${cdSize}`);
  }
  return { buffer: buf, entries: total };
}

/** Tanı/doğrulama: her girdinin central-directory zaman damgasını listeler. */
export function listZipTimestamps(input: Buffer): ReadonlyArray<{ name: string } & DosDateTime> {
  const eocd = findEocd(input);
  const total = input.readUInt16LE(eocd + 10);
  let p = input.readUInt32LE(eocd + 16);
  const out: Array<{ name: string } & DosDateTime> = [];
  for (let i = 0; i < total; i++) {
    const nameLen = input.readUInt16LE(p + 28);
    const extraLen = input.readUInt16LE(p + 30);
    const commentLen = input.readUInt16LE(p + 32);
    out.push({
      name: input.toString("utf8", p + CENTRAL_MIN, p + CENTRAL_MIN + nameLen),
      time: input.readUInt16LE(p + 12),
      date: input.readUInt16LE(p + 14),
    });
    p += CENTRAL_MIN + nameLen + extraLen + commentLen;
  }
  return out;
}
