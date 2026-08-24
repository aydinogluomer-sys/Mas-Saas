# Branch protection — kullanıcının tıklayarak uygulayacağı adım listesi

**Durum: KULLANICI EYLEMİ + PLAN KARARI BEKLENİYOR.**

## GÜNCELLEME (2026-08-25) — özellik ücretsiz planda KAPALI, bu yüzden Claude yine uygulayamaz

`gh` bu turda yetkilendirilmiş durumda, dolayısıyla mevcut durumu doğrudan sorgulayabildim.
Sonuç, önceki "sadece tıkla" varsayımını **geçersiz kılıyor**:

```
$ gh api repos/:owner/:repo/branches/master/protection
  → HTTP 403: "Upgrade to GitHub Pro or make this repository public to enable this feature."
$ gh api repos/:owner/:repo/rulesets
  → HTTP 403: "Upgrade to GitHub Pro or make this repository public to enable this feature."
```

Yani bu **özel (private) repo + ücretsiz plan** kombinasyonunda **ne klasik branch protection ne de
repository rulesets mevcut**. Aşağıdaki tıklama adımları doğrudur ama Settings → Branches ekranı
plan yükseltilene kadar kuralı **kaydettirmez**. Bu, Claude'un `gh` ile de yapamayacağı bir şeydir:
eksik olan yetki değil, **plan**.

**Kullanıcının kararı (üç seçenek):**

| Seçenek | Sonuç | Not |
|---|---|---|
| **A. GitHub Pro/Team'e yükselt** | Branch protection + rulesets açılır; aşağıdaki adımlar aynen uygulanır | Özel repo korunur; küçük aylık ücret |
| **B. Repoyu public yap** | Özellik ücretsiz açılır | **ÖNERİLMEZ** — bu depo finansal iş verisi/mantığı içerir; `data/` ve `backups/` gitignore'lu ama geçmiş/kod açığa çıkar |
| **C. Branch protection'sız devam et** | Kapı yok; disiplin commit geçmişine ve tek-maintainer akışına dayanır | Kanıt zinciri yine commit'lerde; ama "master'a doğrudan push" teknik olarak mümkün kalır |

**Bu, Faz 1'in CI kapısını bloke etmez.** CI'ın yedi job'lu yapısı çalışıyor ve yeşil (bkz.
status-notes.md, Faz 1 kapanışı). Branch protection ayrı bir **yetki/merge politikası** katmanıdır;
"CI yeşil" ile "master korumalı" iki ayrı ölçüttür ve ayrı ayrı raporlanır. Aşağıdaki adımlar
yalnızca **A veya B seçildikten sonra** uygulanabilir hâle gelir.

---

### (Tarihsel) İlk not — gh yetkisizken

Bu ayarı Claude uygulamamalı çünkü branch protection bir **yetki kararıdır**, kod değişikliği değil:
kimin neyi merge edebileceğini belirler, dolayısıyla depo sahibinin kendi hesabıyla yapması doğrudur.
Yukarıdaki plan-kısıtı bulgusu bunun üstüne, artık teknik olarak da imkânsız olduğunu ekliyor.

---

## Ön koşul — önce CI bir kez gerçekten koşmalı

GitHub, required check listesine yalnız **daha önce en az bir kez çalışmış** check adlarını
önerir. Sıra ters çevrilirse (önce zorunlu kılıp sonra ilk koşuyu beklemek) her PR, hiç çalışmamış
bir check'i beklerken kilitlenir.

Doğru sıra:

1. `release/production-readiness-hardening` push edildi ✔ (yapıldı)
2. GitHub Actions sekmesinde yedi job'ın koştuğunu gör
3. **Ondan sonra** aşağıdaki adımları uygula

---

## Tıklama adımları

1. Depoda **Settings** sekmesine gir.
2. Sol menüden **Branches**.
3. **Branch protection rules** altında **Add branch protection rule** (varsa `master` kuralını
   **Edit**).
4. **Branch name pattern** kutusuna yaz:

   ```text
   master
   ```

5. Şu kutuları işaretle:

   | Kutu | İşaret |
   |---|---|
   | Require a pull request before merging | ✅ |
   | &nbsp;&nbsp;↳ Require approvals (`1`) | ✅ |
   | &nbsp;&nbsp;↳ Dismiss stale pull request approvals when new commits are pushed | ✅ |
   | Require status checks to pass before merging | ✅ |
   | &nbsp;&nbsp;↳ Require branches to be up to date before merging | ✅ |
   | Do not allow bypassing the above settings | ✅ |
   | Allow force pushes | ❌ (kapalı kalacak) |
   | Allow deletions | ❌ (kapalı kalacak) |

6. **Require status checks** kutusunun altındaki arama alanına şu **yedi adı tek tek** yaz ve
   çıkan öneriden seç:

   ```text
   static
   database-migration
   runtime-role-security
   phase-verifies
   build
   e2e-authz
   legacy-semantic-smoke
   ```

   Adlar `.github/workflows/ci.yml` içindeki job anahtarlarıyla **birebir** aynıdır. GitHub
   required check'i job **adıyla** eşleştirir; buradaki bir yazım farkı sessizce "hiçbir check
   zorunlu değil" anlamına gelir.

7. Sayfanın altındaki **Create** (veya **Save changes**) düğmesine bas.

---

## Neden bu kutular

| Ayar | Neden |
|---|---|
| PR zorunlu | Planın 1.2 maddesi: doğrudan `master` geliştirme yok. |
| Require branches up to date | İki PR ayrı ayrı yeşilken birleşince `master` kırmızı olabilir; CI'ın hiç görmediği kombinasyon merge edilmiş olur. |
| Dismiss stale approvals | Onaylanan diff ile merge edilen diff aynı olmalı. |
| Force push kapalı | Kanıt zinciri commit geçmişine dayanıyor (plan 1.2). |
| Deletions kapalı | Branch silinmesi kanıtı yok eder. |
| Bypass yok | Admin bypass'ı açık bırakmak kuralı tavsiyeye çevirir (plan 4.4). |

---

## Yapıldığında nasıl doğrulanır

Kullanıcı (ya da `gh` yetkilendirildiğinde Claude) şunu çalıştırır:

```bash
gh api repos/:owner/:repo/branches/master/protection \
  --jq '{checks: .required_status_checks.contexts,
         strict: .required_status_checks.strict,
         force_push: .allow_force_pushes.enabled,
         deletions: .allow_deletions.enabled,
         enforce_admins: .enforce_admins.enabled}'
```

Beklenen çıktı:

- `checks` → yukarıdaki yedi adın tamamını içerir
- `strict` → `true`
- `force_push` → `false`
- `deletions` → `false`
- `enforce_admins` → `true`

Web arayüzünden doğrulamak isteyen için: Settings → Branches → `master` kuralında yedi check
adının listelendiği ve "Do not allow bypassing" kutusunun işaretli olduğu görülür.
