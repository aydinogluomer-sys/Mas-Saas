-- Faz 24A — approval rule configuration.
--
-- Which situations require a checker, expressed as data rather than as `if` statements spread
-- through the engines. implementation.md names four triggers for this phase: amount threshold,
-- new IBAN (Faz 19's ibans), new counterparty (Faz 19's parties), and invoice/payment. Budget,
-- forecast and scenario triggers are explicitly Faz 28/29's and are deliberately absent rather
-- than stubbed.
--
-- NO STATUS COLUMN. A rule is active or it is not; `is_active` is a boolean with no transitions
-- to constrain. §17 rule 3 stays N/A, the same call Faz 19-23 made for every table that did not
-- genuinely need a lifecycle.
--
-- Idempotent throughout, per LEDGER_EMPTY_RECOVERY.

create table if not exists public.approval_rules (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (btrim(code) <> ''),
  description text not null check (btrim(description) <> ''),

  -- Which situation arms the rule. Mirrors approvals.request_kind minus 'data_review' (that one
  -- is produced by the legacy bridge in 0055, not by a configurable rule) and minus 'other'.
  trigger_kind text not null check (trigger_kind in (
    'amount_threshold', 'new_iban', 'new_counterparty', 'invoice', 'payment'
  )),

  -- Only meaningful for amount_threshold. Zero is a legitimate threshold ("everything needs a
  -- checker"); null means the rule does not look at amounts at all. The two are different
  -- statements, so the CHECK ties the column to its trigger kind rather than defaulting it.
  threshold_amount numeric(14,2) check (threshold_amount is null or threshold_amount >= 0),
  currency text not null default 'TRY' check (currency ~ '^[A-Z]{3}$'),
  constraint approval_rules_threshold_scope check (
    (trigger_kind = 'amount_threshold') = (threshold_amount is not null)
  ),

  -- Which subject tables the rule watches. Empty array = all of them.
  applies_to text[] not null default '{}',

  is_active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists approval_rules_active_idx on public.approval_rules (trigger_kind) where is_active;

drop trigger if exists approval_rules_updated_at on public.approval_rules;
create trigger approval_rules_updated_at before update on public.approval_rules
  for each row execute function public.set_updated_at();

alter table public.approval_rules enable row level security;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='approval_rules' and policyname='approval_rules_authenticated_all'
  ) then
    create policy approval_rules_authenticated_all on public.approval_rules
      for all to authenticated using (true) with check (true);
  end if;
end $$;

grant select, insert, update, delete on public.approval_rules to authenticated;

-- ── default rules ──────────────────────────────────────────────────────────────────────────
--
-- Seeded here rather than in supabase/seed.sql because they are structural configuration the
-- application depends on, not sample data — a fresh database with no rules would silently
-- require no approvals at all, which is the wrong default for a control panel.
--
-- ON CONFLICT DO NOTHING: re-running must not overwrite thresholds an operator has since tuned.
-- The 100.000 TL figure matches the `critical_payment_threshold_try` already in public.settings
-- (docs/calculation-rules.md) rather than introducing a second number meaning almost the same.
insert into public.approval_rules (code, description, trigger_kind, threshold_amount, applies_to, notes)
values
  ('amount_over_100k',
   '100.000 TL ve üzeri ödeme/fatura ikinci onay ister',
   'amount_threshold', 100000.00, '{invoices,payment_instances}',
   'Eşik public.settings.critical_payment_threshold_try ile aynı sayı — ikinci bir eşik icat edilmedi.'),
  ('new_iban_requires_approval',
   'Yeni banka hesabı (IBAN) kaydı onay ister',
   'new_iban', null, '{ibans}',
   'IBAN değişikliği bu uygulamadaki en yüksek sonuçlu düzenlemedir (bkz. migration 0037).'),
  ('new_counterparty_requires_approval',
   'Yeni karşı taraf kaydı onay ister',
   'new_counterparty', null, '{parties}',
   'Faz 19: karşı taraf yalnız açık operatör eylemiyle yaratılır; bu kural o eylemi ikinci göze bağlar.'),
  ('invoice_requires_approval',
   'Fatura düzenlemesi onay ister',
   'invoice', null, '{invoices}',
   'Varsayılan olarak PASİF — küçük bir ekipte her faturayı ikinci göze bağlamak akışı durdurur.'),
  ('payment_requires_approval',
   'Ödeme kaydı onay ister',
   'payment', null, '{payment_instances}',
   'Varsayılan olarak PASİF.')
on conflict (code) do nothing;

-- The two blanket rules ship inactive on purpose: turning every invoice and every payment into a
-- two-person operation is right for some firms and paralysing for others, and a control panel
-- that arrives blocking normal work gets switched off wholesale. The amount threshold and the
-- two "new record" rules ship active, because those are the cases where a single mistake is
-- expensive and rare enough that a second look costs nothing.
update public.approval_rules set is_active = false
where code in ('invoice_requires_approval', 'payment_requires_approval')
  and updated_at = created_at;
