# 04 — metric_snapshots yeniden hesaplama — DRY RUN

**Gerçek DB'de hiçbir UPDATE yapılmadı.** Tüm işlem `mas_radar_p24b_dryrun_clone`
(gerçek DB'nin `pg_dump` ile alınmış disposable klonu) üzerinde koştu.

## Mekanizma — kaynaktan çözüldü

`src/lib/analytics/snapshots.ts`:

| soru | cevap |
|---|---|
| `snapshot_date` nasıl belirleniyor? | çağıranın verdiği `date` parametresi (varsayılan `istanbulDateISO()`) |
| `source_cutoff` var mı? | evet — `new Date().toISOString()`, yani **hesaplama anı** |
| hesaplama current state mi, as-of-date mi? | **current state.** `collectMetricSnapshots` sorguları tarih filtresi taşımaz (`select status,count(*) from payment_instances group by status`). `date` yalnız vade ufukları ve upsert anahtarı için kullanılır. |
| upsert mi append-only mi? | **upsert** — `on conflict (snapshot_date, metric_key, dimension_key) do update` |
| kaç metrik üretiliyor? | bu veri kümesinde 24 satır (14 `metric_key`, bazıları boyutlu) |
| tarihsel yeniden hesaplama destekleniyor mu? | **evet, yapısal olarak** — `refreshMetricSnapshots(pool, actorId, '2026-08-27')` o tarihin satırlarını yerinde günceller |

> **Dürüst sınır:** yeniden hesaplama *current state* üzerinden yapılır; 2026-08-27'de değerlerin
> ne olduğunu **yeniden inşa etmez**, bugün ne olduklarını yazar. Bu vaka için doğru olan da budur —
> o tarihteki değerler zaten kirlilik yüzünden yanlış. `source_cutoff` alanı yeniden hesaplamanın
> ne zaman yapıldığını kaydettiği için işlem izlenebilir kalır.

## Prosedür

1. gerçek DB'nin disposable klonu alındı (gerçek DB yalnız **okundu**: `pg_dump`)
2. klonda 42 satırın tamamı ölçülen FK sırasında silindi
3. klonda `refreshMetricSnapshots(pool, systemActor, '2026-08-27')` çalıştırıldı
4. 24 snapshot satırı before/after karşılaştırıldı

## Sonuç

```
snapshot satırı : 24 -> 24        (upsert; yeni satır yok)
SEMANTİK değişen: 2
TEKNİK-only     : 22             (yalnız source_cutoff)
BEKLENMEDİK     : 0
orphan instance : 0
```

### Semantik değişimler — ikisi de öngörülmüştü

| metrik | before | after | fark | sebep |
|---|---|---|---|---|
| `payment_status.unpaid` | 13.621.000,00 | **13.595.000,00** | −26.000,00 | 26 fixture instance × 1.000 TRY |
| `task_status.open` | 8 | **4** | −4 | 4 P24B `action_items` |

### Teknik-only değişimler

Kalan 22 metrik (`cash_*`, `data_*`, `loan_*`, `part_*`, `maturity_outflow.*`,
`reminder_status.*`, `payment_status.{paid,partial,cancelled,planned}`,
`task_status.{done,in_progress}`, `decision_confidence`, `external_pending`) için
**değer değişmedi**; yalnız `source_cutoff` yeniden yazıldı. Bunlar semantik değişim olarak
**sayılmadı** — her yeniden hesaplama cutoff'u tazeler ve bunu "sayı oynadı" diye raporlamak
gerçekten oynayan iki sayıyı gürültüde boğardı.

`DERIVED_REFRESH_PLAN = PASS` (beklenmedik semantik değişim yok)

Ham veriler: `04-metric-snapshot-recompute-dryrun.json`.
