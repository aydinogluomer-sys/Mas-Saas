/**
 * `package.json` komutlarının refere ettiği HER dosya git'te izleniyor mu?
 *
 * ═══ BU TESTİ DOĞURAN GERÇEK KAZA ═══
 *
 * Commit 529acc7 `package.json`'ı commit etti ve `dev`/`start` komutlarına yeni bir ilk halka
 * bağladı:
 *
 *     "start": "tsx scripts/ops/runtime-port-guard.ts --start && … && next start"
 *
 * Ama `scripts/ops/runtime-port-guard.ts` o sırada izlenmiyordu (`git status` → `??`). Yerel
 * çalışma ağacında dosya durduğu için HER ŞEY ÇALIŞIYOR GÖRÜNDÜ: `pnpm start` açıldı, sunucu
 * kalktı, testler koştu. Kırık olan tek şey, kimsenin o an bakmadığı şeydi — TEMİZ CHECKOUT.
 *
 * Bu kusurun sinsiliği şu: hiçbir lint, typecheck, unit test ya da build onu göremez. Dördü de
 * çalışma ağacına bakar, git'in ne bildiğine değil. Ancak repoyu ilk kez klonlayan biri —
 * ya da CI — `&&` zincirinin ilk halkasında patlar ve uygulama hiç açılmaz.
 *
 * ═══ NEDEN GENEL BİR KURAL, TEK DOSYALIK BİR KONTROL DEĞİL ═══
 *
 * `runtime-port-guard.ts`'i adıyla kontrol etmek yalnız o dosyayı korurdu. Buradaki kural
 * komutları TARAR: `package.json`'da geçen her `scripts/…` ve `supabase/…` yolu izlenmek
 * zorundadır. Yani yarın eklenecek bir script de aynı kapıya takılır — koruma isme değil,
 * DESENE bağlıdır.
 *
 * Test `git ls-files`'a bakar, diske DEĞİL. Fark tam olarak yakalanmak istenen şeydir: dosyanın
 * diskte olması yeterli değildir, repoda OLMASI gerekir.
 */

import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { SUBPROCESS_TEST_TIMEOUT_MS } from "./setup/test-timeouts";

/** package.json komut metinlerinde geçen repo-içi script yolları. */
const SCRIPT_PATH_PATTERN = /(?:scripts|supabase)\/[A-Za-z0-9_.\/-]+\.(?:ts|tsx|sh|sql|mjs|cjs|js|cmd)/g;

/**
 * Her çağrı gerçek bir `git` süreci açar; iki test de ikişer kez çağırır. Bu yüzden ikisi de
 * SUBPROCESS_TEST_TIMEOUT_MS'i üçüncü argüman olarak alır (gerekçe: tests/setup/test-timeouts.ts).
 */
function git(args: string[]): string {
  return execFileSync("git", args, { cwd: process.cwd(), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

describe("package.json script referansları", () => {
  it("HEAD'deki her komut yalnız İZLENEN dosyalara referans verir (temiz checkout garantisi)", () => {
    const pkg = JSON.parse(git(["show", "HEAD:package.json"])) as { scripts: Record<string, string> };
    const tracked = new Set(git(["ls-files"]).split(/\r?\n/).filter(Boolean));

    const missing: string[] = [];
    for (const [name, command] of Object.entries(pkg.scripts)) {
      for (const match of String(command).matchAll(SCRIPT_PATH_PATTERN)) {
        const referenced = match[0];
        if (!tracked.has(referenced)) missing.push(`${name} → ${referenced}`);
      }
    }

    expect(
      missing,
      "package.json bir script'e bağlanmış ama dosya git'te yok. Temiz checkout'ta `pnpm <script>` " +
        "zincirin ilk halkasında patlar. Dosyayı commit edin ya da wiring'i geri alın.",
    ).toEqual([]);
  }, SUBPROCESS_TEST_TIMEOUT_MS);

  it("taranan desen gerçekten bir şey buluyor (test kendi kendini kandırmıyor)", () => {
    // Boş bir eşleşme kümesi yukarıdaki iddiayı BOŞ YERE yeşil yapardı. Bu yüzden desenin
    // gerçekten yol yakaladığı ayrıca doğrulanır — "hiç referans bulamadım, demek ki hepsi
    // sağlam" sessiz yanılsamasına karşı.
    const pkg = JSON.parse(git(["show", "HEAD:package.json"])) as { scripts: Record<string, string> };
    const found = Object.values(pkg.scripts).flatMap((c) => [...String(c).matchAll(SCRIPT_PATH_PATTERN)].map((m) => m[0]));
    expect(found.length, "package.json'da hiç script yolu bulunamadı — desen bozulmuş olabilir").toBeGreaterThan(20);
  }, SUBPROCESS_TEST_TIMEOUT_MS);
});
