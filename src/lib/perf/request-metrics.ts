// AŞAMA 10 — istek kapsamlı (request-scoped) veritabanı sorgu muhasebesi.
//
// ═══ NEDEN slow-query.ts YETMİYOR ═══
//
// Faz 33'ün `src/lib/perf/slow-query.ts` halka tamponu iki nedenle "bu rota kaç sorgu attı"
// sorusunu YANITLAYAMAZ, ve bu iki sınır ölçülerek bulundu, varsayılarak değil:
//
//   1. KÜRESEL. Tek bir Map; hangi isteğin hangi sorguyu attığını bilmez. İki eşzamanlı
//      istek aynı kovaya yazar.
//   2. YALNIZ YAVAŞ OLANLARI SAYAR. `recordQuery` ilk satırında `ms < slowThresholdMs`
//      (varsayılan 200 ms) ise ERKEN DÖNER. Bir rota 40 tane 3 ms'lik sorgu atarsa
//      slow-query raporunda SIFIR satır görünür — oysa N+1 tam olarak budur.
//
// Bu modül o boşluğu kapatır: AsyncLocalStorage ile kapsanmış bir sayaç, sorgu SÜRESİ ve
// sorgu ŞEKLİ dışında hiçbir şey tutmaz.
//
// ═══ KAPALIYKEN MALİYETİ ═══
//
// Üretim yolunda hiçbir kapsam açık değildir: `scope.getStore()` `undefined` döner, `?? probeSink`
// da `undefined`'dır, fonksiyon ilk `if`te çıkar. Tahsis yok, dize işlemi yok, fingerprint yok.
// `countingClient()` ise kapsam yokken sarmalayıcıyı HİÇ kurmaz — havuzdan alınan istemci
// olduğu gibi geri döner, yani bağlantı başına ek nesne bile oluşmaz.
//
// ═══ PARAMETRE DEĞERİ ASLA TUTULMAZ ═══
//
// Bu sorguların parametreleri fatura tutarları, karşı taraf adları ve hesap bakiyeleridir.
// Burada tutulan tek metin `fingerprint(sql)` çıktısıdır ve fingerprint KAYIT ANINDA alınır —
// ham SQL bir alana yazılıp sonra temizlenmez, çünkü "sonra temizlerim" bir gün unutulur.
// `$1` yer tutucuları, dize sabitleri ve sayısal sabitler `?` olur. Kanıt: bu modülün birim
// testleri ve `scripts/boundary-verify.ts`.

import { AsyncLocalStorage } from "node:async_hooks";
import { fingerprint } from "./slow-query";

/** Bir ölçüm kapsamının biriktirdiği ham sayaçlar. */
interface Sink {
  queryCount: number;
  totalDbTimeMs: number;
  /** Zaten fingerprint'lenmiş — ham SQL hiçbir zaman saklanmaz. */
  slowestQueryShape: string | null;
  slowestQueryMs: number;
}

/** Dışarıya verilen, salt okunur ölçüm sonucu. */
export interface RequestQueryMetrics {
  queryCount: number;
  totalDbTimeMs: number;
  slowestQueryShape: string | null;
  slowestQueryMs: number;
}

function newSink(): Sink {
  return { queryCount: 0, totalDbTimeMs: 0, slowestQueryShape: null, slowestQueryMs: -1 };
}

function snapshot(sink: Sink): RequestQueryMetrics {
  return {
    queryCount: sink.queryCount,
    totalDbTimeMs: Number(sink.totalDbTimeMs.toFixed(3)),
    slowestQueryShape: sink.slowestQueryShape,
    slowestQueryMs: sink.slowestQueryMs < 0 ? 0 : Number(sink.slowestQueryMs.toFixed(3)),
  };
}

const scope = new AsyncLocalStorage<Sink>();

/**
 * HTTP probe kovası.
 *
 * `undefined` olduğu sürece bu modül tamamen ölüdür. Yalnız `armProbe()` onu doldurur ve onu
 * çağıran tek yer `src/app/api/perf-probe/route.ts`'dir — o da `MAS_PERF_PROBE=1` yokken 404
 * döndüğü için üretimde hiç kurulamaz.
 *
 * NEDEN AsyncLocalStorage DEĞİL: bir HTTP isteğinin render'ını saran bir giriş noktası
 * App Router'da bize ait değil (layout ve page kardeş olarak render edilir; layout'ta
 * açılan bir ALS kapsamı page'in sorgularını KAPSAMAZ). Ölçüm sunucusu tek istemciyle,
 * SIRAYLA sürüldüğü için "sıfırla → tek istek → oku" penceresi o isteğin sorgularını tam
 * olarak verir. Bu bir varsayım değil, ölçüm yönteminin şartı: eşzamanlı yük altında bu
 * sayı anlamsızdır ve kanıt dosyasında böyle yazılıdır.
 */
let probeSink: Sink | undefined;

/** Bir kapsam (ALS veya probe) açık mı? `countingClient` bunu sarmalamaya karar vermek için sorar. */
function activeSink(): Sink | undefined {
  return scope.getStore() ?? probeSink;
}

/**
 * Tek bir sorguyu kaydet.
 *
 * Asla fırlatmaz: gözlemlediği şeyi bozabilen bir gözlem aracı, gözlem yokluğundan kötüdür —
 * `slow-query.ts` ile aynı kural, aynı nedenle.
 */
