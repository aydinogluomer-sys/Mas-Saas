# 10 — READY FOR CUTOVER board (AŞAMA 14)

**ORIGINAL PLAN REFERENCE:** Gap Closure Rehberi §19 (AŞAMA 14) · orijinal §20 (L1681–L1696)
**RC_SHA:** `b8c3244385b0213ba998232853f963a372fa09a3`
**Tarih:** 2026-08-25

> Rehber §19: *"Bir tane bile boşsa: `NOT READY FOR CUTOVER`. Weighted skor bunu override edemez."*

---

## KARAR

```text
NOT READY FOR CUTOVER
```

**Sebep: iki açık P0.** Onbir maddenin dokuzu PASS. İkisi donanım ve operatör kararı bekliyor;
ikisi de kod eksikliği değildir ve ikisi de kod yazarak kapatılamaz.

---

## Board

| # | Madde | Durum | Kanıt |
|---|---|---|---|
| 1 | golden exact-clone production migration PASS | **PASS** | `02-real-clone-migration.md` — gerçek 0034 anlık görüntüsünden 0087'ye, 16/16 iddia, altı parasal toplam birebir korundu, migration 0056 senaryosu gerçek veride |
| 2 | clean-runner branch CI PASS | **PASS** | run `32895317098`, `head_sha = b8c3244`, **7/7 job success**, 0 başarısız adım |
| 3 | master CI PASS | **BLOCKED** | Aşama 12 (PR→master) §17 ön koşulu `P0 = 0` sağlanmadığı için başlatılmadı |
| 4 | critical legacy UI real-clone PASS | **PASS** | `03-real-clone-golden-ui.md` — 24/24 kritik rota, gerçek oturum, QA bypass KAPALI |
| 5 | Phase17–38 E2E 100% | **PASS** | CI `e2e-authz` job, `phase17-38-routes.spec.ts` |
| 6 | monetary spot-check 100% | **PASS** | 6/6 test (10 parasal büyüklük), owner SQL bağımsız referans — UI ile aynı yükleyiciden türetilmedi |
| 7 | backup restore-proven | **PASS** | `05-real-backup-restore.md` — beş kapı YES; saklanan kopyanın **kendisinden** restore kanıtlandı |
| 8 | **off-device backup ready** | **FAIL — P0** | Bu makinede fiziksel olarak ayrı hiçbir hedef yok |
| 9 | runbook rehearsal PASS | **PASS** | `09-cutover-rehearsal.md` — başarı yolu RC'de yeniden koşuldu; B1–B6 enjeksiyonu, B5/B6 gerçekten çalıştırıldı |
| 10 | **P0 = 0** | **FAIL** | İki açık P0, aşağıda |
| 11 | P1 = 0 | **PASS** | Açık P1 yok |

---

## Açık P0'lar — ikisi de sizin kararınızı bekliyor

### P0-1 — OFF_DEVICE fiziksel hedef yok

```text
DURUM   : Araç zinciri VERIFIED, fiziksel hedef BLOCKED
ÖLÇÜM   : Yalnız C: (DriveType 3, sabit disk). Çıkarılabilir sürücü yok,
          bağlı ağ paylaşımı yok (`net use` boş), eşitleme klasörü yok.
RİSK    : Diski, makineyi veya şifreleyen bir yazılımı kaybeden senaryoda
          yedeğin TEK kopyası da kaybedilir. Tek kopya yedek değildir.
KAPATMA : Harici disk takın / NAS paylaşımı bağlayın, sonra:
          setx MAS_OFFDEVICE_BACKUP_DIR "E:\mas-yedek"
          pnpm ops:backup:offdevice
          Araç hedefi SINIFLANDIRIR: sabit disk yolu LOCAL_STANDIN döner ve
          hiçbir koşulda offDeviceSatisfied=true üretemez (rehber §30.5 kodda).
NOT     : Gerçek finansal veri hiçbir dış servise gönderilmedi ve bulut
          yükleme uydurulmadı — proje kuralı.
```

### P0-2 — DRIFT-01: gerçek DB'de doğrulama fixture'ları

