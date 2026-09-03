# P1 — kod değişikliği

Değişen yüzey **tek bir koşul**. Değişen dosya sayısı: 1 (+1 yeni test dosyası).

```
src/lib/radar/engine.ts                        +22 / -5   (22 satırın 17'si yorum)
src/lib/radar/generate-instances-audit.test.ts  yeni
```

## Kusur

`generateInstancesForMonthWithClient` denetim satırını **koşulsuz** yazıyordu:

```ts
    created += res.rowCount ?? 0;
  }
  await audit(client, {
    actor: actorId, action: "generate_instances", entityTable: "payment_instances", entityId: null,
    before: null,
    after: { monthStart: monthStartISO, created, total: payments.rowCount },
  });
```

Tek başına zararsız görünüyor: ayda bir satır. Ama çağrı zinciri şu:

```
pnpm start
└─ scripts/prepare-runtime.ts:32   runAsSystem(() => ensureWindow(pool, bugün, actorId, 24))
   └─ engine.ts:434                for (delta = -1; delta <= 24)      → 26 ay
      └─ engine.ts:410             generateInstancesForMonth
         └─ engine.ts:354          generateInstancesForMonthWithClient
            └─ engine.ts:397       audit(...)  ← koşulsuz
```

Pencere zaten doluyken 26 çağrının 26'sı da `created = 0` döner ve yine de 26 satır yazılır.

Gerçek veritabanında ölçüldü (P24B Attempt-04, `mas_radar_dev`, 2026-09-03):

```
payment_instances   502 → 502     (INSERT 0, UPDATE 0)
audit_logs          788 → 814     (+26)
```

Sıfır iş için 26 kayıt. Bu, denetim kaydını olayların değil **sunucu açılışlarının** kaydına
çeviriyordu.

## Düzeltme

```ts
  if (created > 0) {
    await audit(client, {
      actor: actorId, action: "generate_instances", entityTable: "payment_instances", entityId: null,
      before: null,
      after: { monthStart: monthStartISO, created, total: payments.rowCount },
    });
  }
```

Prompt'un tercih ettiği minimal semantik seçildi (§7): `created = 0` → kayıt yok,
`created > 0` → kayıt **bit-bazında eskisiyle aynı**. §8'deki tek-özet-olay alternatifine
gerek kalmadı; mevcut mimari bu koşulu hiçbir sözleşmeyi kırmadan taşıyor.

## Dokunulmayanlar

```
ensureWindow ufku (24 ay)          değişmedi
payment instance üretim mantığı    değişmedi
risk flag mantığı                  değişmedi
tarih / ay semantiği               değişmedi
audit() yardımcısı                 değişmedi (dosyaya hiç dokunulmadı)
aktör kimliği / runAsSystem / RLS  değişmedi
P24B kodu                          değişmedi
denetim sistemi geneli             değişmedi
```

## Kırılabilecek bir sözleşme var mıydı?

Arandı: `generate_instances` audit **sayısına** bağlı hiçbir test veya script yok.
`src/lib/audit.test.ts` bu action'ın *şeklini* kullanıyor ama test ettiği şey `audit()`
yardımcısının parametre eşlemesi — bu değişiklik o dosyaya dokunmuyor.

## Testin dişleri var mı?

Negatif kontrol yapıldı: `git stash` ile düzeltme geri alındı, aynı test dosyası tekrar
koşuldu.

```
düzeltme YOKKEN:  3 düştü / 1 geçti
  CASE A  FAIL — beklenen [], gelen 1 audit
  CASE C  FAIL — beklenen [], gelen 26 audit      ← kusurun kendisi
  CASE D  FAIL — beklenen 1, gelen 26
  CASE B  PASS — doğrusu bu: düzeltme denetimi susturmamalı
düzeltme VARKEN:  4/4 geçti
```
