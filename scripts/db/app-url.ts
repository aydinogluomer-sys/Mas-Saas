// Harcanabilir bir hedefe karşı GERÇEK runtime kimliğiyle bağlanmak için ortak yardımcılar.
//
// NEDEN ORTAK BİR DOSYA. `scripts/db/owner-url.ts` başlığında yazılı olan kaza aynen burada da
// yaşandı: aynı üç fonksiyonun kopyaları farklı gate script'lerine dağılıp birbirinden kaydı.
// `release:real-clone-gate` ve `perf:route-slo` ikisi de "canlı `.env.local` kimliğini al,
// YALNIZ veritabanı adını değiştir, hiçbir dizeyi yazdırma" desenine ihtiyaç duyuyor; o desen
// tek bir yerde yaşar.
//
// NEDEN `pnpm db:app-role:password` ÇAĞRILMAZ. O script `mas_radar_app` rolünün parolasını
// CLUSTER GENELİNDE değiştirir. Çağrılırsa port 3000'de çalışan canlı production örneğinin
// `.env.local` parolası anında geçersizleşir ve uygulama düşer. Doğru yol, mevcut kimliği
// olduğu gibi kullanıp yalnız hedef veritabanını değiştirmektir — hem güvenli hem de daha
// güçlü bir test, çünkü sentetik bir parolayla değil gerçek runtime rolüyle bağlanılır.
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";

/**
 * Bağlantı dizesinde YALNIZ veritabanı adını değiştirir.
 *
 * `new URL(...)` round-trip'i yerine hedefli bir regex: URL serileştirmesi yüzde-kaçışlı bir
 * parolayı yeniden kodlayabilir ve sonuç sessizce YANLIŞ bir kimlik olur. Hiçbir kolda dize
 * yazdırılmaz; hata mesajı bile yalnız "ayrıştırılamadı" der.
 */
export function swapDatabase(url: string, db: string): string {
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]+)\/([^?#]*)(.*)$/.exec(url);
  if (!m) throw new Error("Bağlantı dizesi ayrıştırılamadı (dize kasıtlı olarak yazdırılmıyor).");
  return `${m[1]}/${db}${m[3]}`;
}

/** `.env.local`'i process.env'e SIZDIRMADAN okur — dönen nesne yalnız çağıranda yaşar. */
export function readEnvLocal(): Record<string, string> {
  const file = path.join(process.cwd(), ".env.local");
  if (!existsSync(file)) {
    throw new Error(".env.local yok — hedefin app bağlantısı gerçek runtime kimliğinden türetilemiyor.");
  }
  const out: Record<string, string> = {};
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 0) continue;
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[line.slice(0, i).trim()] = v;
  }
  return out;
}

/** Bir portta zaten dinleyen var mı? Varsa gate yarışmaz, DURUR — kimsenin sürecini öldürmez. */
export function portInUse(port: string | number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port: Number(port) });
    const done = (v: boolean) => { socket.destroy(); resolve(v); };
    socket.setTimeout(1500);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}
