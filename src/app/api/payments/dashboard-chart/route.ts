import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { requireApiSession } from "@/lib/auth";
import { apiError, withApiHandler } from "@/lib/api-response";
import { CORRELATION_HEADER } from "@/lib/correlation";
import { istanbulDateISO } from "@/lib/reports/rules";
import { loadThresholds } from "@/lib/radar/engine";
import { loadPaymentDashboard } from "@/lib/radar/queries";
import { paymentDashboardChart } from "@/lib/radar/payment-dashboard-chart";

export const dynamic = "force-dynamic";

/**
 * `/payments` panosunun grafik verisi — sayfa render'ından AYRILDI.
 *
 * Sayfa artık grafiği sunucuda hesaplamıyor; `PaymentsChartLazy` bu ucu görünürlüğe girince
 * çağırıyor. Kazanç, ilk boyamanın 24 aylık kova toplamını beklememesi.
 *
 * ═══ OTURUM KONTROLÜ NEDEN BURADA DA VAR ═══
 *
 * `src/middleware.ts` yalnız ÇEREZİN VARLIĞINA bakar; Edge runtime'da DB sorgusu yapamadığı için
 * iptal/süre dolumu göremez. Bu yüzden repodaki her JSON ucu ayrıca DB destekli
 * `requireApiSession()` çağırır (`/api/facts`, `/api/search`, `/api/analytics/export`) — Wave 0'dan
 * beri bu, zorunlu parola değişikliği bekleyen kullanıcıyı da reddeder (`getCurrentUser()` etmiyordu).
 *
 * Bu uç ilk hâlinde o kontrolü TAŞIMIYORDU ve davranışı ölçüldü — uydurma bir çerezle:
 *
 *     çerezsiz            → 307 (middleware)
 *     uydurma çerez       → 200 + gövde   ← olmaması gereken
 *
 * Finansal SATIR sızmıyordu: oturum yoksa `getDbContext()` katman veremez, bağlantı
 * `mas_radar_app`e döner ve RLS her şeyi keser (ölçüldü: 3 seri, 0 nokta, 0 TL). Ama iki şey
 * yine de yanlıştı: (1) `criticalThreshold` gibi yapılandırma değerleri yanıtta yer alıyordu,
 * (2) kimliği doğrulanmamış her istek iki DB sorgusu harcıyordu. `/api/search`'ün kendi yorumu
 * bu durumu zaten adlandırıyor: "yabancılara cevap veren bir uç bir keşif aracıdır."
 */
export async function GET(request: Request) {
  return withApiHandler(request, async ({ requestId }) => {
    const user = await requireApiSession();
    if (!user) return apiError(401, "Yetkisiz.", { code: "unauthorized", requestId });

    const today = istanbulDateISO();
    const anchor = new Date(`${today}T00:00:00Z`);
    const futureEnd = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 24, anchor.getUTCDate()))
      .toISOString()
      .slice(0, 10);
    const pool = getPool();
    const [{ buckets }, thresholds] = await Promise.all([
      loadPaymentDashboard(pool, today, futureEnd),
      loadThresholds(pool),
    ]);

    return NextResponse.json(paymentDashboardChart(buckets, today, thresholds.critical), {
      // `private`: kullanıcıya özel finansal veri; paylaşılan bir önbelleğe asla girmemeli.
      // 30 sn, sayfa içi tekrar isteklerini emmeye yeter ve gerçek finansal veriyi uzun süre
      // bayat tutmaz.
      headers: { "Cache-Control": "private, max-age=30", [CORRELATION_HEADER]: requestId },
    });
  });
}
