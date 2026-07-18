-- Explicit decision flexibility. Null means unclassified; no class is inferred from category text.
alter table public.payments
  add column if not exists flexibility_class text
  check (flexibility_class in ('critical','flexible','optional'));

