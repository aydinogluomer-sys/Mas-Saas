# 00 — Runtime freeze

**Amaç.** Quiescence ölçümü ancak hareketsiz bir hedefte anlam taşır. `payment_instances`
sayısının 488'den 511'e çıkması, canlı bir yazıcının ölçüm sırasında çalıştığını gösteriyordu;
bu yüzden discovery değil, önce **dondurma** yapıldı.

## Dondurmadan önce ölçülen canlı süreçler

Hepsi `C:\Users\Trade Bilisim\Mas Saas` ağacından; hepsi doğrudan veya dolaylı olarak
`mas_radar_dev`'e yazabilir durumdaydı.

| PID | süreç | başlangıç (yerel) | neden yazıcı |
|---|---|---|---|
| 18444 | `next dev` sunucusu, `:3000` | 2026-08-29 11:56:03 | uygulama server action'ları `getPool()` ile gerçek DB'ye yazar |
| 24168 | `next dev` (ebeveyn) | 2026-08-29 11:56:01 | `pnpm dev` zinciri `prepare-runtime`'ı çalıştırır |
| 29844 | `pnpm dev` | 2026-08-29 11:55:53 | aynı zincir |
| 24032 | `next build` | 2026-08-29 21:56:17 | derleme sırasında route değerlendirmesi |
| 30828 | `pnpm build` | 2026-08-29 21:56:14 | aynı |
| 31528 | `next build` jest-worker | — | çocuk süreç |
| 32496 | Playwright `test-server` | 2026-08-29 18:12:23 | test koşusu mutasyon rotalarına gidebilir |
| 13076 / 11368 | `bot.py` (Telegram) | 2026-08-29 18:58:34 | `MAS_APP_BASE_URL/api/telegram/assistant`'a HTTP POST — **dolaylı yazıcı** |

> **`next dev` ve `next build` AYNI ANDA koşuyordu.** Bu, projenin "tek Next sunucusu" kuralını
> ihlal eder ve `.next` önbelleğini bozarak sahte performans ölçümleri üretir.

> **`bot.py` doğrudan DB'ye bağlanmaz.** `httpx` ile uygulamanın kendi API'sine POST atar; yani
> SQL içermediği hâlde gerçek DB'ye yazabilen bir süreçtir. Yazıcı yüzeyinin neden yalnız
> "SQL içeren dosyalar" olarak tanımlanamayacağının canlı örneği.

## Dondurulmayanlar

- `mas-radar-pg`, `mas-radar-pg-adim4-sandbox` (PostgreSQL container'ları) — ölçüm için gerekli
- `supabase_*_meritflow-dev` — başka bir projeye ait
- `precision-dynamics-hub-main` Vite süreçleri — başka bir projeye ait

## Dondurma sonrası doğrulama

```
Mas Saas node/python süreci : YOK
:3000 / :3110 / :3210 dinleyen: YOK
Zamanlanmış görev (Task Sched.): eşleşme YOK
npm lifecycle hook (pre*/post*): YOK  (105 script içinde sıfır)
```

Runtime bu turun tamamı boyunca kapalı tuttu; `01`–`03` snapshot'ları bu durumda alındı.

## Yeniden başlatma

Bu tur runtime'ı **yeniden başlatmadı**. `bot.py` ve Next sunucusu kullanıcı onayıyla
başlatılmalıdır. Fixture ödeme satırı `payments` tablosunda durduğu sürece her `pnpm dev` /
`pnpm start` yeni `payment_instances` üretmeye devam eder — bkz. `08-amplifier-provenance.md`.
