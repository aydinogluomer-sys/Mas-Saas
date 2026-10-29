# 02 — Dalga 0 kod karantinası ve sağlamlaştırma

```text
branch        : wave0/stabilize (master 04b605d'den)
pre-wave0     : tag quarantine/pre-wave0-2026-10-28 (= 04b605d; incelenmemiş katman 46541d8 dahil)
reviewed base : af210fd
date          : 2026-10-28 / 2026-10-29
DB class      : NONE — kod dalgasında hiçbir veritabanı komutu çalıştırılmadı
final status  : PASS (yerel kapı) — CI koşmadı (GitHub faturalama engeli)
diff vs master: 278 dosya, +13.526 / −20.457
```

## Yöntem

Yöntem dört adımdan oluştu:

1. **Haritalama:** 7 salt-okunur haritacı, 180 dosyalık katmanı dosya ve satır düzeyinde haritaladı; toplam 334 eylem çıktı.
2. **Uygulama:** 7 dilim tek çalışma ağacında **sırayla** uygulandı. Her dilim kendi kontrollerini koştu ve kendi commit'ini attı.
3. **Kalite kapısı:** tip kontrolü, lint, tüm testler ve sınır doğrulaması.
4. **Bağımsız inceleme ve düzeltme:** dört yönden inceleme yapıldı (güvenlik, finansal bütünlük, eksiksizlik/regresyon, operasyon). Orta ve üstü önemdeki her bulguyu ayrı bir ajan çürütmeye çalıştı; çürütülemeyenler düzeltildi.

Bu süreçte ağ hatası (`ENOTFOUND`) iki ajanı düşürdü:

- **Planlayıcı:** dilimler arası çelişkileri orkestratör çözdü (R1–R13).
- **S6:** yarım iş yama olarak saklandı. Yeni ajan bu yarım işi incelenmemiş taslak gibi satır satır denetleyip tamamladı.

## Commit'ler

| Dilim | Commit | Ne |
|---|---|---|
| S1 operasyon | `7bb2c56` `470fbaa` `d3fe015` | Native PG yedek zinciri (`MAS_PG_RUNTIME`). Salt-okunur `ensure` yoklaması, açılışta migration yok. Servis kurulum betiği. Sertleştirilmiş zamanlamalar, çalıştırma kılavuzu. Docker ve Linux deploy betikleri kaldırıldı. Docker bağdaştırıcısı CI için bayt bayt aynı. |
| S2 güvenlik | `568b739` | ERP köprüsü, Telegram mini-app, webhook ve onay düğmeleri kaldırıldı. Middleware'de tek istisna kaldı. `db.ts` rol hatasında kapanıyor. Oturum önbelleği kalktı. `requireApiSession`, `checkOrigin`. Telegram asistanı kapalı-varsayılan ve viewer katmanında. Derleme hata baypası kaldırıldı. |
| S3 uydurma rakam | `88e68c9` | Kokpit, zincirler ve 11 motor kaldırıldı. 4 sahte widget kaldırıldı. Copilot ve gatekeeper karantinada. Asılsız iddialar düzeltildi. R10'un dört noktası düzeltildi. |
| S4 önbellek ve önyükleme | `b2ad48c` `5d11263` | Rol-kör süreç içi önbellek tümüyle kaldırıldı. 60 rotalık tam önyükleme ve hover/focus önyüklemesi kaldırıldı. |
| S5 Import V2 | `ff0aeb3` `4919f67` `9136ddf` | Formül hatası `null` + `formula_error` (HIGH). Birleştirilmiş hücre yalnız ana hücreden okunuyor + `merged_cell` (MEDIUM). Asenkron iş yalnız önizleme yapıyor. Phase 5: hiçbir kolon kaldırılmadı (R9 temkinli kural). |
| S6 korunanlar | `63b6039` `20c5322` `4de958f` `8ab367e` `eef1d7e` | Zorunlu parola değişimi her katmanda çalışıyor (0096). `rotate-passwords` denetimli. Dağıtıcı sistem aktörüyle çalışıyor. Önbelleklemeyen kill-switch SW. Supabase betikleri ve `measure-routes` arka kapısı silindi. |
| S7 görünüş | `529ec6d` `148e352` `98b519d` | Restyle `af210fd`'ye döndü. Genel test zaman aşımı yok; yavaş testlere adlı süre sınırları. |
| Kapı | `4fd1623` | İki arka kapı ölçüm betiği silindi (`measure-auth-routes`, `run-lighthouse`). |
| Denetim | `0ae0231` | FIN-01, FIN-02, KR-08, OPS-1 düzeltildi; SEC-01 kontrol listesi eklendi. |

## Kapı (son durum)

```text
typecheck        : 0 hata
lint             : 0 hata / 0 uyarı
vitest           : 107 dosya / 2.143 test — hepsi geçti
boundary:verify  : 8/8
çıkış taramaları : kaldırılan 10 dizin yok · src/'de varsayılan sır ve zincir sabiti yok ·
                   next.config.ts'te ignoreBuildErrors yok · db.ts SET ROLE hatasını yayıyor ·
                   izlenen dosyada pooler.supabase.com yok
```

Not: Kapı sırasında bir tam test koşusu işletim sistemi bellek tükenmesiyle düştü (iki işçi + bir alt süreç). Sebep kod değil ortamdı; aynı dosya tek başına ve tam takım yeniden yeşil geçti.

## Bağımsız inceleme

- 4 incelemeci 23 bulgu üretti. Orta ve üstü önemdekiler ayrı ajanlarca çürütülmeye çalışıldı. Sağ kalan 7 bulgunun 5'i kodla düzeltildi; 2'si (SEC-01, FIN-03) kontrol listesine ya da ileri migration'a bırakıldı:
  - **FIN-01 / FIN-01 eşi:** Telegram `/hareket` 200+ harekette eski hareketleri gösteriyordu.
  - **FIN-02:** brifing nakit kutusu yanlış para biriminin tabanıyla kıyaslıyordu.
  - **KR-08:** "şifre değişimi zorla" düğmesi etkileşim manifestosunda yoktu.
  - **OPS-1:** migration ön yedeğinde sürüm uyumu kontrolü atlanıyordu.
  - **SEC-01:** kaldırılan yazma yollarının iz kontrolü. Salt-okunur kontroller koşuldu; sonuçlar `01-…` §9'da, hepsi 0.
  - **FIN-03:** bilinmeyen açılış bakiyesi 0 sayılıyor. **Ertelendi:** 0001–0096 dondurulmuş, ileri migration gerekiyor. Gerçek veride 6/6 aktif hesabın açılışı bilinmiyor.
- 16 düşük önemli not doğrulanmadan backlog'a alındı: `docs/todo.md` "Dalga 1 backlog".

## Çalıştırılmayanlar (dürüst kayıt)

- **GitHub CI:** hesap faturalama engeli; işler başlamıyor.
- **Playwright** (etkileşim kapısı, `legacy-semantic-smoke`, görsel 23 taban) ve DB'li `phase*:verify` koşuları: kod dalgası DB'siz kuralla yürüdü. Tek kullanımlık bir veritabanında koşturulmaları Dalga 1'in ilk işi.