export function recordRequestQuery(sql: string, ms: number): void {
  const sink = activeSink();
  if (sink === undefined) return;
  try {
    if (!Number.isFinite(ms) || ms < 0) return;
    sink.queryCount += 1;
    sink.totalDbTimeMs += ms;
    if (ms > sink.slowestQueryMs) {
      sink.slowestQueryMs = ms;
      // Fingerprint KAYIT ANINDA: ham SQL hiçbir alanda bir an bile durmaz.
      sink.slowestQueryShape = fingerprint(sql);
    }
  } catch {
    /* gözlem, gözlenen şeyi asla bozmaz */
  }
}

/**
 * `fn` boyunca atılan bütün havuz sorgularını say.
 *
 * Yazma/import SLO ölçümünün ve birim testlerin kullandığı yol. AsyncLocalStorage burada
 * güvenlidir çünkü ölçülen şey tek bir async zincirdir (bir script, bir job) — React render
 * sınırları yoktur.
 */
export async function measureRequestQueries<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; metrics: RequestQueryMetrics }> {
  const sink = newSink();
  const value = await scope.run(sink, fn);
  return { value, metrics: snapshot(sink) };
}

/* ── HTTP probe yüzeyi ────────────────────────────────────────────────────────────────── */

/** Probe kovasını kurar (zaten kuruluysa dokunmaz). Yalnız probe route handler çağırır. */
export function armProbe(): void {
  if (probeSink === undefined) probeSink = newSink();
}

/** Probe açık mı? */
export function isProbeArmed(): boolean {
  return probeSink !== undefined;
}

/** Biriken sayaçları OKU ve pencereyi SIFIRLA — tek atomik adım, iki HTTP çağrısı gerekmesin diye. */
export function readAndResetProbe(): RequestQueryMetrics {
  const current = probeSink ?? newSink();
  probeSink = newSink();
  return snapshot(current);
}

/** Yalnız testler için: modülü hiç kurulmamış hâline döndürür. */
export function disarmProbe(): void {
  probeSink = undefined;
}

/* ── havuzdan alınan istemci (pool.connect()) yolu ────────────────────────────────────── */

type AnyArgs = unknown[];
interface QueryableClient {
  query: (...args: never[]) => unknown;
}

/** `pool.query(sql)` ve `pool.query({text})` biçimlerinin ikisinden de SQL metnini çıkarır. */
export function sqlTextOf(arg: unknown): string | undefined {
  if (typeof arg === "string") return arg;
  if (arg !== null && typeof arg === "object") {
    const text = (arg as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  return undefined;
}

/**
 * `pool.connect()` ile alınan bir istemcinin sorgularını sayan sarmalayıcı.
 *
 * NEDEN GEREKLİ. `src/lib/db.ts`'deki `scopedQuery` boğaz noktası yalnız `pool.query()`
 * çağrılarını görür. Bu uygulamadaki YAZMA yollarının neredeyse tamamı (markInstancePaid,
 * importBankStatement, refreshRiskFlags…) `pool.connect()` alıp kendi transaction'ını sürer;
 * o sorgular boğaz noktasından GEÇMEZ. Yalnız `scopedQuery`'yi enstrümante etmek, yazma
 * yolu için `query_count = 0` raporlamak olurdu — ölçüm değil, süs.
 *
 * ÇİFT SAYIM YOK: `scopedQuery` istemciyi `base.connect()` ile doğrudan alır ve BU
 * sarmalayıcıdan geçmez; `scopedConnect` ise yalnız buradan geçer. İki yol ayrıktır.
 *
 * KAPSAM DIŞI (bilerek): `prepare()`'in attığı `set_config` / `set role` ifadeleri. Onlar
 * sarmalama YAPILMADAN önce ham istemci üzerinde koşar, yani `query_count` uygulama
 * ifadelerini sayar, bağlantının rol hazırlığını değil. İki yolda da aynı kural geçerli.
 */
export function countingClient<T extends QueryableClient>(client: T): T {
  // Kapsam yoksa hiç sarmalama: üretimde bağlantı başına tek bir karşılaştırma.
  if (activeSink() === undefined) return client;

  const original = client.query.bind(client) as (...args: AnyArgs) => unknown;
  const wrapped = (...args: AnyArgs): unknown => {
    const startedAt = process.hrtime.bigint();
    const finish = (): void => {
      const text = sqlTextOf(args[0]);
      if (text) recordRequestQuery(text, Number(process.hrtime.bigint() - startedAt) / 1e6);
    };
    let out: unknown;
    try {
      out = original(...args);
    } catch (e) {
      // Senkron fırlatan bir sürücü hatası da bir round trip denemesidir; sayılır.
      finish();
      throw e;
    }
    if (out !== null && typeof out === "object" && typeof (out as PromiseLike<unknown>).then === "function") {
      // `then(finish, finish)` reddi YUTMAZ: türetilmiş promise burada tüketilir, orijinali
      // çağıranın `await`ine olduğu gibi ulaşır. Hata veren sorgu da sayılır — on saniye
      // sonra düşen sorgu, görülmesi en gereken sorgudur (slow-query.ts ile aynı gerekçe).
      void (out as Promise<unknown>).then(finish, finish);
    } else {
      finish();
    }
    return out;
  };

  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === "query") return wrapped;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as T;
}
