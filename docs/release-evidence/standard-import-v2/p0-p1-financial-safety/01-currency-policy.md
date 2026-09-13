# 01 — V2.0 para birimi politikası: çek ve kredi yalnız TRY

## Karar

```
Checks and loans are imported into the finance domain only when currency = TRY.
Non-TRY rows are preserved in staging and require review.
Multi-currency finance aggregation/conversion is NOT implemented in V2.0.
```

Bu **geçici bir sürüm sınırıdır**, kalıcı bir ürün kararı değil.

## Neden — depolama desteği ≠ toplama desteği

Migration 0090 `checks.currency` ve `loans.currency` kolonlarını ekledi. Kolonun varlığı
satırın para birimini **saklayabilmek** demektir; o satırın toplamlara **güvenle
girebileceği** anlamına gelmez.

Bu iki tablo üzerinde çalışan finans okuma modelleri para birimi ayrımı yapmıyor:

| tüketici | kaynak |
|---|---|
| vade akışı (`maturity` CTE) | `checks` ∪ `loan_installments` |
| `due30` | `sum(amount) filter (where due_date … and direction='outflow')` |
| kalan tutar | `sum(li.amount) where status <> 'paid'` |
| aylık kırılım | `sum(amount) filter (where amount is not null)` group by ay |

Hiçbirinde `currency` yok, hiçbirinde kur dönüşümü yok.

## Ölçülen tehlike

`pnpm import:currency-safety:v2` · adım A — importer atlanarak doğrudan yazma:

| kayıt | tutar | para birimi |
|---|---|---|
| çek 1 | 10.000 | TRY |
| çek 2 | 1.000 | USD |

`loadFinanceDashboard(pool, "2026-09-04")` →

```
due30 = 11000
openChecks = 2
```

**11.000 diye bir tutar yok.** 10.000 TRY ile 1.000 USD toplanamaz; toplansaydı bile kur
gerekirdi. Üstelik sayının yanlış olduğu ekranda görünmez — bu, sessiz finansal hata.

## Uygulama

| | davranış |
|---|---|
| TRY satır | `checks` / `loans` tablolarına yazılır |
| TRY dışı satır | domain'e **yazılmaz** |
| TRY dışı satır | ham hâliyle `import_rows.row_json` içinde **korunur** (sessiz düşürme yok) |
| TRY dışı satır | `unsupported_currency_for_finance_aggregation`, **yüksek şiddet**, satır `rejected` |
| şablon | `02_CEKLER` ve `03_KREDILER` açılır listesinde yalnız `TRY` |
| parser | USD/EUR/GBP değerlerini yine de **okur** |

Son satır önemli: parser'ı daraltmak, dışarıdan gelen bir dosyadaki USD çeki "okunamadı" diye
YANLIŞ SEBEPLE reddetmek olurdu. Kullanıcının hatası yok; sistemin sınırı var ve mesaj bunu
söylüyor:

> Bu sürüm çek ve kredi toplamlarını yalnız TRY için güvenli biçimde hesaplar. USD kayıt
> kaynakta KORUNMUŞTUR, ancak finans KPI'larına aktarılmamıştır — karışık para birimlerini
> toplamak yanlış bir toplam üretirdi.

Bunun için sözleşmeye `enumValues` (parser'ın okuduğu) ile `templateValues` (şablonun sunduğu)
ayrımı eklendi.

## Kanıt — adım B

Kanonik fixture (TRY + USD çek, TRY + EUR kredi) import edildi; sonra **aynı fixture'ın TRY
dışı satırları çıkarılmış hâli** import edildi.

| | karışık kaynak | TRY-only kaynak |
|---|---|---|
| `remainingAmount` | 71.744,12 | 71.744,12 |
| `due30` | 0 | 0 |
| `openChecks` | 2 | 2 |
| `activeLoans` | 1 | 1 |
| aylık kırılım | (aynı) | (aynı) |

**Birebir aynı.** TRY dışı satırların dosyada olması hiçbir finans sayısını değiştirmedi.

Diğer ölçümler:

- TRY dışı çek/kredi domain kaydı: **0**
- Kaynakta korunan TRY dışı satır: **2**
- Açılan inceleme: **2**, ikisi de `high`
- İnceleme mesajı sebebi söylüyor: **evet**

9/9 kontrol geçti.

## Kapsam sınırı

Bu kısıt **yalnız** `02_CEKLER` ve `03_KREDILER` içindir. Genel bir para birimi yasağına
çevrilmedi: `bank_transactions`, `invoices`, `budget_lines`, `fx_positions` ve
`cash_accounts` kendi para birimi sözlüklerini korudu. `13_FX_POZISYONU` zaten tanım gereği
TRY kabul etmiyor (`fx_positions.currency <> 'TRY'`).

## Geriye dönük uyumluluk

- 0090 kolonları **kaldırılmadı**; `not null default 'TRY'`.
- Mevcut satırlar TRY olarak kalır — sistem onları zaten TRY sayıp hesaplıyordu; NULL bırakmak
  geçmişi olduğundan belirsiz gösterirdi.
- Legacy importer davranışı değişmedi (legacy yolun hiçbir dosyasına dokunulmadı).

## Açık teknik borç

```
MULTI_CURRENCY_FINANCE_ANALYTICS = NOT_IMPLEMENTED
```

Kalıcı çözüm: kur tarihçesi, belirlenmiş dönüşüm politikası (hangi tarihin kuru, hangi kaynak)
ve okuma modellerinin para birimi boyutuyla yeniden yazılması. Bu, import katmanının işi değil
ve bu turda **bilerek yapılmadı**.
