# 08 — `prepare-runtime` amplifikatör provenance

**Terminoloji — bu ayrım raporun geri kalanı için bağlayıcıdır:**

| rol | ne |
|---|---|
| `ROOT_CAUSE` | `db:roles-rls:verify`'ın gerçek veritabanına fixture yazması (kapısız hâli) |
| `ROOT_CONTAMINATION` | `payments` tablosunda kalan **"P24B fixture"** şablon satırı |
| `AMPLIFIER` | `prepare-runtime` — **doğru çalışarak**, kirlenmiş şablondan satır türetmesi |

`prepare-runtime` kusurlu değildir. Kirli bir girdi üzerinde tanımlı işini yapmıştır.

## Zincir

```
package.json
  dev   : … && tsx scripts/prepare-runtime.ts && next dev
  start : … && tsx scripts/prepare-runtime.ts && next start
            |
scripts/prepare-runtime.ts:32
  await runAsSystem(() => ensureWindow(pool, istanbulDateISO(), actorId, 24))
            |
src/lib/radar/engine.ts:442
  for (let delta = -1; delta <= Math.max(1, futureMonths); delta++)
        -1 … 24  =  26 iterasyon
            |
  generateInstancesForMonth(pool, m, actorId)  ->  amount_source = 'generated'
```

## Deterministik eşleşme

`ensureWindow(…, 24)` döngüsü `delta = -1 … 24` aralığında **26** ay üretir.

Ölçülen (salt-okunur):

```sql
select count(*) from public.payment_instances
 where payment_id = '7b300bfe-944f-468b-91fa-2de65b7cfee5';
-- 26
```

**26 = 26.** Bu bir korelasyon değil; döngü sayısının veriyle birebir örtüşmesidir.

## Olay dağılımı

`payment_instances.created_at`, tam tablo (511 satır):

| küme | created_at | n | amount_source |
|---|---|---|---|
| taban | 2026-07-17 13:xx | 468 | `legacy_unknown` |
| taban | 2026-08-09 21:xx | 17 | `generated` |
| **A1** | 2026-08-25 10:19:27.356 – 10:19:55.937 | **3** | `generated` |
| **A2** | 2026-08-26 12:02:37.034 – 12:02:38.068 | **23** | `generated` |

468 + 17 + 3 + 23 = **511**.

**A1** (3 satır) — `instance_month` = 2026-07-01, 2026-08-01, 2026-09-01.
**A2** (23 satır) — `instance_month` = 2026-10-01 … 2028-08-01, kesintisiz aylık seri.

A1 ∪ A2 = 26 ay, hepsi tek ebeveynden: `payments.id = 7b300bfe-…` (**"P24B fixture"**,
`recurrence_type='monthly'`, `due_day=15`), oluşturulma `2026-08-25 10:09:08.377` — yani **I1**.

## Zaman çizelgesi

```
2026-08-25 10:09:08  I1  roles-rls-verify -> payments "P24B fixture" + users + action_items
2026-08-25 10:10:38  I1  (ikinci koşu, rastgele kullanıcı çifti)
2026-08-25 10:19:27  A1  prepare-runtime  -> 3 payment_instances      (pnpm dev/start)
2026-08-26 12:02:37  A2  prepare-runtime  -> 23 payment_instances     (pnpm dev/start)
2026-08-26 15:16:19  I2  roles-rls-verify -> users + action_items
```

A2, I2'den **önce** gerçekleşmiştir. Yani "488 → 511" deltası ikinci fixture olayının ürünü
değil, birinci olayın şablonundan türeyen bir amplifikasyondur.

## Hipotezin doğrulanması ve düzeltilmesi

İlk hipotez — "+23 `prepare-runtime` ürünüdür" — **doğrudur**, ancak iki noktada
netleştirilmiştir:

1. Kanıt korelasyon değil, **kod yolu + döngü sayısı + ebeveyn kimliği + ay serisi**.
2. `prepare-runtime` kök neden **değildir**; kök neden fixture şablonudur.

## Açık risk

Şablon satırı `payments` tablosunda durduğu sürece **her `pnpm dev` / `pnpm start` koşusu**
kayan 26 aylık pencereyi yeniden hesaplar ve takvim ilerledikçe **yeni satır üretmeye devam eder**.
`payment_instances` sayısı bu yüzden sabitlenemez; bu, herhangi bir footprint ölçümünü hareketli
hedef hâline getirir.

Temizlik bu turda **yapılmadı** (yetki bekliyor) ve mevcut temizlik script'i eksiktir —
bkz. `05-writer-surface-manifest.md`, `scripts/db/fixture-cleanup.ts` satırı.
