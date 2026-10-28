import { describe, it, expect, beforeEach } from "vitest";
import { cache } from "@/lib/cache/engine";
import { CACHE_TAGS } from "@/lib/cache/tags";

describe("Query Cache & Invalidation Engine", () => {
  beforeEach(async () => {
    await cache.clear();
  });

  it("önbelleğe veri yazar ve başarıyla geri okur", async () => {
    await cache.set("test:key1", { total: 1000, currency: "TRY" });
    const val = await cache.get<{ total: number; currency: string }>("test:key1");

    expect(val).toEqual({ total: 1000, currency: "TRY" });
  });

  it("olmayan anahtar için null döner ve miss sayacını artırır", async () => {
    const val = await cache.get("non-existent-key");
    expect(val).toBeNull();

    const stats = cache.getStats();
    expect(stats.misses).toBeGreaterThanOrEqual(1);
  });

  it("withCache deseni: cache boşken hesaplar, ikinci çağrıda cache'ten döner", async () => {
    let callCount = 0;
    const fetcher = async () => {
      callCount++;
      return { forecast13w: [100, 200, 300] };
    };

    // İlk çağrı -> fetcher çalışmalı
    const res1 = await cache.withCache("forecast:13w", fetcher, {
      ttlSeconds: 60,
      tags: [CACHE_TAGS.CASHFLOW, CACHE_TAGS.FORECAST_13W],
    });
    expect(res1).toEqual({ forecast13w: [100, 200, 300] });
    expect(callCount).toBe(1);

    // İkinci çağrı -> fetcher çalışmamalı, cache'ten gelmeli
    const res2 = await cache.withCache("forecast:13w", fetcher);
    expect(res2).toEqual({ forecast13w: [100, 200, 300] });
    expect(callCount).toBe(1);
  });

  it("invalidateTag: belirli bir tag'e bağlı anahtarları siler, ilgisiz tag'leri korur", async () => {
    // Fatura ile ilgili 2 view
    await cache.set("view:invoices_open", [1, 2], { tags: [CACHE_TAGS.INVOICES] });
    await cache.set("view:receivables_open", [3, 4], { tags: [CACHE_TAGS.INVOICES, CACHE_TAGS.RECEIVABLES] });

    // Banka ile ilgili 1 view
    await cache.set("view:bank_position", { balance: 50000 }, { tags: [CACHE_TAGS.BANK_ACCOUNTS] });

    // Fatura tag'ini invalidate et
    const invalidatedCount = await cache.invalidateTag(CACHE_TAGS.INVOICES);
    expect(invalidatedCount).toBe(2);

    // Fatura view'ları silinmiş olmalı
    expect(await cache.get("view:invoices_open")).toBeNull();
    expect(await cache.get("view:receivables_open")).toBeNull();

    // Banka view'ı hala sağlam durmalı
    expect(await cache.get("view:bank_position")).toEqual({ balance: 50000 });
  });

  it("invalidateTable: fatura tablosu değiştiğinde tüm ilişkili görünümleri otomatik düşürür", async () => {
    await cache.set("view:cfo_briefing", { netCash: 100 }, { tags: [CACHE_TAGS.CFO_BRIEFING] });
    await cache.set("view:cashflow", { weekly: [] }, { tags: [CACHE_TAGS.CASHFLOW] });
    await cache.set("view:unrelated", { ok: true }, { tags: [CACHE_TAGS.BACKGROUND_JOBS] });

    // 'invoices' tablosuna yeni kayıt düştü -> tablo invalidation tetiklenir
    await cache.invalidateTable("invoices");

    // İlgili tüm view'lar silinmeli
    expect(await cache.get("view:cfo_briefing")).toBeNull();
    expect(await cache.get("view:cashflow")).toBeNull();

    // İlgisiz view korunmalı
    expect(await cache.get("view:unrelated")).toEqual({ ok: true });
  });
});
