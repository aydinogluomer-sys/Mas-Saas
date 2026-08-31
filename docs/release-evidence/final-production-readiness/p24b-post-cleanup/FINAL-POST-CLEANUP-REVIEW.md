# P24B — cleanup sonrası bağımsız inceleme

`27fdbe8f7cdd68600c71a5d6053c7e25510c702d`. Bu tur **yeni bir cleanup değildir**: gerçek
`mas_radar_dev` üzerinde tek bir INSERT/UPDATE/DELETE/DDL yok. İnceleme başı ve sonu tüm-DB
parmak izi aynı (`a8f90e34…`).

## Karşılaştırma noktası hatırlanan bir sayı değil

"Yalnız şu tablolar değişti" iddiası, cleanup öncesi durumun sorgulanabilir bir kopyasını
gerektirir. O kopya elde: USB yedeğinden geri yüklenmiş `mas_radar_p24b_final_usb_restore`,
cleanup öncesi parmak iziyle birebir eşleştiği kanıtlanmış. Aşağıdaki her "önce" değeri o
veritabanından **sorgulanarak** alındı.

## Kalıntı taraması

```
EXACT manifest kimliği   42/42 ABSENT   (karar burada verilir)
fixture payment 7b300bfe → yok · fixture instance → 0 · orphan → 0
p24b users/action_items/approvals/settings → 0 · rls-verify izi → 0
```

### Bir yanlış pozitif, kör silme olmadan çözüldü

`approvals.requested_by IS NULL` = **68/68**. İlk bakışta kalıntı gibi duruyor. Ölçüm:

```
cleanup ÖNCESİ (USB kopyası) : 72 approval → 70 NULL, 2 dolu
cleanup SONRASI (gerçek DB)  : 68 approval → 68 NULL, 0 dolu
```

Yani NULL olmak zaten normaldi (72'nin 70'i). Silinen 4 approval'ın 2'si NULL'du, 2'si de
`requested_by` dolu olan **tek** satırlardı — çünkü fixture kullanıcılarına işaret ediyorlardı.
Kalan tabloda hiç dolu satır kalmaması cleanup'ın ürettiği bir bozulma değil, bu veri kümesinin
önceden var olan durumu. FK yetim sondalarının tamamı 0. **Hiçbir satır silinmedi.**

## Sayımlar, metrikler, audit

```
action_items 6 · approvals 68 · payment_instances 485 · payments 19 · users 13 · settings 7
task_status.open 4 · payment_status.unpaid 13.595.000 TRY
checks/loans/cashflow toplamları cleanup öncesiyle AYNI
AUDIT 734 → 736 · mevcut 734 satırın 734'ü hash olarak DEĞİŞMEMİŞ
yeni eylemler: p24b_fixture_cleanup, refresh_metric_snapshots (her biri 1 — mükerrer yok)
ATILLA mevcut · satır hash'i cleanup öncesiyle AYNI
FK 43 kısıt · yetim 0
```

## Değişimin tablo bazında sınıflandırması

86 tablo karşılaştırıldı. Değişen **tam olarak 8**:

```
action_items · approvals · payment_instances · payments · users · settings   (manifest)
metric_snapshots (türev düzeltme) · audit_logs (2 ekleme)
BEKLENMEYEN DEĞİŞEN: []   ·   BEKLENİP DEĞİŞMEYEN: []
```

## İkinci cleanup reddediliyor

Harcanabilir klonda kanonik script tekrar çalıştırıldı:

```
GERİ ALINDI: PRECONDITION_NOT_SATISFIED — 42 sorun
(ilk: users/92cee4d3-… BULUNAMADI)
```

Gerçek veritabanında ikinci bir DELETE denemesi yapılmadı.

## prepare-runtime — amplifier yüzeyi

Olayda kök neden değildi ama **çoğaltıcıydı**: 2026-08-26'da fixture ödemesi için 23 instance
üretmişti. Bu yüzden gerçek runtime açılmadan önce, temizlenmiş durumun klonunda iki kez
çalıştırıldı ve delta tablo tablo ölçüldü.

| yüzey | tablo | işlem | ölçülen delta |
|---|---|---|---|
| `ensureSystemActor` | `users` | INSERT … ON CONFLICT DO NOTHING | **0** (`system` hesabı zaten var) |
| `ensureWindow(…, 24)` | `payment_instances` | eksik pencere satırları | **0 yeni satır** (485 → 485 → 485) |
| `ensureWindow` denetimi | `audit_logs` | INSERT | **+26 her koşuda** |

```
RUN1: audit_logs +26 · payment_instances 485→485 (1 satır UPDATE, geçmiş tarihli bir kayıt)
RUN2: audit_logs +26 · payment_instances hiç değişmedi
FIXTURE YENİDEN OLUŞTU MU: HAYIR — fixture payment 0, instance 0, users/settings/approvals 0
```

> **İdempotans iddiasını abartmıyorum.** İş verisi RUN1'den sonra sabit: yeni satır yok,
> şişme yok, fixture yeniden doğmuyor. Ama `audit_logs` her açılışta 26 `generate_instances`
> satırı ekliyor — bu tasarım gereği append-only bir iz, iş verisi bozulması değil; yine de
> "tam idempotent" demek yanlış olurdu. Her uygulama açılışının 26 denetim satırı bırakması
> ayrıca değerlendirilmesi gereken bir gürültü kaynağıdır.

## Kalite ve runtime smoke (hepsi harcanabilir klonda)

```
typecheck 0 · eslint 0 · vitest 69 dosya / 1438 test 0 · next build 0
next start → Ready 6.1s · /login 200 · /ready 200 · /overview 307 · sunucu logunda 5xx: 0
rota + dashboard süiti      94 geçti / 8 düştü
RBAC (authz)                2/2 geçti
gezinme + akışlar           5/5 geçti — 78 ayrık href, 78 başarılı, 7749 birim
```

Düşen 8 vakanın tamamı **piksel ekran görüntüsü** karşılaştırması: sayfa yüksekliği
1068px → 858px. Sebep tam olarak beklenen şey — 42 satır kalktı, sayfalar kısaldı. Golden
görüntüler eski veri hacmine göre alınmıştı. Fonksiyonel düşen vaka **0**.

RBAC süiti ilk denemede `password authentication failed` verdi; sebebi harness'in
`postgres:postgres` kimliğini sabit yazması. Harness'in kendi `MAS_E2E_VERIFIER_URL` kaçış
kapısıyla çözüldü — RBAC ile ilgisi yoktu.

## Gerçek kaynak, inceleme boyunca

```
WHOLE_DB_FP · TARGET_FP · LEDGER · COUNTS · BASE_TABLE_SET  → hepsi STABLE
Klon testleri kaynağa SIZMADI.
```

## Dosyalar

`00-repo-and-backup` · `00-review-summary` · `01-current-source-readonly` ·
`02-remnant-scan` · `03-business-metrics` · `04-audit-and-atilla` · `05-fk-orphans` ·
`06-change-classification` · `07-prepare-runtime-writer-inventory` ·
`08/09-clone-prepare-runtime-run1/2` · `10-build-and-tests` · `11-clone-runtime-smoke` ·
`12-final-source-readonly` · `13-second-cleanup-refusal`

```
REAL_RUNTIME_RESTARTED = NO
READY_FOR_REAL_RUNTIME_RESTART = YES (ayrı yetki bekliyor)
```
