# 00 — Final Release Candidate manifesti (AŞAMA 02)

**ORIGINAL PLAN REFERENCE:** Gap Closure Rehberi §7 (AŞAMA 02)
**Durum:** RC **DONDURULDU** — 2026-08-25

---

## RC manifesti

```yaml
rc_sha:             b8c3244385b0213ba998232853f963a372fa09a3
master_base:        093573e30f451bb8857bed777352e80838e2e80e
migration_latest:   0087
migration_count:    87
workflow_sha:       71fe76249b8555ab2a57bdffb81302b7b07f3d8b5f0428acde9641b17bd2699e
package_lock_hash:  6b5bea20daf0ebedfed498f34507e3fbd8efaa6c515d4171c22cd0e7db93263b
postgres:           16.14 (Debian 16.14-1.pgdg13+1)
node:               v26.3.0
pnpm:               11.10.0
```

| Alan | Nasıl ölçüldü |
|---|---|
| `rc_sha` | `git rev-parse HEAD` |
| `master_base` | `git rev-parse master` — release dalı master'dan **33 commit** önde, **0 geride** |
| `migration_latest` / `migration_count` | `supabase/migrations/*.sql` diskten sayıldı; gerçek DB ledger'ı ile birebir (87/0087) |
| `workflow_sha` | `sha256sum .github/workflows/ci.yml` |
| `package_lock_hash` | `sha256sum pnpm-lock.yaml` |
| `postgres` | `docker exec mas-radar-pg postgres --version` |

---

## RC_SHA neden bu commit — döngüsellik ve çözümü

Rehber §7 "son gap kapandığında dondur" diyor. Ama Aşama 11–14 kendi **kanıt** commit'lerini
üretiyor, dolayısıyla saf bir okuma "RC hiç donmaz" sonucunu verirdi.

Uygulanan kural:

> **RC_SHA = ürün veya test kodunu değiştiren son commit.**
> Ondan sonraki yalnız-kanıt (`docs/`, `PROGRESS.md`) commit'leri RC'yi geçersiz kılmaz,
> çünkü test edilen artefaktı değiştirmezler.

Bu oturumun commit'leri, dokunduğu dosya sınıfına göre:

| Commit | kod/test | docs | Aşama |
|---|---:|---:|---|
| `d5012da` | 0 | 2 | 00–03 statü düzeltmesi |
| `ec95de0` | 0 | 1 | aşama defteri |
| `f72f3ce` | 1 | 1 | 05–06 gerçek klon kapısı |
| `5ea4945` | 2 | 1 | 08 finansal golden fixture |
| `1623b3f` | 5 | 0 | QA bulguları (exposureBy, eşik testleri, vitest flake) |
| `58c2eeb` | 10 | 4 | 07 gerçek yedek/restore |
| `694328b` | 9 | 2 | 09 observability |
| `5883b5e` | 11 | 1 | 10 performans |
| `ca6e47a` | 5 | 1 | 11 cutover provası |
| `aa2fbd2` | 0 | 1 | aşama defteri |
| **`b8c3244`** | **1** | 0 | **route-slo CI düzeltmesi — RC_SHA** |

---

## RC_SHA değişirse ne yeniden koşar (rehber §7 madde 4)

`b8c3244`'ten sonra ürün veya test kodu değişirse aşağıdakilerin **tamamı** yeniden
değerlendirilir. Yalnız-kanıt commit'leri bunu tetiklemez.

```text
AŞAMA 04  hardening branch clean CI          — 7/7 zorunlu, final RC head_sha ile
AŞAMA 05  fresh REAL clone migration + fingerprint
AŞAMA 06  aynı REAL clone üzerinde Golden UI + parasal spot-check
AŞAMA 07  gerçek kaynak backup/restore
AŞAMA 11  final RC cutover provası (başarı yolu + B1–B6 enjeksiyonları)
AŞAMA 13  master clean-runner CI
```

---

## RC'nin taşıdığı kanıt

| Aşama | Sonuç | Kanıt dosyası |
|---|---|---|
| 05 gerçek klon migration | **PASS** — 0034→0087, 16/16 iddia, 6/6 parasal toplam korundu | `02-real-clone-migration.md` |
| 06 gerçek klon Golden UI | **PASS** — 24/24 rota, 6/6 parasal, 6/6 yetkilendirme | `03-real-clone-golden-ui.md` |
| 07 gerçek yedek/restore | **PARTIAL** — 46/47; off-device fiziksel hedef donanım eksikliğinden BLOCKED | `05-real-backup-restore.md` |
| 08 finansal doğruluk | **PASS** — 96/96, 51 elle türetilmiş vaka, QA 28/28 bağımsız | `tests/financial/` |
| 09 observability | **PASS** — 33/33, altı sinyal çift yönlü, teslimat arızası ayrı exit kodu | `07-observability.md` |
| 10 performans | **PARTIAL** — `perf:gate` 10/10 sert; rota SLO bu hostta geçersiz (bellek açlığı) | `08-performance.md` |
| 11 cutover provası | **PASS** — başarı yolu RC'de yeniden koşuldu; B5+B6 gerçekten koşuldu | `09-cutover-rehearsal.md` |

---

## Ortam notu — kanıtın parçası

Ölçümlerin alındığı host bellek baskısı altındaydı (7.9 GB toplam, ölçüm anlarında
**0.2–1.4 GB boş**), ve yükün ~1 GB'ı bu projeyle **ilgisiz** bir vite dev sunucusundan
geliyordu. Deterministik kapılar (sorgu planı, sorgu sayısı, migration değişmezleri,
fingerprint) bundan etkilenmez ve etkilenmedi. Etkilenen yalnız wall-clock SLO sayılarıdır;
onlar rehber §15 uyarınca zaten trend kanıtı olarak sınıflandırılmıştır ve
`08-performance.md` bu bağlamı taşır.

**NEXT GATE:** AŞAMA 04 — final RC ile hardening branch clean CI
