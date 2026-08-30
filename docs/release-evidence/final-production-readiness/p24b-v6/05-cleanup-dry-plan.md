# 05 — Temizlik DRY PLAN (çalıştırılmadı)

**Gerçek DB'de silme YOK.** Sıra, disposable klon üzerinde **çalıştırılarak** doğrulandı.

## Sıra — varsayılmadı, ölçüldü

| # | tablo | hedef | neden bu sırada |
|---|---|---|---|
| 1 | `action_items` | 4 | `created_by → users` **NO ACTION**: kullanıcı silinmeden önce gitmeli |
| 2 | `approvals` | 4 | `requested_by → users` **NO ACTION**: aynı sebep |
| 3 | `payment_instances` | 26 | `payment_id → payments` **ON DELETE SET NULL** — ödeme önce silinirse 26 satır `payment_id=NULL` ile **sessizce hayatta kalır** ve tek kanıt bağını kaybeder |
| 4 | `payments` | 1 | referans verenleri artık yok |
| 5 | `users` | 6 | yalnız 1 ve 2'deki satırlar referans veriyordu (ölçüldü: `audit_logs.actor`=0, `sessions`=0) |
| 6 | `settings` | 1 | bağımsız |

Klonda ölçülen sonuç: **42 satır silindi, orphan `payment_instances` = 0.**

`payment_instances`'ın ödemeden önce gelmesi bu planın en önemli maddesidir: `SET NULL`
sessizdir, hata vermez, ve yanlış sırada çalıştırılan bir temizlik 26 satırı geride bırakırken
"başarılı" raporlar.

## Beklenen tablo deltaları

| tablo | before | after | delta |
|---|---|---|---|
| `action_items` | 10 | 6 | −4 |
| `approvals` | 72 | 68 | −4 |
| `payment_instances` | 511 | 485 | −26 |
| `payments` | 20 | 19 | −1 |
| `users` | 19 | 13 | −6 |
| `settings` | 8 | 7 | −1 |

## Beklenen para deltaları

| ölçü | before | fixture katkısı | expectedAfter |
|---|---|---|---|
| `payments.default_amount` Σ | 541.000,00 | 1.000,00 | 540.000,00 |
| `payment_instances.amount` Σ | 14.576.000,00 | 26.000,00 | 14.550.000,00 |
| `checks.amount` Σ | 590.000,00 | 0 | 590.000,00 |
| `loans.principal` Σ | 1.500.000,00 | 0 | 1.500.000,00 |
| `cashflow_months.closing_balance` Σ | −53.839.702,88 | 0 | −53.839.702,88 |

## Silmenin ardından zorunlu adım

42 satırın kaldırılması `metric_snapshots`'ı **düzeltmez**. `04`'te kanıtlandığı gibi
`refreshMetricSnapshots(pool, actor, '2026-08-27')` ayrıca çalıştırılmalıdır; aksi hâlde iki
kayıtlı toplam kirli kalır.

## Bu plan henüz yetki değildir

Eksikler: off-device yedek, kullanıcının açık onayı. Mevcut `scripts/db/fixture-cleanup.ts`
bu manifeste **uymuyor** (6 kullanıcıdan 4'ünü tanıyor; `settings`/`approvals` yok) ve
çalıştırılmamalıdır.

`P24B_CLEANUP_AUTHORIZED = NO`
