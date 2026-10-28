/**
 * `scripts/ops/runtime-port-guard.ts` — "aynı anda tek Next sunucusu" kuralının bekçisi.
 *
 * ═══ BU TEST NİÇİN VAR ═══
 *
 * Script `package.json`'ın `dev` ve `start` komutlarının İLK halkasıdır:
 *
 *     "start": "tsx scripts/ops/runtime-port-guard.ts --start && … && next start"
 *
 * Yani buradaki bir hata, uygulamanın hiç açılmaması demektir. `&&` zinciri sıfırdan farklı çıkış
 * kodunda durur; dolayısıyla test edilmesi gereken şey metin değil ÇIKIŞ KODUDUR.
 *
 * ═══ NEDEN ENTEGRASYON TESTİ (saf birim değil) ═══
 *
 * Script'in tek işi TCP dinleyicisi var mı diye bakmak. O davranışı mock'lamak, mock'u test etmek
 * olurdu; gerçek soru "gerçekten dinleyen bir port'u görüyor mu"dur. Bu yüzden test gerçek bir
 * `net.Server` açar, script'i gerçek bir süreç olarak çalıştırır ve çıkış kodunu okur. Süre
 * maliyeti birkaç yüz milisaniye; karşılığında ölçülen şey gerçek davranış.
 *
 * ═══ NEDEN 3000/3001 İÇİN "BOŞ" DURUMU TEST EDİLMİYOR ═══
 *
 * Script `[3000, 3001, PORT]` portlarını tarar. "Hiçbiri dinlenmiyorsa 0 döner" iddiası, testin
 * koştuğu makinede 3000 ve 3001'in boş olmasına bağlıdır — geliştiricinin kendi dev sunucusu
 * açıkken bu test HAKSIZ YERE kırmızı verirdi ve doğru tepki onu gevşetmek değil, hiç yazmamaktır.
 * Deterministik olarak doğrulanabilen iki sözleşme test ediliyor:
 *
 *   1. Açık bypass (`MAS_ALLOW_PARALLEL_RUNTIME=1`) her koşulda 0 döndürür.
 *   2. İstenen port GERÇEKTEN dinleniyorsa sıfırdan farklı kod + gerekçeli mesaj döner.
 *
 * İkinci madde, script'in var oluş sebebinin ta kendisidir: denetim sırasında `.next` dizinini
 * paylaşan ikinci bir Next süreci `pages-manifest.json`'ı derleme ortasında yeniden yazıp
 * `ENOENT` ürettiği ölçüldü. Bu kapı o kazayı önler.
 */

import { createServer, type Server } from "node:net";
import { execFile } from "node:child_process";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SUBPROCESS_TEST_TIMEOUT_MS } from "./setup/test-timeouts";

const SCRIPT = path.join(process.cwd(), "scripts", "ops", "runtime-port-guard.ts");

/**
 * Çocuk süreç, testin sınırından (SUBPROCESS_TEST_TIMEOUT_MS) 10 sn ÖNCE öldürülür: yavaş bir
 * açılış vitest'in çıplak "timed out"u yerine bu dosyanın kendi iddiasıyla (stderr dahil) düşer ve
 * süreç testten uzun yaşamaz. Bu değer eskiden 30 sn'ydi ve hiçbir sonucu belirlemezdi: vitest'in
 * sınırı (önce 5, katmanda 20 sn) hep önce doluyordu. Artık sonucu belirleyebildiği için `runGuard`
 * öldürülen çocuğu "0 ile çıktı" diye OKUMAZ.
 */
const CHILD_KILL_MS = SUBPROCESS_TEST_TIMEOUT_MS - 10_000;

interface RunResult {
  code: number;
  stderr: string;
}

/**
 * Script'i gerçek bir süreç olarak çalıştır ve çıkış kodunu oku.
 *
 * `overrides` tipi `NodeJS.ProcessEnv` DEĞİL, düz `Record<string, string>`: bu projenin
 * `ProcessEnv` bildirimi `NODE_ENV`'i ZORUNLU kılıyor, dolayısıyla `{ PORT: "…" }` gibi kısmi bir
 * nesne o tipe atanamıyor. Kısmi override doğru olan şey — tam ortam aşağıda yayılarak kuruluyor.
 */
function runGuard(overrides: Record<string, string>): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--import", "tsx", SCRIPT, "--start"],
      {
        cwd: process.cwd(),
        // Ebeveyn ortamı KOPYALANIR ama bypass bayrağı bilerek temizlenir: kabuğunda o değişken
        // duran biri, testin ölçmek istediği dalı sessizce atlatabilirdi.
        env: { ...process.env, MAS_ALLOW_PARALLEL_RUNTIME: "", ...overrides },
        timeout: CHILD_KILL_MS,
      },
      (error, _stdout, stderr) => {
        // Yalnız GERÇEK bir çıkış kodu sayılır. `timeout`la öldürülen çocukta `code` null'dır (sinyal
        // `signal`'da), hiç başlatılamayan çocukta bir dizedir ('ENOENT'). İkisini de 0 okumak, takılmış
        // ya da hiç koşmamış bir bekçiyi geçen bir bypass vakasına çevirirdi.
        const exit = error ? (error as { code?: unknown }).code : 0;
        const code = typeof exit === "number" ? exit : -1;
        resolve({ code, stderr: String(stderr ?? "") });
      },
    );
  });
}

/** Rastgele boş bir port'ta gerçek bir dinleyici aç ve port numarasını döndür. */
function listenOnEphemeralPort(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("ephemeral port alınamadı"));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
}

let opened: Server | null = null;

afterEach(async () => {
  if (opened) {
    await new Promise<void>((resolve) => opened!.close(() => resolve()));
    opened = null;
  }
});

describe("runtime-port-guard", () => {
  it("açık bypass ile her zaman 0 döner — bilinçli paralel çalıştırma engellenmez", async () => {
    // Bypass'ın çalışması ŞART: etkileşim kapısı ikinci bir sunucuyu bilerek ayağa kaldırır
    // (ayrı port, ayrı harcanabilir veritabanı) ve bu meşru bir kullanımdır.
    const listener = await listenOnEphemeralPort();
    opened = listener.server;

    const result = await runGuard({ PORT: String(listener.port), MAS_ALLOW_PARALLEL_RUNTIME: "1" });

    expect(result.code, `bypass açıkken çıkış kodu 0 olmalı, stderr: ${result.stderr}`).toBe(0);
  }, SUBPROCESS_TEST_TIMEOUT_MS);

  it("istenen port dinleniyorsa sıfırdan farklı kod döner ve gerekçeyi SÖYLER", async () => {
    const listener = await listenOnEphemeralPort();
    opened = listener.server;

    const result = await runGuard({ PORT: String(listener.port) });

    // Çıkış kodu asıl sözleşme: `&&` zinciri yalnız buna bakar.
    expect(result.code, "meşgul port'ta sıfırdan farklı çıkış kodu bekleniyor").not.toBe(0);
    // Sessiz başarısızlık yok: kullanıcı NEYİN engellediğini ve NASIL geçeceğini okumalı.
    expect(result.stderr).toContain(String(listener.port));
    expect(result.stderr).toContain("MAS_ALLOW_PARALLEL_RUNTIME");
  }, SUBPROCESS_TEST_TIMEOUT_MS);
});
