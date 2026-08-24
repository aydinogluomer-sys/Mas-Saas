# Branch protection — recommendation for `master`

**Faz 1 çıktısı. Bu bir ÖNERİDİR; GitHub ayarı bu çalışmada DEĞİŞTİRİLMEDİ.**

Bu belge kasten "yapıldı" demiyor. Repository ayarlarını değiştirmek bu görevin kapsamı
dışındaydı ve kapsam dışı bırakılması doğru: branch protection, kimin neyi merge edebileceğini
belirleyen bir yetki kararıdır, kod değişikliği değil. Depo sahibinin bilerek ve kendi
hesabıyla uygulaması gerekir. Aşağıdakiler uygulanacak ayarların tam listesidir.

---

## 1. Required status checks

`Settings → Branches → Branch protection rules → master → Require status checks to pass`

Aşağıdaki **yedi** check adı zorunlu işaretlenmeli. Adlar `.github/workflows/ci.yml`
içindeki job anahtarlarıyla birebir aynıdır — GitHub required check'i job **adıyla** eşleştirir,
yani buradaki bir yazım farkı sessizce "hiçbir check zorunlu değil" anlamına gelir:

```text
static
database-migration
runtime-role-security
phase-verifies
build
e2e-authz
legacy-semantic-smoke
```

Ek olarak **"Require branches to be up to date before merging"** açılmalı. Açılmazsa iki PR
ayrı ayrı yeşilken, birleştikten sonra `master` kırmızı olabilir — CI'nın hiç görmediği bir
kombinasyon merge edilmiş olur.

## 2. Merge politikası

| Ayar | Değer | Neden |
|---|---|---|
| Require a pull request before merging | AÇIK | Planın 1.2 maddesi: doğrudan `master` geliştirme yok. |
| Require approvals | ≥ 1 | Tek operatörlü depoda bile ikinci bir okuma, finansal invariant değişikliklerinde ucuz sigortadır. |
| Dismiss stale approvals on new commits | AÇIK | Onaylanan diff ile merge edilen diff aynı olmalı. |
| Allow force pushes | **KAPALI** | Planın 1.2 maddesi force push'u yasaklıyor; kanıt zinciri commit geçmişine dayanıyor. |
| Allow deletions | **KAPALI** | Delete protection tercihen açık (plan 4.4). |
| Require linear history | opsiyonel | Zorunlu değil; squash ile kanıt zincirini yok etmek yasak olduğu için merge commit tercih edilebilir. |
| Do not allow bypassing the above settings | AÇIK | "Required checks bypass edilmez" (plan 4.4). Admin bypass'ı açık bırakmak kuralı tavsiyeye çevirir. |

## 3. Bu ayarların ne zaman anlamlı olduğu

Required check listesi ancak **CI en az bir kez gerçek runner'da yeşil koştuktan sonra**
etkinleştirilmeli. Sırası ters çevrilirse — önce zorunlu kılıp sonra ilk koşuyu beklemek —
her PR, henüz hiç çalışmamış bir check'i beklerken kilitlenir.

Doğru sıra:

1. `release/production-readiness-hardening` push edilir.
2. Yedi job'ın gerçek runner'da sonucu görülür.
3. Kırmızı olan varsa düzeltilir (bu, Faz 1'in PASS kriteridir: `failed jobs = 0`).
4. **Ondan sonra** required check listesi işaretlenir.

## 4. Bu belgenin doğrulanması

Ayarlar uygulandıktan sonra kanıt olarak şu komutun çıktısı release evidence'a eklenmeli
(depo sahibinin kendi token'ıyla):

```bash
gh api repos/:owner/:repo/branches/master/protection \
  --jq '{checks: .required_status_checks.contexts,
         strict: .required_status_checks.strict,
         force_push: .allow_force_pushes.enabled,
         deletions: .allow_deletions.enabled,
         enforce_admins: .enforce_admins.enabled}'
```

Beklenen: `checks` yukarıdaki yedi adı içerir, `strict = true`, `force_push = false`,
`deletions = false`, `enforce_admins = true`.
