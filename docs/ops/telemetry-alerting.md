# Telemetri alarm teslimatı ve zamanlaması (AŞAMA 09)

Rehber §14 (`MAS_SaaS_Production_Readiness_Gap_Closure_Rehberi.md`) tek cümleyle şunu söylüyor:

> Ama "script exit 1 veriyor" tek başına production alerting sayılmaz.

Bu belge, alarmın operatöre **nasıl ulaştığını** ve periyodik koşunun **nasıl açılacağını** anlatır.

## 1. Kanallar

| Kanal | Durum | Nerede |
|---|---|---|
| **Yerel kalıcı alert log** | **Her zaman açık — birincil** | `logs/alerts.jsonl` (`MAS_ALERT_LOG` ile değiştirilebilir) |
| Telegram | İsteğe bağlı | `MAS_ALERT_CHANNELS=log,telegram` + `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` |
| E-posta (HTTP ucu) | İsteğe bağlı | `MAS_ALERT_CHANNELS=log,email` + `EMAIL_API_URL` + `EMAIL_TO` (+ `EMAIL_API_KEY`) |

Birincil kanalın yerel dosya olması bilinçli: bu makinede dışa ağ yok ve hiçbir kanal kimlik
bilgisi tanımlı değil. Ağ kanalını birincil yapmak, alarmın her koşuda "iletilemedi" demesi —
yani hiç alarm olmaması — anlamına gelirdi. `log` kanalı `MAS_ALERT_CHANNELS` ile **kapatılamaz**;
yazılmasa da listeye eklenir.

Ağ kanalları yalnız **gerçek bir uyarı varken** denenir. Her koşuda "her şey yolunda" bildirimi
göndermek, kanalı sessize alınacak hâle getirir.

## 2. Alert log biçimi

JSONL — her satır bağımsız bir kayıt (`backups/daily-runs.jsonl` ile aynı desen).

```jsonc
{"ts":"…","runId":"…","kind":"alert","signal":"backup_age_hours","section":"DB",
 "severity":"P1","value":"YEDEK YOK","threshold":"eşik 36s","message":"…"}
{"ts":"…","runId":"…","kind":"delivery","channel":"log","ok":true,"message":"kanal log: iletildi"}
{"ts":"…","runId":"…","kind":"heartbeat","message":"telemetri tamam — uyaran sinyal yok"}
```

- `alert` — bir sinyal eşiği aştı. `severity` rehber §31 sınıflandırması (P0/P1/P2).
- `delivery` — **her kanal denemesinin sonucu**, başarısız olanlar dâhil. Teslimat başarısızlığı
  yalnız çıkış kodunda kalmaz; kalıcı olarak buraya da yazılır.
- `heartbeat` — uyarı yokken yazılır. Sessiz bir log "sorun yok" ile "toplayıcı hiç koşmadı"yı
  ayırt edemez; heartbeat bu ikisini ayırır.

`logs/` **gitignore'dadır**: içerik operasyonel veridir (hangi hesap kilitli, hangi içe aktarım
bayat, veritabanı ne kadar büyük) ve depoya ait değildir.

## 3. Çıkış kodları

`pnpm ops:telemetry` ve `pnpm ops:telemetry:watch`:

| Kod | Anlam |
|---|---|
| 0 | Uyarı yok, teslimat tamam |
| 1 | Uyarı var **ve teslim edildi** |
| 2 | **ALARM TESLİMATI BAŞARISIZ** — alarm borusu kırık; bir uyarının kendisinden daha kötüdür |
| 3 | (yalnız `watch`) anlık görüntü hiç koşamadı — hiçbir şey bilmiyoruz |

Teslimat başarısızlığının ayrı bir kod alması kasıtlıdır: "uyarı var" (1) ile "uyarıları kimse
göremeyecek" (2) aynı arıza değildir.

## 4. Zamanlama

Rehber §14'ün istediği dört kontrol — telemetry snapshot, backup-age, stale-data, queue —
tek işte koşar: `scripts/ops/telemetry-watch.ts`.

```bash
# elle bir koşu
pnpm ops:telemetry:watch

# zamanlanmış görevi İNCELE (hiçbir şey kaydetmez — varsayılan what-if)
pnpm ops:telemetry:schedule status
pnpm ops:telemetry:schedule install

# GERÇEKTEN kaydet (operatör kararı)
pnpm exec tsx scripts/ops/schedule-windows.ts install --job telemetry --apply
pnpm exec tsx scripts/ops/schedule-windows.ts uninstall --job telemetry --apply
```

Varsayılan periyot **07:00'den itibaren 6 saatte bir**. Günde bir koşu, takılı bir kuyruğu
24 saat görmeden bırakırdı; kuyruk süpürücüsü 30 dakikada bir çalışıyor.

Görev **KAYITLI DEĞİL** olarak bırakılmıştır. Zamanlanmış görev kalıcı ve dışa dönük bir sistem
değişikliğidir; kaydı operatör açıkça ister (Aşama 07'deki yedek görevi ile aynı politika).

Koşu kayıtları: `logs/telemetry-runs.jsonl` · son anlık görüntü: `logs/telemetry-latest.json` ·
görev çıktısı: `logs/telemetry-watch-task.log`.

## 5. Sır politikası

Alarm çıktısına sır yazılmaz. İki katman:

1. **Şekil maskeleme** — parolalı bağlantı dizesi, `/bot<token>/`, `Bearer …`, `token=…`
   kalıpları `***` ile değiştirilir.
2. **Değer maskeleme** — ortamda tanımlı olan gerçek sır değerleri (Telegram token'ı, e-posta
   anahtarı, bağlantı dizeleri) tam eşleşmeyle maskelenir.

Kapı bunu her koşuda doğruluyor: `pnpm ops:telemetry:alerting:verify` tüm stdout'u ve yazılan
her alert log dosyasını tarar ve tarayıcının kör olmadığını pozitif kontrolle kanıtlar.

## 6. Kapılar

```bash
# uyarı ateşliyor mu / temizleniyor mu (Faz 12)
MIGRATION_DATABASE_URL=…mas_radar_telemetry_verify pnpm ops:telemetry:verify

# uyarı bir yere ULAŞIYOR mu + zamanlama (AŞAMA 09)
MIGRATION_DATABASE_URL=…mas_radar_alerting_verify pnpm ops:telemetry:alerting:verify
```

İkisi de **harcanabilir** bir veritabanı ister (`verify`, `test`, `clone`, … işaretlerinden biri).
`mas_radar_dev` hedef olarak reddedilir.
