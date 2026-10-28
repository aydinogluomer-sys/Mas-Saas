# Etkileşim Denetimi — Kapanış Devri

**Durum:** KAPALI. Kapsam genişletme durduruldu.
**Devir tarihi:** 2026-08-27
**Branch:** `release/production-readiness-hardening`
**HEAD:** `0a2087a` + bu kapanış commit'i
**Uzak branch'e göre:** 2 commit ileri, 0 geri · `origin/master`'a göre 54 ileri, 0 geri

---

## 1. Kapanış kararı ve gerekçesi

Etkileşim çalışması burada sınırlandırıldı. Yeni mutation / export / ui-state testi **yazılmadı**.

Kalan **557 UNTESTED**, Gap Closure Rehberi'nde bulunmayan, bu denetim sırasında **ortaya
çıkarılmış** yeni ve geniş bir kalite hedefidir. Bu yüzden:

- **İzlenen kalite borcu** olarak kaydedildi — bilinen ürün hatası ya da yeni bir P0 değil.
- Cutover'ın kabul kriteri **yapılmadı**; rehberin kapsamını sessizce büyütmek olurdu.
- `interaction:gate:strict` çalışmaya devam ediyor ama **bloklamıyor**: borcun büyüklüğü her
  koşuda görünür kalsın diye.

Bu ayrım koda, CI'a, baseline'a ve rapora **yazılı olarak** işlendi — bir sonraki kişi
"strict kırmızı, demek ki cutover olamaz" sonucuna varamasın diye.

---

## 2. Ölçülen son durum

Kaynak: `docs/interaction-audit/coverage-report.json` (son tam koşu, 2026-08-27 14:10).

```
Interactive controls discovered: 2135
PASS:                          1578
FAIL:                             0
UNTESTED:                       557
manifestoda karşılığı olmayan:    0
```

| Sınıf | PASS | UNTESTED |
|---|---:|---:|
| navigation | 1564 | 0 |
| mutation | 12 | 120 |
| ui-state | 2 | 414 |
| export | 0 | 23 |

Tam koşu kanıtı: crawl 2135 çift / 5 rolün **beşi de geçerli** / 0 sorun · 13 Playwright testi
yeşil (authz 2, flows 4, mutations 6, navigation 1) · gezinme 78/78 ayrık href, 7749 birim.

---

## 3. Kapanış koşusunun sonuçları

Bu devir belgesinin yazıldığı ağaç üzerinde:

```
pnpm lint        PASS   (0 uyarı)
pnpm typecheck   PASS
pnpm test        PASS   (59 dosya, 1321 test)
pnpm build       PASS   (BUILD_ID ij6vNhXILCMrrgMF_VD3n)

pnpm interaction:gate          YEŞİL    — kapsam gerilemedi (BLOKLAYICI kapı)
pnpm interaction:gate:strict   KIRMIZI  — UNTESTED=557 (BLOKLAMAZ, kalite hedefi)
```

> Etkileşim kapısı, diskteki mevcut kanıt ve envanter dosyalarını okur. Yeniden ölçmek için sıra:
> `pnpm interaction:crawl` → `pnpm interaction:test` → `pnpm interaction:gate`.
> Bu üçü çalışan bir production sunucusu ve **harcanabilir** veritabanı ister.

---

## 4. Bloklayıcı olan / olmayan

**Cutover'ı bugün bloklayan etkileşim koşulları — üçü de bugün temiz:**

| Koşul | Bugünkü değer |
|---|---|
| `FAIL > 0` | **0** |
| Manifestoda karşılığı olmayan kontrol | **0** |
| Ratchet gerilemesi (`UNTESTED > 557` veya `PASS < 1578`) | gerileme yok |

**Bloklamayan:** `interaction:gate:strict` (UNTESTED=557). Cutover sonrası sertleştirme hedefi.

---

## 5. Korunan commitler (bu oturum)

