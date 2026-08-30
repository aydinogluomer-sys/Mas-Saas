# P24B cleanup v2.3 — eşzamanlılık ve makbuz doğruluğu kapanışı

Temel: `db653007b669261c0ae292537fa20c0fef2e9eb2`. Üç takip alanı kapatıldı. Gerçek
`mas_radar_dev` üzerinde bu turda **INSERT / UPDATE / DELETE / DDL / DROP yok**.

## G1 — smoke kapısı geç çalışıyordu

Kapı `p24b-cleanup-binding.ts:92`'deydi: **Pool (68), `begin` (72) ve 86 tablonun
fingerprint'i (81) SONRASINDA.** Doğruydu ama geçti — korunan bir ad bile önce bir bağlantıya ve
tam bir fingerprint'e mal oluyordu. Hedeflenen testin 5 saniyede timeout olmasının sebebi buydu.

Artık `main()`'in ilk kararı; **makbuz okunmadan** önce. Kaynak DB adı URL'den türetiliyor, yani
karar için hiçbir şey açılmıyor. Bağlandıktan sonra `current_database()` ile URL kimliği ayrıca
doğrulanıyor — erken akıl yürütme güvenilmiyor, **teyit ediliyor**.

Test ayrımı: URL hiçbir şeyin dinlemediği bir porta bakıyor. Kapı fail-fast ise hata **ada** dair
olur; önce bağlansaydı **bağlantıya** dair olurdu. `ECONNREFUSED|connect` izi yok.

## G2 — `targetRows` gerçek sayım değildi

`targetFingerprint` yalnız digest döndürüyordu ve çağıranlar sayımı digest üzerinden yapıyordu:

```ts
if (targetFp.includes("MISSING")) …
const found = targets.length - (smokeTargetFp.match(/MISSING/g)?.length ?? 0);
```

**SHA256 digest'i hex'tir — "MISSING" harflerini içeremez.** Bu kontroller her zaman `false`
dönüyordu ve `found` her zaman 42 çıkıyordu. Binding, geri yüklenen kopyada kaç satır olduğundan
**bağımsız olarak** `targetRows: 42` yazıyordu — yani restore smoke'un kanıtlamak için var olduğu
tam olarak o olgu uyduruluyordu.

Artık `TargetFingerprintResult { digest, expected, found, missing[] }`; `found`/`missing` sorgu
sonuçlarından geliyor, digest metninden **türetilmiyor**.

Negatif kontrol eski bug'ı doğrudan öldürüyor:

```
kurulum : disposable restore'dan payment_instances/3ab000e6 silindi
gözlenen: DURDURULDU: kaynakta 41/42 hedef satır var; eksik: payment_instances/3ab000e6…
binding : ÜRETİLMEDİ        (eski davranış: targetRows: 42)
```

## G3 — dondurma, binding'in kapsamından dardı

`LOCK_TABLES` 8 tabloydu; `wholeDbFingerprint` ise 86'yı kapsıyordu. Binding "bu veritabanında
hiçbir şey kımıldamadı" diyordu ama dondurma diğer **78 tabloyu korumuyordu**: fingerprint ile
COMMIT arasında başka bir oturum onlara yazabilirdi.

Artık katalogdan türetilen **tüm base table'lar** tek `LOCK` ifadesinde, deterministik sırada
(`schema, name`), güvenli identifier quoting ile. Kilit alındıktan **sonra** katalog yeniden
okunuyor (`BASE_TABLE_SET_CHANGED_DURING_FREEZE`) ve fingerprint'in kapsadığı her tablonun
kilitli olduğu doğrulanıyor.

```
BASE_TABLE_COUNT            86
LOCKED_TABLE_COUNT          86
UNLOCKED_FINGERPRINT_TABLES []
lock_timeout                10s → bir tablo alınamazsa ROLLBACK
```

### İki ayrı kontrol, iki ayrı iddia

| kontrol | ne kanıtlar |
|---|---|
| `05-static-wholedb-stale-control` | **karşılaştırma** çalışıyor — cleanup başlamadan önceki değişikliği yakalıyor |
| `04-concurrent-wholedb-control` | **dondurma** çalışıyor — kilitler tutulurken hedef DIŞI yazma 55P03 ile reddediliyor |

İkincisinde pozitif kontrol de var: aynı yazma kilit yokken **geçiyor**. Olmasaydı, "bloke oldu"
sonucu başka bir sebeple bloke olmuş olabilirdi.

## Prova

```
FRESH_REHEARSAL_DB   mas_radar_p24b_v23_drill
source  → found 42 / missing 0
restore → found 42 / missing 0 · hedef digest MATCH · tüm-DB digest MATCH
BEGIN → LOCK 86/86 → table-set recheck → locked target binding → locked whole-DB binding
DELETE 42 · ORPHANS 0
SNAPSHOT 24 → 24 · semantik 2 · teknik-only 22
AUDIT mevcut değişmedi · INSERT 2/2
PARA payments −1.000 · instances −26.000 · diğerleri 0
ATILLA korundu · LEDGER 0087/87 · hedef dışı 0
OUTCOME COMMITTED
```

## Dosyalar

`00-followup-defects` · `01-fail-fast-gate` · `02-target-count-contract` · `03-all-table-lock` ·
`04-concurrent-wholedb-control` · `05-static-wholedb-stale-control` · `06-snapshot-before-image` ·
`07-rehearsal-receipt`

```
SOFTWARE_BLOCKERS_REMAINING = 0
OFF_DEVICE_BACKUP_REAL      = BLOCKED
P24B_CLEANUP_AUTHORIZED     = NO
```
