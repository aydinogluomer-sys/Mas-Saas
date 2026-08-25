# Final production readiness — kanıt paketi indeksi

Kaynak: `MAS_SaaS_Production_Readiness_Gap_Closure_Rehberi.md` §32 "Final evidence package".

Rehber, release sonunda bütün kanıtın **tek klasörde** toplanmasını istiyor:
`docs/release-evidence/final-production-readiness/`.

Bu README o klasörün indeksidir ve **her slot için gerçek durumu** yazar. Rehberin
§30.6 anti-pattern'i gereği boş placeholder dosya **üretilmedi**: var olmayan kanıt için
boş dosya açmak "runbook exists → operation ready" yanılgısının dosya sistemi biçimidir.
Bir slot ancak ilgili aşama gerçekten koştuğunda ve çıktı üretildiğinde dosyalanır.

## Her kanıt dosyasının taşıması zorunlu alanlar (§32)

```text
commit
date
DB class
DB target
commands
exit codes
assertion count
expected
actual
failures
final status
```

## 19 slotluk indeks (§32 sırası)

| Slot | Dosya | Üreten aşama | Durum |
|---|---|---|---|
| 00 | `00-final-rc-manifest.md` | Aşama 02 | **SCAFFOLD** — dosya var; `rc_sha` alanı `PENDING`, Aşama 10 kapanınca dondurulacak |
| 01 | `01-ci-hardening.md` | Aşama 04 | YOK — Aşama 04 final RC üzerinde koşmadı |
| 02 | `02-real-clone-migration.md` | Aşama 05 | **VAR** — gerçek veri klonu 0034→0087, 14/14 değişmez |
| 03 | `03-real-clone-golden-ui.md` | Aşama 06 | **VAR** — aynı klonda 36/36 spec, kapı 24/24 |
| 04 | `04-security.md` | Aşama 04/06 türevi | YOK — final RC güvenlik kanıtı toplanmadı |
| 05 | `05-real-backup-restore.md` | Aşama 07 | **VAR — PARTIAL** — gerçek kaynaktan yedek/restore/zamanlama VERIFIED; yalnız off-device FİZİKSEL hedef BLOCKED |
| 06 | `06-financial-correctness.md` | Aşama 08 | YOK — birleşik deterministic golden fixture paketi yok |
| 07 | `07-observability.md` | Aşama 09 | **VAR** — alert delivery (kalıcı JSONL log + isteğe bağlı Telegram/e-posta), zamanlanmış gözetim işi (KAYDEDİLMEDİ), kapı 33/33 |
| 08 | `08-performance.md` | Aşama 10 | YOK — route/write SLO kanıtı yok |
| 09 | `09-cutover-rehearsal.md` | Aşama 11 | **VAR** — final RC provası koştu: golden-fingerprint 14/14, restore-drill 9/9 (5 kapı YES, golden-ui 36 passed), B5 environment shadowing + B6 code/schema pairing gerçekten enjekte edildi, B1–B6 karar tablosu 20 satır |
| 10 | `10-pr-master.md` | Aşama 12 | YOK — PR açılmadı, master promote edilmedi |
| 11 | `11-master-ci.md` | Aşama 13 | YOK — master CI green kanıtı yok |
| 12 | `12-cutover-receipt.md` | Aşama 15 | YOK — gerçek A–L cutover kapanmadı |
| 13 | `13-post-cutover.md` | Aşama 16 | YOK |
| 14 | `14-shadow-accounting.md` | Aşama 17 | YOK |
| 15 | `15-controlled-pilot.md` | Aşama 18 | YOK |
| 16 | `16-usage-validation.md` | Aşama 19 | YOK |
| 17 | `17-operational-resilience.md` | Aşama 20 | **VAR — PARTIAL** — 12/12 runbook (`docs/ops/`) 10 bölümlük formatla yazıldı, komutları doğrulandı; salt-okuma kanıt koşuları geçti; kimlik satırı P2'si kapatıldı. **Second-operator drill YAPILMADI — ikinci bir insan gerekiyor** |
| 18 | `18-final-scorecard.md` | Aşama 21 | YOK |

**Mevcut slot sayısı: 7/19** (00 SCAFFOLD; 02 ve 03 gerçek veri klonunda; 05 PARTIAL — off-device fiziksel hedef BLOCKED; 07 PASS; 09 PASS; 17 PARTIAL — second-operator drill eksik). Slot 05'in satırı Aşama 07 turunda güncellenmemişti, dosyanın gerçek durumuna göre düzeltildi.

## İndeks dışı ek dosyalar (§32 listesinde yok, bu turda zorunlu oldular)

| Dosya | Neden | Durum |
|---|---|---|
| `00-real-db-drift-manifest.md` | §10 (Aşama 05) "gerçek baseline değiştiyse önce yeni read-only manifesti göster; açıklanmayan drift = STOP" ön koşulu | **VAR** |
| `01-feature-freeze-reconfirmation.md` | §6 (Aşama 01) feature freeze yeniden teyidi | **VAR** |

**Numara çakışması uyarısı:** `01-feature-freeze-reconfirmation.md`, §32'deki `01-ci-hardening.md`
slotunun yerine geçmez. İki dosya farklı şeylerdir; `01-ci-hardening.md` slotu hâlâ boştur.

## Bu klasörün `docs/release-evidence/*.md` ile ilişkisi

Üst klasördeki mevcut kanıt dosyaları (`faz3-golden-ui-smoke.md`, `faz5-migration-procedure.md`,
`faz6-restore-drill.md`, `faz7-cutover-rehearsal.md`, `cutover-checklist.md`, …) **silinmez ve
geçersiz sayılmaz**; ancak hepsi gap-closure öncesi HEAD'lerde ve büyük çoğunluğu
`DISPOSABLE_SYNTHETIC` veri sınıfında üretilmiştir. Final paketin dosyaları, dondurulmuş
`RC_SHA` üzerinde ve rehberin istediği veri sınıfında **yeniden** üretilmek zorundadır.

## Statü kaynağı

Faz bazlı düzeltilmiş statüler ve YAML metadata: `PROGRESS.md` →
"Gap Closure Rehberi — yürütme kaydı (2026-08-25)".
