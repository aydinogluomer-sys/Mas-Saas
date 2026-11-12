-- 0111 — TDHP 500.99 Açılış Bilançosu Denkleştirme Hesabı ve FIN-03 Kasa/Banka Açılış Köprüsü (A3 / F-16 / F-45).
--
-- Kurallar:
--   * Üst-seviye işlem komutu (BEGIN/COMMIT) ve CONCURRENTLY indeks kullanılmaz.
--   * Sıfır kayan nokta; her yeni FK kolonu B-tree indeks taşır.

-- ── 1) TDHP 500.99 Açılış Bilançosu Denkleştirme Hesabı tohumu ─────────────────────────────────
insert into public.management_accounts
  (code, name, parent_code, account_class, normal_side, ebitda_bucket, tdhp_root_code)
values
  ('500.99', 'Açılış Bilançosu Denkleştirme Hesabı', '500', 'equity', 'credit', 'balance_sheet', '500')
on conflict (code) do update
  set name           = excluded.name,
      parent_code    = excluded.parent_code,
      account_class  = excluded.account_class,
      normal_side    = excluded.normal_side,
      ebitda_bucket  = excluded.ebitda_bucket,
      tdhp_root_code = excluded.tdhp_root_code;

-- ── 2) management_journal_entries.source_type CHECK kısıtına 'opening_balance' eklenmesi ────────
do $$
declare
  v_attnum smallint;
  r record;
begin
  select a.attnum into v_attnum
    from pg_attribute a
   where a.attrelid = 'public.management_journal_entries'::regclass
     and a.attname = 'source_type'
     and not a.attisdropped;

  for r in
    select c.conname
      from pg_constraint c
     where c.conrelid = 'public.management_journal_entries'::regclass
       and c.contype = 'c'
       and c.conkey = array[v_attnum]
  loop
    execute format('alter table public.management_journal_entries drop constraint %I', r.conname);
  end loop;

  alter table public.management_journal_entries
    add constraint management_journal_entries_source_type_check
    check (source_type in (
      'invoice',
      'bank_transaction',
      'check_bordro',
      'loan_installment',
      'payment_instance',
      'manual_adjustment',
      'fx_revaluation',
      'reversal',
      'opening_balance'
    ));
end $$;

-- ── 3) public.cash_accounts açılış tarihi ve yönetim defteri fiş bağlantısı ────────────────────
alter table public.cash_accounts
  add column if not exists opening_balance_date date not null default current_date,
  add column if not exists opening_journal_entry_id uuid
    references public.management_journal_entries(id) on delete set null;

create index if not exists idx_cash_accounts_opening_journal_entry
  on public.cash_accounts (opening_journal_entry_id);