```text
DURUM   : OPEN
SATIRLAR: 4 kullanıcı  p24b_fixture_a, p24b_fixture_b, p24b_mk_mujyy6, p24b_op_9bcmx5
          1 ödeme     7b300bfe-944f-468b-91fa-2de65b7cfee5
NE ZAMAN: 2026-08-25 10:09–10:10 UTC (bu oturumdan ÖNCE)
SINIF   : Rehber §31 — "real DB fixture write" = P0
ETKİ    : payments sayısı 19 -> 20. checks/loans/cashflow_months DEĞİŞMEDİ.
KAPATMA : Gerçek DB'de DELETE gerekir. Bu YIKICI bir gerçek-DB işlemidir ve
          bilerek yapılmadı — sizin açık kararınıza bırakıldı.
DİKKAT  : `atilla` (admin, 10:17 UTC) bir fixture DEĞİL, gerçek operatör
          hesabıdır ve SİLİNMEMELİDİR.
```

---

## Kapanan boşluklar — bu oturumun bilançosu

| Aşama | Önce | Sonra |
|---|---|---|
| 03 Golden UI | CONDITIONAL PASS (sentetik) | **VERIFIED PASS** (gerçek veri klonu) |
| 05 Migration | CONDITIONAL PASS | **VERIFIED PASS** (0034→0087 gerçek veride) |
| 06 Backup/restore | CONDITIONAL PASS | **PARTIAL** — 46/47, tek eksik donanım |
| 11 Financial correctness | PARTIAL | **VERIFIED PASS** — 96/96, 51 elle türetilmiş vaka |
| 12 Observability | PARTIAL/STRONG | **VERIFIED PASS** — 33/33, alarm teslimatı kanıtlı |
| 13 Operational resilience | PARTIAL | **PARTIAL** — runbook'lar arttı, ikinci operatör provası yok (Aşama 20) |
| 14 Performance | PARTIAL/STRONG | **PARTIAL** — sert kapı 10/10; wall-clock bu hostta geçersiz |

---

## Kapıları kurarken bulunan gerçek hatalar

Hiçbiri aranmıyordu; hepsi kapı yazılırken ortaya çıktı ve düzeltildi.

| # | Hata | Neden ciddi |
|---|---|---|
| 1 | Tam eşikte float toplama kritik gün uyarısını kaçırıyordu (`249999.99999999997 >= 250000` = false) | Nakit riski panosunda **kaçırılmış uyarı** |
| 2 | `auth_failures_24h` var olmayan bir audit satırını sorguluyordu — hiç ateşleyemezdi | "İzliyoruz" yanılsaması, izlememekten kötü |
| 3 | `roles-verify` gölgelenmiş kabukta **yanlış veritabanını** doğrulayıp 8/8 yeşil yakıyordu (18 vs 17 kullanıcı) | Güvenlik kapısının verebileceği en tehlikeli cevap |
| 4 | `restore-drill` canlı üretimi iki yoldan düşürebilirdi (cluster parolası + `.next` ezme) | Kanıt üreten aracın üretimi bozması |
| 5 | `route-slo` CI modunda çöküyordu | CI'ı kırmızı yapıyordu |
| 6 | Retention kuru koşusu gerçek DB yedeğini budanacaklar listesine koymuştu | Yedek kaybı |
| 7 | `distDir` kararının yan etkisi lint'i 4.393 hatayla kırmıştı | CI'ı kırıyordu |

---

## Sıradaki adımlar

**Aşama 12–13 (PR → master, master CI) başlatılmadı.** Rehber §17 ön koşulu `P0 = 0`
sağlanmıyor. Merge'ün kendisi geri alınabilir bir işlem olsa da, planın disiplinini
esnetmek bu çalışmanın bütün anlamını bozardı.

İki P0 kapandığında sıra: **12 → 13 → 14 (bu board tekrar) → 15 (gerçek cutover)**.

**Aşama 15 ayrıca sizin açık onayınızı gerektirir** — gerçek veritabanına üretim yazması.
Cutover'ın D/F/G/H adımlarının fiilen zaten yapılmış olduğunu unutmayın
(`00-real-db-drift-manifest.md`): gerçek DB 0087'de, uygulama `mas_radar_app` rolüyle
çalışıyor. Eksik olan bu durumun **kanıt paketi** ve A/B/E/I/J/K/L adımları.

**FINAL: NOT READY FOR CUTOVER — 9/11 PASS, 2 açık P0**
