# Operasyonel kurtarma notları

Ölçülmüş, gerçekten yaşanmış arıza biçimleri ve bunlardan çıkış yolu. Rehber §30.6'nın kuralı
burada da geçerli: **yazılmış bir runbook, koşulmuş bir operasyon değildir** — her not, o notu
yazdıran gerçek olayla birlikte durur.

---

## OPS-01 — yarıda kesilen `legacy-repair:verify` depoyu derlenemez bırakır

**Sınıf:** P2 (operasyonel dayanıklılık). **İlk gözlem:** 2026-08-25, AŞAMA 07 çalışması.

### Mekanizma

`scripts/db/legacy-repair-verify.ts` bazı senaryoları kurmak için migration dosyalarını geçici
olarak **gizler**: dosyayı

```text
0087_assistant_conversations.sql
  → 0087_assistant_conversations.sql.hidden-for-legacy-repair-verify-<pid>-<epoch>
```

adına yeniden adlandırır ve koşu sonunda geri alır. Süreç bu iki adım ARASINDA öldürülürse
(Ctrl-C, zaman aşımı, çöküş) dosyalar gizli kalır. Ölçülen hâl: diskte **29** `.sql`, git'te
**87** dosya, `git status` **58 silinmiş dosya** gösteriyor.

Sonuç: `pnpm db:migrate`, `pnpm release:real-clone-gate` ve CI'ın tamamı düşer — çünkü ledger
sürüm kümesi ile disk dosya kümesi artık eşleşmez.

### YANLIŞ kurtarma

```bash
git checkout -- supabase/migrations/        # YAPMAYIN
```

Bu, 87 dosyayı geri yaratır ama `*.hidden-for-legacy-repair-verify-*` kopyaları **yerinde
kalır**: 87 gerçek + 58 takip edilmeyen artık dosya. Artıklar `real-clone-gate`'in
"ledger sürüm kümesi = disk dosya kümesi" iddiasını tökezletir ve bir sonraki okuyucuyu
"fazladan migration var" diye yanlış bir teşhise sürükler.

### DOĞRU kurtarma

Ekleri sıyırın — yeniden yaratmayın:

```bash
cd supabase/migrations
for f in *.hidden-for-legacy-repair-verify-*; do
  mv -- "$f" "${f%%.hidden-for-legacy-repair-verify-*}"
done
```

Sonra üç şeyi de KANITLAYIN:

```bash
git status --porcelain supabase/migrations/     # hiçbir şey yazmamalı
ls supabase/migrations/*.sql | wc -l            # 87 olmalı
ls supabase/migrations/ | grep -c hidden-for    # 0 olmalı
pnpm exec vitest run tests/financial            # ağaç hâlâ yükleniyor mu
```

### En önemli kural

**`supabase/migrations/` kirliyken COMMIT ALMAYIN.** Bu pencerede alınan bir commit, 58
migration'ı dalın kendisinden siler. Bu P0 sınıfı bir kazadır ve geri alınması, fark edilene
kadar geçen her commit'le zorlaşır.

### Önleme

- `legacy-repair:verify` uzun sürer (10 dakikadan fazla). Zaman aşımına düşecek bir kabuğun
  içinde koşturmayın; arka planda başlatıp bitmesini bekleyin.
- Koşu sırasında paralel olarak `db:migrate` / `real-clone-gate` / `stage07-backup-gate`
  çalıştırmayın: hem aynı container'da yarışırlar hem de migration dizini o sırada eksiktir.
- Bir kesinti olduysa ilk iş yukarıdaki üç doğrulamayı koşturmaktır; `git status`'ün "58 silinmiş"
  çıktısını olduğu gibi okumak, yanlış kurtarmaya davetiyedir.
