# Faz 4 — RBAC / RLS / güvenlik kanıtı

**Tarih:** 2026-08-24 · **Branch:** `release/production-readiness-hardening`
**DB sınıfı:** `DISPOSABLE_SYNTHETIC` — `mas_radar_security_verify`, izole cluster
(`mas-radar-pg-faz4-sandbox`, port 55435). Gerçek `mas_radar_dev`'e bağlantı **yok**.

**Toplam 90 güvenlik iddiası geçti:** 8 (roles) + 29 (roles-rls) + 36 (export-leakage) +
**17 (yeni security-matrix)**.

---

## 1. Neden yeni bir gate gerekti

Mevcut üç gate güçlüydü ama beş boşluk bıraktı. Boşluklar tahminle değil, mevcut assertion'lar tek
tek okunarak çıkarıldı:

| Plan | Boşluk |
|---|---|
| 7.1 | Kod↔DB otomatik karşılaştırması INSERT'i **her** tabloda yapıyordu, UPDATE/DELETE'i yalnız `payments`'ta. EXPORT ve SEARCH için hiç hücre yoktu. |
| 7.2 | Üç katman da vardı, **anlaştıklarını** hiçbir şey doğrulamıyordu. Guard ile DB arasındaki bağ elle yazılmış bir yorumdu — ve yorum, veritabanı kaydığında kırmızı vermez. |
| 7.3 | Oturum yaşam döngüsü uygulanmıştı ve **tamamen** doğrulanmamıştı; `public.sessions`'ın rol kopyası taşımadığı dâhil. |
| 7.4 | `getRawPool()` iki route dosyasında kontrol ediliyordu; depo genelinde hiçbir şey sabitlemiyordu. |
| 7.5 | Hiçbir tarama, her mutasyon yapan server action'ın kimlik doğruladığını kanıtlamıyordu. |

Yeni gate: `scripts/db/security-matrix-verify.ts` → `pnpm db:security-matrix:verify` (**17/17**),
CI'da `runtime-role-security` job'una eklendi.

## 2. Testimin iki kez yanıldığı, ürünün haklı çıktığı yerler

Bu iki düzeltme kayda değer, çünkü ikisi de "yanlış modeli assertion'a gömmenin" örneği.

**(a) GRANT ≠ yetki.** İlk sürüm `has_table_privilege()` ile `can()`'i karşılaştırdı ve **doğru kod
üzerinde** altı tabloda kırmızı verdi. Grant'lar sahiplik-kapsamlı tablolarda kasten **geniştir** —
bir katmanın INSERT grant'ı olmalıdır ki RLS sonra satırları sahibine daraltabilsin. Ölçüldü:
`viewer` `action_items` üzerinde INSERT grant'ı **taşıyor** ve insert yine de reddediliyor:

```text
new row violates row-level security policy for table "action_items"
```

Yetki = grant **VE** politika. Assertion, katmanın gerçekten *başarabildiği* sonuca çevrildi.

