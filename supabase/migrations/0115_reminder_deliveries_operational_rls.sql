-- 0115 — Hatırlatıcı gönderim kuyruğu (`public.reminder_deliveries`) operasyonel RLS hizalaması (F-52 / F-69)
--
-- `planToday()` kuyruğa `status = 'pending'` satırı eklerken, `dispatchPending()` gönderim anında
-- `update public.reminder_deliveries set status = 'sent' | 'skipped' | 'failed', sent_at = ..., error = ...`
-- çalıştırır. `0058` içinde tablo yanlışlıkla salt-eklenir `evidence` sınıfına konulduğu için
-- `mas_radar_finance_operator` / `mas_radar_finance_manager` / `mas_radar_admin` katmanlarında
-- `UPDATE` sıfır satır etkiliyordu. Tablo, üst tablosu `public.reminders` ile uyumlu biçimde
-- `operational` sınıfına geçirilir.
--
-- Kurallar:
--   * Üst-seviye işlem komutu (BEGIN/COMMIT) ve CONCURRENTLY indeks kullanılmaz.

drop policy if exists reminder_deliveries_insert_record on public.reminder_deliveries;
drop policy if exists reminder_deliveries_insert_enter on public.reminder_deliveries;
drop policy if exists reminder_deliveries_update_enter on public.reminder_deliveries;
drop policy if exists reminder_deliveries_delete_manage on public.reminder_deliveries;

create policy reminder_deliveries_insert_enter on public.reminder_deliveries
  for insert to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin
  with check (true);

create policy reminder_deliveries_update_enter on public.reminder_deliveries
  for update to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin
  using (true)
  with check (true);

create policy reminder_deliveries_delete_manage on public.reminder_deliveries
  for delete to mas_radar_finance_manager, mas_radar_admin
  using (true);