| SHA | İçerik |
|---|---|
| `5e6bdb8` | Runtime port guard + temiz-checkout referans testi |
| `ec7663a` | `package.json` script referansları izlenen dosyaları göstermek ZORUNDA |
| `ae06f82` | Preload-aware crawler (`[data-initial-preload]` beklemesi) |
| `b83706c` | Ratchet / strict ayrımı + baseline + 13 birim testi |
| `371adf1` | Büyük evidence dosyaları git'ten çıkarıldı, CI artifact'e taşındı |
| `df4ae6f` | Altı yüksek riskli mutasyon akışı (parametrik) |
| `0a2087a` | Mutasyon vakaları tekrarlanabilir; 1561→1578 PASS, 561→557 UNTESTED |

Yedisi de yalnız kendi dosyalarına dokunuyor; başka bir oturumun performans WIP'i
**karıştırılmadı** (`git show --stat` ile doğrulandı).

---

## 6. Kalan kalite borcu — sonraki turun iş listesi

Hepsi manifestoda **sınıflandırılmış**; eksik olan testlerin kendisi.

| Sınıf | Kalan | Yazılacak test | Not |
|---|---:|---|---|
| `ui-state` | 414 | `shell.spec.ts` | Komut paleti, kenar çubuğu, grafik zoom/dönem/seri, tablo sıralama, sayfalama, kolon seçici, filtreler. Ortak bileşen davranışı parametrik test edilip kanıt eşleşen bütün satırlara bağlanmalı — 414 kopya test **değil**. |
| `mutation` | 120 | `mutations.spec.ts` genişletmesi | Kredi oluşturma, senaryo kaydetme, brifing, hatırlatıcı, onay/ret maker-checker, kullanıcı/rol yönetimi, içe aktarım. Vaka tablosuna satır eklemek yeterli; kanıt zinciri hazır. |
| `export` | 23 | `exports.spec.ts` | CSV parse, XLSX programatik açma, PNG/SVG/PDF imza doğrulaması. "Download event oluştu" PASS sayılmamalı. |

Ayrıca hiç başlanmayanlar: çift tıklama / idempotency, hata durumu UX testleri, statik envanter ↔
manifesto CI karşılaştırması.

### Sonraki tur için üç uyarı (ölçülmüş)

1. **Fixture sözlüğü ürünün sözlüğüyle ayrışıyor.** Çek durumu `cleared` (`settled` değil),
   düğmeler yalnız `planned`'da çıkar, vade alanı `maturity_date` (`due_date` değil),
   `action_items` owner-scoped. Yeni vaka eklerken önce şemayı ve durum kümesini **oku**.
2. **Duruma bağlı kontroller taramada görünmeyebilir.** `signatureFor` yerine DOM geri düşümü
   devrede; kanıt envanterde karşılığı yoksa hiçbir birime düşmez — yani UNTESTED'i hak etmeden
   düşürmez. Bu bilerek böyle.
3. **Ön yükleme perdesi her tam sayfa yüklemesine ~20 sn ekliyor.** Tam tarama ~75 dakika sürer
   ve 60 dakikalık oturum boşta kalma sınırını aşar; bu yüzden crawler rol başına oturumu
   tazeliyor. Süre bütçesi planlanırken hesaba katılmalı (`MAS_IX_SLOW=1`).

---

## 7. Bu oturumda ürüne dokunulmayan, ama RAPORLANAN bulgu

`8007887` (feat: preload workspace routes on startup) her **tam sayfa yüklemesinde** tam ekran,
opak, `z-index: 200` bir perde gösteriyor ve kapanana kadar altındaki her kontrolün tıklamasını
yakalıyor.

Üretim derlemesinde ölçüldü (admin oturumu, `127.0.0.1:3310`):

```
SSR HTML'inde data-initial-preload:  VAR (status 200)
perde kapanma süresi:                20.0 sn
perde beklemeden tıklama:            ENGELLENDİ (locator.click: Timeout 4000ms exceeded)
```

