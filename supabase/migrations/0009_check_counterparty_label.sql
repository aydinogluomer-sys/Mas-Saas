-- Phase 5: preserve the raw KİME/KİMDEN text on checks the same way cashflow_lines
-- keeps its `label` — so counterparties absent from `parties` (AKR, EGE GÜNEŞ…) are
-- never lost and bank/counterparty exposure stays faithful. We do NOT create parties
-- silently during mapping (mirrors Phase 4); the label carries the name, the FK stays
-- null until a human links it.

alter table public.checks add column counterparty_label text;
