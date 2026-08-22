-- Faz 21 — invoice detail lines.
--
-- No status column here, deliberately. A line has no lifecycle of its own: it lives and dies
-- with its invoice, and its editability is governed by the invoice's status. Giving it one
-- would create a second state machine needing a second complete guard, which implementation.md
-- §17 rule 3 exists to prevent (and which Faz 20 already declined to do for match candidates).
--
-- Idempotent throughout, per LEDGER_EMPTY_RECOVERY.

create table if not exists public.invoice_lines (
  id uuid primary key default gen_random_uuid(),
  -- CASCADE is right here and is not a loosening: a line has no meaning without its header,
  -- and an issued invoice cannot be deleted at all (see the delete guard below).
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  line_no int not null check (line_no > 0),

  -- Faz 19's minimal product reference. Optional: source documents frequently describe an item
  -- in free text that matches no catalogue row, and inventing a product to satisfy an FK is the
  -- silent-creation failure Faz 19 exists to prevent.
  product_id uuid references public.products(id),
  description text not null check (btrim(description) <> ''),

  -- Quantity and unit price carry 4 decimals: a unit price of 12,3456 TL is ordinary in
  -- machining, and rounding it to kuruş at the line level would make the line total disagree
  -- with the supplier's own document.
  quantity numeric(14,4) not null default 1,
  unit_price numeric(14,4) not null,
  unit text,
  tax_rate numeric(8,4) not null default 0 check (tax_rate >= 0),

  -- Line money is at TL scale, like every other money column in this schema.
  net_amount numeric(14,2) not null,
  tax_amount numeric(14,2) not null default 0,
  gross_amount numeric(14,2) not null,
  constraint invoice_lines_gross_is_net_plus_tax check (gross_amount = net_amount + tax_amount),

  -- Per-line dimensions, so one invoice can be split across cost centres or projects. This is
  -- the reference-data link Faz 19 was building toward; no allocation LOGIC is added here.
  cost_center_id uuid references public.cost_centers(id),
  project_id uuid references public.projects(id),

  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (invoice_id, line_no)
);

create index if not exists invoice_lines_invoice_idx on public.invoice_lines (invoice_id, line_no);
create index if not exists invoice_lines_product_idx on public.invoice_lines (product_id) where product_id is not null;

drop trigger if exists invoice_lines_updated_at on public.invoice_lines;
create trigger invoice_lines_updated_at before update on public.invoice_lines
  for each row execute function public.set_updated_at();

-- ── lines follow the header's immutability ─────────────────────────────────────────────────
--
-- The header freezes its own content once issued (0044). Freezing the header while leaving its
-- lines editable would be theatre: the total would stay put while the detail underneath it
-- changed. One function serves INSERT, UPDATE and DELETE so there is no gap between them.
create or replace function public.invoice_lines_immutability_guard() returns trigger
language plpgsql as $$
declare
  parent_status text;
  parent_id uuid;
begin
  parent_id := coalesce(new.invoice_id, old.invoice_id);
  select i.status into parent_status from public.invoices i where i.id = parent_id;

  -- The parent row is gone: this is the ON DELETE CASCADE running, not someone editing a line.
  -- Blocking it here would make an invoice undeletable even in draft.
  if parent_status is null then
    return coalesce(new, old);
  end if;

  if parent_status <> 'draft' then
    raise exception
      'invoice_lines: düzenlenmiş faturanın (%) kalemleri değiştirilemez (durum=%). Düzeltme iptal+yeniden düzenleme ya da iade faturasıyla yapılır.',
      parent_id, parent_status;
  end if;
  return coalesce(new, old);
end $$;

drop trigger if exists invoice_lines_immutability_guard on public.invoice_lines;
create trigger invoice_lines_immutability_guard
  before insert or update or delete on public.invoice_lines
  for each row execute function public.invoice_lines_immutability_guard();

-- ── an issued invoice may not be deleted ───────────────────────────────────────────────────
--
-- Cancellation is the supported way to void an invoice, and it leaves a reversal record (0046).
-- DELETE would leave nothing at all, which is the one outcome an audit trail cannot survive.
-- Drafts stay deletable: nothing commercial ever happened to them.
create or replace function public.invoices_block_issued_delete() returns trigger
language plpgsql as $$
begin
  if old.status <> 'draft' then
    raise exception
      'invoices.%: düzenlenmiş fatura silinemez (durum=%). İptal, bağlı bir reversal kaydıyla yapılır.',
      old.id, old.status;
  end if;
  return old;
end $$;

drop trigger if exists invoices_block_issued_delete on public.invoices;
create trigger invoices_block_issued_delete before delete on public.invoices
  for each row execute function public.invoices_block_issued_delete();

alter table public.invoice_lines enable row level security;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='invoice_lines' and policyname='invoice_lines_authenticated_all'
  ) then
    create policy invoice_lines_authenticated_all on public.invoice_lines
      for all to authenticated using (true) with check (true);
  end if;
end $$;

grant select, insert, update, delete on public.invoice_lines to authenticated;