**(b) RLS sessizce reddeder, istisna atmaz.** İkinci sürüm UPDATE/DELETE'i istisna bekleyerek
ölçtü ve altı sağlıklı tabloyu "sızdırıyor" diye suçladı. RLS'te reddedilen bir UPDATE hata
vermez; `USING` hiçbir satırla eşleşmez ve ifade **0 satır** ile başarıyla döner.
`roles-rls-verify.ts` bunu `payments` üzerinde zaten öğrenmişti ("ETKİLENEN SATIR SAYISIYLA
doğrulandı, istisna beklenerek değil"); aynı okuma her yere uygulandı.

Sonuç: **443 deneme** (5 katman × 47 dolu tablo × 2 fiil), reddedilmesi gereken hiçbiri satır
oynatamadı. Pozitif kontrol: izinli kombinasyonlardan **145'i** gerçekten satır etkiledi — yoksa
"herkesi reddeden" bir veritabanı da bu testi geçerdi.

**(c) `canSeeModule` ≠ `canAccessRoute`.** İlk sürüm ikisini karşılaştırdı ve doğru kodda düştü:
farklı sorular soruyorlar. Modül menüsü modül düzeyinde, guard rota düzeyinde çalışır; `viewer`'a
Veri modülünün gösterilip içindeki `/data/approvals`'ın kapalı kalması **doğrudur**. Asıl yanıltıcı
olan durum assertion'a çevrildi: **bir modül, ancak içinde açılabilir en az bir rota varsa menüde
sunulur.** 45 (katman × modül) kombinasyonu geçti.

## 3. Oturum güvenliği (7.3) — canlı sunucuya karşı adversarial

Aynı çerez, DB elle değiştirilerek, çalışan production sunucusuna karşı:

| # | Senaryo | Sonuç |
|---|---|---|
| 1 | aktif viewer (pozitif kontrol) | `/overview` **200**, red kabuğu yok |
| 2 | viewer → kısıtlı rota | `/system/controls` **200 + red kabuğu** (sözle reddediliyor) |
| 3 | oturum **İPTAL** edildi | **307 → /login** |
| 4 | oturum **SÜRESİ DOLDU** | **307 → /login** |
| 5 | kullanıcı **PASİF** yapıldı | **307 → /login** |
| 6 | rol **YÜKSELTİLDİ** (aynı çerez) | `/system/controls` **200**, red kabuğu **yok** |
| 7 | rol **DÜŞÜRÜLDÜ** (aynı çerez) | `/system/controls` **200 + red kabuğu** |

Ek olarak DB seviyesinde, üretimdeki tam predicate'e karşı fixture'larla: iptal/süresi dolmuş/pasif
satırlar **0** döndü, geçerli satır **1** döndü (pozitif kontrol).

`public.sessions` kolonları: `created_at, expires_at, id, last_seen_at, revoked_at, token_hash,
user_id` — **rol kopyası yok**, bu yüzden 6 ve 7 numaralı satırlar mümkün. Atıl süre (idle timeout)
kodda sabitlendi (`IDLE_TIMEOUT_MS` + `revoked_at` güncellemesi); 60 dakika beklemek yerine
uygulandığı yer pinlendi — bu tek maddenin HTTP kanıtı yoktur.

Yan gözlem: `seed:demo` fixture'ında **aktif admin sayısı 0**. Migration 0031'in
`enforce_at_least_one_active_admin()` trigger'ı bu yüzden herhangi bir kullanıcı güncellemesini
reddediyor. Ürün kusuru değil — invariant görevini yapıyor; fixture'ın hiç admin'i yok.

## 4. 7.4 ve 7.5

- `getRawPool()` depo genelinde **yalnız** `src/lib/db.ts` (tanım) ve `src/lib/auth.ts` (kimlik
  çözme) içinde. Allowlist artık assertion; üçüncü bir dosya eklenirse gate kırmızı verir.
- Mutasyon yüzeyi: **API rotalarında değil**. Üç `route.ts` dosyasının üçü de yalnız `GET` export
  ediyor; bütün mutasyonlar server action. Next, yabancı Origin'li server-action çağrısını kendisi
  iptal ediyor (uçtan uca `phase16:verify` ile kanıtlı), yani CSRF/origin katmanı yerinde.
  Next'in veremeyeceği şey auth ve rol — onlar action'ın içinde olmalı: **30 server-action
  dosyasının tamamı** taranıyor.
- `checkOrigin()` çağırmayan mutasyon yapan API rotası **yok** (bugün hiç yok); assertion,
  eklenecek ilkinin sessizce atlamasını engellemek için duruyor.

## 5. Açık bulgu — P2, kapatılmadı

`src/app/(dashboard)/reminders/actions.ts` içindeki `scheduleRemindersAction` ve
`dispatchRemindersAction` **kimlik doğrulaması çağırmıyor**. Gate'te gerekçesiyle birlikte açık
istisna olarak kayıtlı (`AUTH_EXEMPT`), gizlenmedi.

**Neden P1 değil — tartışılarak değil ölçülerek:** üç katmandan ikisi yerinde duruyor.
`middleware.ts` çerezsiz her yolu reddediyor (server-action POST'u da sayfa yoluna gider, kapsam
içinde). `getPool()` katmanı `getDbContext()` üzerinden çözüyor; yok/iptal/süresi dolmuş/pasif
oturumların hepsi `EMPTY` → "katman yok" → hiçbir şey yazamaz. Engine `reminder_deliveries`
(sınıf `evidence`) yazıyor ve `can(viewer, reminder_deliveries, insert|update)` = false; yukarıdaki
443 denemelik tarama bu tabloyu da kapsıyor ve hiçbir katman oynatamadı. **Yetkisiz durum
değişikliği erişilebilir değil**; eksik olan temiz ret, reddin kendisi değil.

**Onaylandığında düzeltme:** iki action'a `await requireSession()` ve (dispatch Telegram mesajı
gönderdiği için) `finance_manager+` rol kontrolü. Bu turda **uygulanmadı** — ürün kaynağı ve bu
çalışmanın görevi ölçmekti, davranış değiştirmek değil.

## 6. Faz 4 PASS

> Plan: "Security checklist'te P0/P1 açık = **0**."

| Sınıf | Adet |
|---|---|
| **P0 açık** | **0** |
| **P1 açık** | **0** |
| P2 açık | 1 (yukarıdaki reminders borcu) |

**PASS.**
