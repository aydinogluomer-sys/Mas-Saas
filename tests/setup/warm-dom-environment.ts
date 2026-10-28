// QA-F7 — jsdom ortamının ön-ısıtılması. Test güvenilirliği düzeltmesi, davranış değişikliği değil.
//
// ═══ SEMPTOM ═══
// `pnpm test` iki koşudan birinde kırmızıya düşüyordu:
//   [vitest-pool]: Failed to start forks worker for test files
//     .../src/components/imports/previews.test.tsx
//   Caused by: [vitest-pool-runner]: Timeout waiting for worker to respond
// Hata düştüğünde o dosyadaki 3 test HİÇ çalışmıyor; süit 1215 test / 52 dosya yerine
// 1212 / 51 raporluyor ve süreç sıfırdan farklı kodla çıkıyor.
//
// ═══ KÖK NEDEN — ölçüldü, tahmin edilmedi ═══
// 1) Süitteki TEK jsdom dosyası src/components/imports/previews.test.tsx'tir. Ortamı
//    dosyanın ilk satırındaki `// @vitest-environment jsdom` docblock'undan alır;
//    vitest.config.ts'in global varsayılanı "node"dur, yani jsdom yalnız o dosya için kurulur.
// 2) Vitest 4'te ortam kurulumu (setupBaseEnvironment → loadEnvironment("jsdom")) worker'ın
//    `start` mesajını işlerken, yani `"started"` yanıtı gönderilmeden ÖNCE koşar. Bu pencerenin
//    bütçesi vitest içinde SABİT KODLUDUR: START_TIMEOUT = 60_000 ms
//    (node_modules/vitest/dist/chunks/cli-api.*.js). Konfigürasyondan büyütülemez —
//    testTimeout / hookTimeout / teardownTimeout bu pencereye dokunmaz.
// 3) Bu makinede ölçülen değerler (Node 26, Windows 11, 8 çekirdek, 8,4 GB RAM):
//      soğuk dosya önbelleğinde `import("jsdom")` : 71.286 ms  (ikinci ölçüm: 72.922 ms)
//      ısınmış önbellekte      `import("jsdom")`  :  2.008 ms  (ikinci ölçüm:  2.114 ms)
//    Üç ölçüm de AYRI süreçlerde alındı; yani ısınma süreçler arasında taşınıyor — ısıtmayı
//    ana süreçte yapıp faydasını çatallanan worker'da görmemizin dayanağı budur.
//    jsdom paketi 655 dosya / 7,0 MB'dır. Soğuk halde TEK BAŞINA bile 60 sn'lik bütçeyi
//    aşıyor; üstelik forks havuzu 8 worker'ı aynı anda başlattığı için jsdom worker'ı diski
//    yedi kardeşiyle paylaşarak açılıyor. Değişkenlik buradan geliyor: sıcak koşuda ortam
//    kurulumu ~3,4 sn, soğuk koşuda 30 sn+ ve yük altında 60 sn'nin üstü.
//
// ═══ ÇÖZÜM ═══
// jsdom'u globalSetup aşamasında bir kez yüklüyoruz. Bu aşamanın iki özelliği kritik:
//   • süre sınırı YOKTUR (Vitest `await globalSetupFile.setup(...)` çağrısını sarmalamaz),
//   • havuz henüz hiçbir worker'ı çatallamamıştır, yani disk için rekabet yoktur.
// Soğuk maliyet böylece 60 sn'lik pencerenin DIŞINDA ödenir; worker daha sonra aynı 655
// dosyayı ısınmış işletim sistemi önbelleğinden okur (~2 sn) ve bütçenin çok içinde kalır.
//
// Isıtma KOŞULLUDUR: koşunun içinde gerçekten bir DOM test dosyası yoksa hiç yapılmaz.
// Aksi halde `vitest run tests/financial` gibi hedefli bir koşu, hiç kullanmayacağı bir
// ortam için soğuk önbellekte 70 sn ödeyecekti. Karar kuralı şüphede ISITMA yönünde
// çalışır: filtreyi çözemezsek ısıtırız — yavaş bir yeşil, rastgele bir kırmızıdan iyidir.
//
// Testin kendisine dokunulmadı: previews.test.tsx'teki 3 test aynen çalışır, hiçbir iddia
// gevşetilmedi, hiçbir dosya atlanmadı.

import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/** 5 sn üzeri bir ön-ısıtma "dosya önbelleği soğuktu" demektir; sessizce yutmayıp bildiriyoruz. */
const SLOW_WARMUP_MS = 5_000;

