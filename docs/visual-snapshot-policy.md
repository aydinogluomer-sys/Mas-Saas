# Görsel snapshot politikası

**Faz 2 §5.4 çıktısı.** Bu belge `pnpm test:visual:update` komutunun ne zaman çalıştırılabileceğini
tanımlar. Kısa versiyon: **kök neden açıklanmadan baseline güncellenmez.**

---

## 1. Neden bir politika gerekiyor

Bir snapshot testi kırmızıya döndüğünde iki farklı şey olmuş olabilir:

1. **Ürün bozuldu** — ekran gerçekten yanlış render ediyor.
2. **Harness bozuldu** — oturum düştü, veri fixture'ı değişti, ya da ekran kasten değiştirildi.

`--update-snapshots` ikisini de aynı şekilde "çözer": yeni görüntüyü doğru kabul eder. Bu yüzden
baseline güncellemesi bir *bakım işi* değil, bir *karardır*. Yanlış anda verilirse gerçek bir
regresyon kalıcı olarak "beklenen" hâline gelir ve bir daha hiçbir test onu yakalamaz.

Bu depoda bunun somut örneği yaşandı — aşağıdaki bölüm 4.

## 2. Güncelleme izni: altı koşulun TAMAMI

`pnpm test:visual:update` yalnız şu altısı birden doğruysa çalıştırılır:

- [ ] **route semantic smoke PASS** — `tests/visual/helpers/screen-ready.ts` kapısı yeşil:
      auth → route → heading → content → no error.
- [ ] **gerçek auth PASS** — storageState gerçek `/login` formundan üretildi, QA bypass yok.
- [ ] **veri fixture'ı deterministik** — aynı disposable DB, aynı seed, aynı satır sayıları.
- [ ] **screenshot bir insan tarafından incelendi** — diff görüntüsüne bakıldı, "yeşile döndü"
      yeterli değil.
- [ ] **değişiklik bilerek yapıldı** — hangi commit/karar bu görüntüyü değiştirdi, yazılı.
- [ ] **PR'da before/after görsel kanıt var.**

Bir tanesi bile eksikse baseline güncellenmez; test kırmızı bırakılır ve kök neden araştırılır.

## 3. Sıralamanın kendisi bir koruma

Her snapshot testi şu sırayı izler (§5.3):

```text
auth okay → route okay → heading okay → content okay → no error → then screenshot
```

Bu sıra, "hangi tür bozulma?" sorusunu **otomatik** cevaplar:

- Semantik adımlardan biri kırmızıysa → ürün ya da oturum bozuk. **Baseline'a dokunulmaz.**
- Semantik adımların hepsi yeşil, yalnız pixel farkı varsa → render/baseline deltası. Bölüm 2'deki
  altı koşul değerlendirilir.

`goto → screenshot` sırası bu ayrımı yapamaz: /login sayfası da gayet stabil bir PNG üretir.

## 4. Bu depoda gerçekten olan şey (kayıt)

Faz 2 sırasında ölçüldü:

- Üç spec `page.addInitScript(() => document.documentElement.setAttribute("data-vr", "1"))`
  çalıştırıyordu. `addInitScript` belgede `documentElement` daha yokken çalışır; script her sayfa
  yüklemesinde **"Cannot read properties of null (reading 'setAttribute')"** ile patlıyordu.
- Sonuç: `data-vr` **hiç set edilmedi**, `[data-volatile]` düğümleri her ekran görüntüsünde
  **görünür** kaldı.
- Yani mevcut baseline'ların tamamı zaman damgası/"bugün" rozeti içeriyor ve takvim değiştikçe
  kendiliğinden kayıyor.
- Kimse fark etmemişti çünkü eski spec'lerin hiçbiri `pageerror` dinlemiyordu.

Ölçüm (aynı sayfa, iki init script):

```text
BROKEN : data-vr=null  pageerrors=1  [data-volatile]=1 firstVisible=true
FIXED  : data-vr=1     pageerrors=0  [data-volatile]=1 firstVisible=false
```

**Bu, baseline'ları güncellemek için tek başına yeterli bir gerekçe DEĞİLDİR** — bölüm 2'deki
"insan inceledi" ve "before/after kanıt" koşulları hâlâ karşılanmalı. Faz 2 bu yüzden baseline'lara
dokunmadı; kök nedeni yazdı ve kararı insana bıraktı.

## 5. Baseline'lar platforma bağlıdır

Dosya adları `-chromium-win32` ile biter. Linux runner'da Playwright `-chromium-linux` arar ve
bulamaz. Bu, legacy görsel paketin neden CI release gate'inde **olmadığının** teknik nedenidir;
CI'daki semantik kapı (`legacy-semantic-smoke`) platformdan bağımsızdır ve orada çalışır.

Baseline'lar bir gün CI'da çalıştırılacaksa Linux baseline'ları ayrıca üretilmeli — Windows
baseline'ını Linux'ta "güncellemek" bölüm 2'yi ihlal eder.
