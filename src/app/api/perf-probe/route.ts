// AŞAMA 10 — rota başına DB sorgu muhasebesi okuma ucu.
//
// NE DÖNER: yalnız sayılar ve bir sorgu ŞEKLİ (fingerprint). Parametre değeri, satır içeriği,
// bağlantı dizesi veya herhangi bir parasal büyüklük DÖNMEZ — `request-metrics.ts` ham SQL'i
// hiçbir zaman saklamaz, fingerprint kayıt anında alınır.
//
// NEDEN VAR: "bu rota kaç sorgu attı, en yavaş şekli neydi, toplam DB süresi neydi" sorusunun
// sunucu içinden başka cevabı yok. `pg_stat_statements` bu kümede kurulu değil (kurmak
// shared_preload_libraries + cluster yeniden başlatma demek; port 3000'deki canlı örnek
// bunu kaldırmaz) ve `slow-query.ts` halka tamponu küresel + yalnız yavaş sorguları tutuyor.
//
// NEDEN GÜVENLİ:
//   1. `MAS_PERF_PROBE=1` YOKSA 404. Üretimde bayrak kurulmaz, uç yoktur, sayaç hiç ARMED
//      olmaz — yani muhasebe yolu üretimde sessiz değil, hiç kurulmamış olur.
//   2. `/api/` altında olduğu için `src/middleware.ts`'in default-deny kapısına tabidir:
//      oturum çerezi olmadan gelen istek /login'e yönlendirilir.
//   3. Handler HİÇBİR veritabanı sorgusu atmaz — kendi ölçümünü kirletmez.
//
// KULLANIM (yalnız ölçüm sunucusu): her çağrı bir önceki çağrıdan bu yana biriken pencereyi
// OKUR ve pencereyi SIFIRLAR. Ölçüm şu sırayla anlamlıdır ve `scripts/perf/route-slo.ts` tam
// olarak bunu yapar:
//
//   GET /api/perf-probe   → pencereyi sıfırla (ilk çağrı ayrıca sayacı kurar)
//   GET /overview         → ölçülecek tek istek
//   GET /api/perf-probe   → o isteğin query_count / total_db_time / slowest shape değeri
//
// Bu pencere yalnız SIRAYLA sürülen tek istemcili bir sunucuda o isteğe aittir. Eşzamanlı yük
// altında sayı anlamsızdır; kanıt dosyası ölçümün bu şartını açıkça yazar.
import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { armProbe, readAndResetProbe } from "@/lib/perf/request-metrics";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  if (!env.perfProbeEnabled) {
    // 404, 403 değil: kapalıyken bu ucun VAR OLDUĞUNU bile söylememesi doğru cevap.
    return NextResponse.json(
      { error: { message: "Bulunamadı.", code: "not_found" } },
      { status: 404 },
    );
  }
  armProbe();
  const metrics = readAndResetProbe();
  return NextResponse.json({
    armed: true,
    queryCount: metrics.queryCount,
    totalDbTimeMs: metrics.totalDbTimeMs,
    slowestQueryMs: metrics.slowestQueryMs,
    slowestQueryShape: metrics.slowestQueryShape,
  });
}