/** vitest.config.ts'teki `include` desenlerinin taradığı kökler. */
const SEARCH_ROOTS = ["src", "tests"] as const;

/** Dosya başındaki ortam docblock'u — previews.test.tsx bunu kullanıyor. */
const DOM_ENVIRONMENT_DIRECTIVE = /@vitest-environment\s+(jsdom|happy-dom)/;

/** Docblock dosyanın ilk satırlarındadır; tüm dosyayı okumaya gerek yok. */
const DIRECTIVE_SCAN_BYTES = 4_096;

const SUBCOMMANDS = new Set(["run", "watch", "dev", "related", "bench", "list", "init"]);

/** Vitest'in kendi filtre semantiği: dosya yolu filtre metnini İÇERİYORSA eşleşir. */
function matchesFilter(posixPath: string, filter: string): boolean {
  return posixPath.includes(filter.replaceAll("\\", "/"));
}

/**
 * Komut satırındaki konumsal filtreler. `-` ile başlayan seçenekler ve `=` ile birleşmemiş
 * bir seçeneğin hemen ardından gelen değer atlanır; alt komut adı da filtre değildir.
 */
function positionalFilters(argv: readonly string[]): string[] {
  const filters: string[] = [];
  let skipNext = false;
  for (const token of argv.slice(2)) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (token.startsWith("-")) {
      skipNext = !token.includes("=");
      continue;
    }
    if (filters.length === 0 && SUBCOMMANDS.has(token)) continue;
    filters.push(token);
  }
  return filters;
}

/** `src/**` ve `tests/**` altında DOM ortamı isteyen test dosyalarını bulur (posix yollar). */
function findDomTestFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        walk(full);
        continue;
      }
      if (!/\.test\.tsx?$/.test(entry.name)) continue;
      const head = readFileSync(full, "utf8").slice(0, DIRECTIVE_SCAN_BYTES);
      if (DOM_ENVIRONMENT_DIRECTIVE.test(head)) {
        found.push(path.relative(root, full).replaceAll("\\", "/"));
      }
    }
  };
  for (const sub of SEARCH_ROOTS) {
    try {
      walk(path.join(root, sub));
    } catch {
      // kök yoksa taramaya devam — eksik dizin bir hata değil
    }
  }
  return found;
}

interface GlobalSetupProject {
  readonly config?: { readonly environment?: string; readonly root?: string };
}

/** Isıtma gerekli mi? Şüphede kalınırsa `true` — yanlış yön yavaşlık, doğru yön kırmızı süit. */
function shouldWarm(project: GlobalSetupProject | undefined): boolean {
  // Global ortam zaten DOM ise her dosya jsdom yükler; tartışacak bir şey yok.
  const globalEnvironment = project?.config?.environment;
  if (globalEnvironment && globalEnvironment !== "node") return true;

  const filters = positionalFilters(process.argv);
  if (filters.length === 0) return true; // filtresiz koşu = tüm süit = DOM dosyası içeride

  const root = project?.config?.root ?? process.cwd();
  let domFiles: string[];
  try {
    domFiles = findDomTestFiles(root);
  } catch {
    return true; // tarama başarısızsa ısıt
  }
  if (domFiles.length === 0) return false;
  return domFiles.some((file) => filters.some((filter) => matchesFilter(file, filter)));
}

export default function warmDomEnvironment(project?: GlobalSetupProject): void {
  if (!shouldWarm(project)) return;
  const startedAt = Date.now();
  try {
    // Değişken specifier bilinçlidir: jsdom tip tanımı yayımlamıyor ve @types/jsdom kurulu
    // değil, bu yüzden statik bir `import "jsdom"` typecheck'i kırardı. Burada amaç zaten
    // modülün API'si değil, 655 dosyanın işletim sistemi önbelleğine alınmasıdır.
    createRequire(import.meta.url)("jsdom");
  } catch (error) {
    // jsdom çözülemezse süiti burada düşürmeyiz: DOM testi kendi hatasını kendisi verir ve
    // o hata bu dolaylı olandan çok daha okunaklıdır.
    console.warn(
      `[vitest] jsdom ön-ısıtması atlandı: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }
  const elapsed = Date.now() - startedAt;
  if (elapsed > SLOW_WARMUP_MS) {
    console.warn(
      `[vitest] jsdom ön-ısıtması ${elapsed} ms sürdü — dosya önbelleği soğuktu. ` +
        "Bu maliyet worker başlatma bütçesinin dışında ödendi (QA-F7).",
    );
  }
}
