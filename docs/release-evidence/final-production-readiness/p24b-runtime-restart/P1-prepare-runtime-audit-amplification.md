# P1 — prepare-runtime `generate_instances` audit amplification

**Durum: AÇIK. Bu turda kod DEĞİŞTİRİLMEDİ (§21 gereği bilinçli).**

## Mevcut davranış

`scripts/prepare-runtime.ts` her uygulama açılışında `ensureWindow(pool, bugün, actorId, 24)`
çağırıyor. 24 aylık ufuk 26 pencere çağrısına dönüşüyor ve **her çağrı, `created = 0` olsa
bile** bir `audit_logs` satırı yazıyor.

```
startup basina audit_logs artisi : +26   (action = generate_instances)
is verisi artisi                  :   0   (payment_instances 485 -> 485, users 0)
olculdugu yer : mas_radar_postcleanup_runtime_verify klonu, RUN1 ve RUN2
```

## Neden P1, neden şimdi değil

Bu bir veri bozulması değil; append-only bir denetim izi. Ama her açılışın 26 anlamsız
denetim satırı bırakması, denetim kaydını gerçek olayların değil restart sayısının kaydına
çeviriyor — P24B soruşturmasında audit_logs'u okumayı zorlaştıran şeylerden biri buydu.

Aynı turda hem kodu değiştirip hem gerçek startup ölçmek kanıt zincirini karıştırırdı:
gerçek açılışın etkisini **izole** biçimde görmek istiyoruz. Bu yüzden yama ayrı commit'e.

## Önerilen çözüm (uygulanmadı)

İkisinden biri:

1. Yalnız `created > 0` olduğunda audit yaz — sıfır iş yapan çağrı iz bırakmasın.
2. Tüm pencere üretimi için **tek** özet audit olayı yaz (kaç pencere, kaç satır üretildi).

İkincisi tercih edilir: "hiç iz yok" ile "26 iz" arasında, "1 anlamlı iz" doğru cevaptır.

## Doğrulama ölçütü

Yama sonrası art arda iki `pnpm start`:

```
audit_logs delta (RUN1) : <= 1
audit_logs delta (RUN2) : <= 1
payment_instances delta :    0
users delta             :    0
```

İlgili: `docs/release-evidence/final-production-readiness/p24b-post-cleanup/`
(`07-prepare-runtime-writer-inventory`, `08`/`09-clone-prepare-runtime-run1/2`)