Süre **sabit bütçedir**, veriye bağlı değil: `waitForResourceQuiet(minimumWaitMs)` bir MİNİMUM
dayatır (ilk parti ≥ 4000 ms, sonraki her parti ≥ 700 ms, 60 rota / 3'lü parti).

**Sonuç:** `/payments`'i yer imine ekleyip açan bir kullanıcı, hiçbir şeye tıklayamadan ~20 sn
bekliyor. Bu, projenin kendi performans bütçesiyle ("sıcak modül geçişleri 50-100 ms") gerilim
hâlinde: soğuk açılışta 20 sn bloklayıp sıcak geçişleri hızlandırıyor.

**Karar sahibi o feature'ın yazarıdır.** Ürüne dokunulmadı; yalnız ölçüm araçları perdeyi
bekleyecek şekilde düzeltildi. Değerlendirilebilecek üç yön (karar bende değil):
`pointer-events: none`, minimum bekleme bütçesinin kaldırılması, ya da perdenin yalnız ilk
oturum açılışında gösterilmesi.

---

## 8. Bu oturumda YAPILMAYANLAR (bilerek)

- **P24B keşfi çalıştırılmadı.** Gerçek `mas_radar_dev` üzerinde hiçbir yazma yapılmadı.
- **Fixture temizliği çalıştırılmadı.**
- **Off-device yedek alınmadı.**
- **Push yapılmadı.** 2 commit yerelde bekliyor.
- **Başka bir oturumun performans WIP'ine dokunulmadı** (aşağıdaki liste).

---

## 9. Çalışma ağacında dokunulmayan WIP

Bunlar **bana ait değil**; sahipliği doğrulanmadan commit edilmemeli.

**Değiştirilmiş (izlenen):**
`docs/release-evidence/final-production-readiness/08-performance-trend.jsonl` ·
`pnpm-lock.yaml` · `scripts/prepare-runtime.ts` ·
`src/app/(dashboard)/finance/checks/page.tsx` · `src/app/(dashboard)/finance/page.tsx` ·
`src/app/(dashboard)/finance/receivables/page.tsx` ·
`src/app/(dashboard)/insights/briefing/page.tsx` ·
`src/app/(dashboard)/payments/loading.tsx` · `src/app/(dashboard)/payments/page.tsx` ·
`src/components/charts/analytics-chart.tsx` · `src/components/ui/module-tabs.tsx` ·
`src/lib/briefing/engine.ts` · `src/lib/financing/engine.ts` · `src/lib/radar/queries.ts`

**İzlenmeyen:**
`bot.py` · `scripts/qa/_probe-authz.ts` · `.navigation-run-clean.json` ·
`.testsprite-nav-run.json` · `.next-preload-dev/` · `.next-preload-final/` ·
`.next-preload-verify/` · `.next-pre-speed-release-20260826/` ·
`docs/release-evidence/final-production-readiness/HANDOFF-2026-08-27.md` ·
`docs/release-evidence/final-production-readiness/p24b-discovery/`

`bot.py` ve `scripts/qa/_probe-authz.ts` kaynağı doğrulanmadan commit edilmemeli.
`.next-*` ve navigation/test JSON çıktıları yeniden üretilebilir; commit edilmemeli.

---

## 10. TestSprite — BLOCKED

```
testsprite --version   0.3.0          OK
testsprite auth status  key_7f6a6f1b4d37, scopes tam    OK
hedef URL: https://intervals-murphy-ultimately-levitra.trycloudflare.com
curl → Could not resolve host          ÇÖZÜMLENMİYOR
```

Kayıtlı trycloudflare tüneli ölü. TestSprite yalnız **herkese açık** bir hedefe karşı
çalışabildiği için bu tur **BLOCKED** olarak raporlanıyor; localhost'a karşı çalışmış gibi
gösterilmedi. Devam için canlı ve erişilebilir bir hedef URL gerekiyor.

---

## 11. Sıradaki kritik yol (bu belgeden sonra)

Etkileşim çalışması bu hattın **dışında**:

```
Çalışma ağacını stabilize et
→ P24B footprint'i SALT OKUNUR tamamla
→ off-device yedek
→ açık kullanıcı onayı
→ fixture temizliği
→ final RC
→ branch CI
→ PR/master
→ master CI
→ cutover
```
