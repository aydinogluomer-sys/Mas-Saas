# Manuel kimlikli smoke — kontrol listesi

Runtime **çalışıyor**: <http://localhost:3000> · release `f076431`

Kendi mevcut hesabınızla tarayıcıdan giriş yapın. Bu liste **yalnız okuma** kontrolüdür —
hiçbir kayıt oluşturmayın, değiştirmeyin, silmeyin, onaylamayın, ödeme işaretlemeyin.

Her satır için dört şeye bakın:

- **OPENED** — sayfa açıldı mı
- **NO_5XX** — sunucu hatası ekranı yok
- **NO_INFINITE_LOADING** — yükleniyor iskeletinde takılı kalmıyor
- **DATA_VISIBLE** — ekranda gerçek veri görünüyor (boş/placeholder değil)

| # | Adım | OPENED | NO_5XX | NO_INFINITE_LOADING | DATA_VISIBLE |
|---|------|:------:|:------:|:-------------------:|:------------:|
| 1 | `/login` ile giriş | ☐ | ☐ | ☐ | — |
| 2 | `/overview` | ☐ | ☐ | ☐ | ☐ |
| 3 | `/cashflow` | ☐ | ☐ | ☐ | ☐ |
| 4 | `/payments` | ☐ | ☐ | ☐ | ☐ |
| 5 | `/payments/calendar` | ☐ | ☐ | ☐ | ☐ |
| 6 | `/finance` | ☐ | ☐ | ☐ | ☐ |
| 7 | `/data/quality` | ☐ | ☐ | ☐ | ☐ |
| 8 | `/search` — bir arama yapın | ☐ | ☐ | ☐ | ☐ |
| 9 | `/insights` ve `/analytics` | ☐ | ☐ | ☐ | ☐ |
| 10 | Çıkış yapıp tekrar giriş | ☐ | ☐ | ☐ | — |

## Beklenen değerler (ekranda görürseniz doğrulama)

```
ödeme örneği (payment_instances)   502
ödeme (payments)                    19
kullanıcı                           13
açık görev (task_status.open)        4
ödenmemiş toplam                    13.595.000 TRY
```

## Yapmayın

```
kayıt oluşturma / düzenleme / silme        HAYIR
ödeme işaretleme, onay verme                HAYIR
içe aktarma (import) çalıştırma             HAYIR
yedek / temizlik / migration tetikleme      HAYIR
```

Bunlar veritabanına yazar ve bu turun sıfır-delta kanıtını geçersiz kılar.

## Bir şey ters giderse

Ekran görüntüsü alın ve hangi adımda olduğunu not edin. Sunucu logları:

```
C:\Users\Trade Bilisim\Mas-Saas-RC-f076431\logs\runtime\mas-runtime.out.log
C:\Users\Trade Bilisim\Mas-Saas-RC-f076431\logs\runtime\mas-runtime.err.log
```

## Runtime'ı durdurmak isterseniz

Kontrollü durdurma prosedürü `05-supervision.json` içinde adım adım yazılı.
Kısaca: PID **4640** (`next start`), üst süreç **21544**, supervisor **24868**.
Supervisor çıkarken stdout log'una `MAS runtime END exit=<kod>` satırını yazar.

## Not — kimlik bilgisi

Bu tur gerçek veritabanına **test kullanıcısı eklemedi** ve sizden parola
**istemedi/yazmadı/loglamadı**. Giriş yalnız sizin kendi mevcut hesabınızla,
kendi tarayıcınızda yapılacak.
