# Governance waiver — branch protection (AŞAMA 03, Seçenek C)

Kaynak: gap-closure rehberi §8 (AŞAMA 03). Orijinal referans: agresif plan §4.4 Branch Protection
— **L530–L549**.

```yaml
document: governance-waiver
stage: "03"
option_taken: "C"
date: 2026-08-25
decided_by: repository owner (kullanici)
branch: release/production-readiness-hardening
head_commit: 685c20bc604d3f4c8d2185a04e4ae2044eb344c4
evidence_class: STATIC_SOURCE
target_db_name: none
target_db_class: none
real_db_write_used: NO
```

## Waiver metni (rehber §8 Seçenek C şablonu)

```text
ORIGINAL REQUIREMENT: branch protection / required checks
STATUS: APPROVED DEVIATION
REASON: repository/account policy decision
COMPENSATING CONTROLS:
  - no direct push by policy
  - PR required manually
  - exact PR URL evidence
  - exact CI run evidence before merge
  - no force push
  - merge commit/fast-forward history preserved
LIMITATION:
  GitHub does not technically enforce the above controls.
```

## Bu depoya özgü doldurma

### ORIGINAL REQUIREMENT

Orijinal plan §4.4'ün istediği dört madde:

```text
PR without merge = forbidden
required checks mandatory
force push disabled
delete protection preferred
```

Zorunlu required check listesi (§8, Seçenek A):

```text
static
database-migration
runtime-role-security
phase-verifies
build
e2e-authz
legacy-semantic-smoke
```

### STATUS

`APPROVED DEVIATION`.

Karar kaydı: `PROGRESS.md` → **"Karar kaydı — branch protection (2026-08-25)"**. Kullanıcı üç
seçenek arasından **Seçenek C**'yi seçti: GitHub planı yükseltilmeyecek, depo public
yapılmayacak, branch protection kurulmadan devam edilecek.

### REASON

`repository/account policy decision` — teknik bir eksiklik değil, plan/hesap kısıtı:

```text
$ gh api repos/:owner/:repo/branches/master/protection
  → HTTP 403: "Upgrade to GitHub Pro or make this repository public to enable this feature."
$ gh api repos/:owner/:repo/rulesets
  → HTTP 403: "Upgrade to GitHub Pro or make this repository public to enable this feature."
```

Ayrıntı, üç seçeneğin karşılaştırması ve tıklama adımları:
`docs/release-evidence/branch-protection-recommendation.md`.

Seçenek A (plan yükseltme) ve Seçenek B (repository ruleset) **aynı 403 nedeniyle bu depoda
uygulanamaz**; Seçenek B, A gerçekleşmeden teknik olarak mevcut değildir. Seçenek B'nin
"public yap" alternatifi, depo finansal iş verisi ve mantığı içerdiği için reddedildi.

### COMPENSATING CONTROLS — bu depodaki karşılıkları

| Kontrol | Bu depodaki uygulama | Doğrulanabilirlik |
|---|---|---|
| `no direct push by policy` | Hardening işleri `release/production-readiness-hardening` üzerinde; master'a doğrudan commit atılmadı (master `093573e`'de duruyor, 22 commit geride) | `git rev-parse master` |
| `PR required manually` | Master promotion yalnız AŞAMA 12'de PR ile yapılacak | PR açıldığında URL kanıtı |
| `exact PR URL evidence` | AŞAMA 12 kanıtı `final-production-readiness/10-pr-master.md` içine yazılacak | henüz yok |
| `exact CI run evidence before merge` | Faz 1 kapanışı bu disiplinle yapıldı: run **32785111779**, HEAD `2709491`, conclusion=success, 7/7 job yeşil, failed=0 | GitHub Actions run kimliği |
| `no force push` | Faz 0–7 ve 11/12/14/15 boyunca force-push / history rewrite hiç kullanılmadı | commit geçmişi lineer |
| `merge commit/fast-forward history preserved` | Branch master'dan **22 ileri / 0 geri**; rebase-üstüne-yazma yok | `git rev-list --left-right --count master...HEAD` |

CI'nın kendisi `on: push` ile çalışır; yani sinyal her itmede zaten üretilir. Eksik olan
**sinyalin varlığı değil**, GitHub'ın onu merge için zorunlu kılma yetkisidir.

### LIMITATION

```text
GitHub does not technically enforce the above controls.
```

Açık dille: yukarıdaki altı kontrolün tamamı **disipline** dayanır. GitHub tarafında hiçbiri
zorunlu değildir. Yetkili bir kimlik bugün master'a doğrudan push edebilir, kırmızı CI ile merge
edebilir veya force-push yapabilir; hiçbir sunucu tarafı kapı bunu engellemez. Bu waiver, riski
ortadan kaldırmaz — **görünür kılar ve sahiplendirir**.

## KRİTİK KURAL (rehber §8 "Kritik kural")

```text
Faz 1 exact-compliance = CONDITIONAL PASS
```

Seçenek C seçildiği için Faz 1, orijinal kritere **tam uyum** olarak kapatılamaz. Faz 1'in CI
mimarisi ve yedi job'lu yeşil koşusu geçerlidir; eksik olan governance katmanıdır.

**"Branch protection çözüldü" ifadesi bu depoda hiçbir belgeye yazılamaz.** Aynı şekilde
"master korumalı", "required checks aktif", "governance kapandı" gibi ifadeler de yasaktır.

Doğru ifade biçimi:

```text
DOGRU : branch protection = APPROVED DEVIATION (Secenek C waiver)
DOGRU : CI yesil, master korumasiz
YANLIS: branch protection cozuldu
YANLIS: governance tamam
```

`CI yeşil ≠ master korumalı` ayrımı geçerliliğini korur.

## Waiver ne zaman düşer

Aşağıdakilerden biri gerçekleşirse bu waiver iptal edilir ve Seçenek A uygulanır:

1. GitHub planı Pro/Team'e yükseltilir → §8 Seçenek A adımları aynen uygulanır, yedi required
   check tanımlanır, force-push ve branch silme bloklanır.
2. Depoya ikinci bir yazma yetkili katılır → tek-maintainer varsayımı düşer, disiplin kontrolü
   yeterli olmaktan çıkar.
3. Master'a doğrudan bir push tespit edilir → waiver'ın dayandığı davranışsal varsayım kırılır.

## Çapraz referanslar

- `docs/release-evidence/branch-protection-recommendation.md` — üç seçenek, 403 kanıtı, tıklama adımları
- `PROGRESS.md` → "Karar kaydı — branch protection (2026-08-25)" — kullanıcının Seçenek C kararı
- `PROGRESS.md` → "Gap Closure Rehberi — yürütme kaydı (2026-08-25)" → Faz 1 satırı — CONDITIONAL PASS
- `docs/status-notes.md` → "Kullanıcı eylemi bekleniyor (Faz 1)" madde 1 — kalan risk
