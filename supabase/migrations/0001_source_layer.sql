-- Raw source preservation layer (implementation.md §8, verbatim DDL + indexes)

create table public.source_workbooks (
  id uuid primary key default gen_random_uuid(),
  original_filename text not null,
  storage_path text,
  file_sha256 text,
  imported_by uuid references auth.users(id),
  imported_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending','parsed','mapped','failed')),
  parse_error text,
  notes text
);

create table public.source_sheets (
  id uuid primary key default gen_random_uuid(),
  workbook_id uuid not null references public.source_workbooks(id) on delete cascade,
  sheet_name text not null,
  sheet_name_normalized text,
  sheet_index int not null,
  used_range text,
  row_count int,
  column_count int,
  detected_type text check (detected_type in (
    'loan_calculation','capacity','machine_roi','payment_day_matrix','checks',
    'cost_model_normal','cost_model_overtime','monthly_cashflow','unknown'
  )),
  parse_confidence text not null default 'unknown' check (parse_confidence in ('high','medium','low','unknown')),
  created_at timestamptz not null default now(),
  unique(workbook_id, sheet_index)
);

create table public.source_cells (
  id uuid primary key default gen_random_uuid(),
  workbook_id uuid not null references public.source_workbooks(id) on delete cascade,
  sheet_id uuid not null references public.source_sheets(id) on delete cascade,
  row_index int not null,
  column_index int not null,
  address text not null,
  raw_value text,
  normalized_value text,
  inferred_type text,
  formula text,
  style_json jsonb,
  created_at timestamptz not null default now(),
  unique(sheet_id, row_index, column_index)
);
create index source_cells_sheet_idx on public.source_cells(sheet_id);
create index source_cells_workbook_idx on public.source_cells(workbook_id);

create table public.import_rows (
  id uuid primary key default gen_random_uuid(),
  workbook_id uuid not null references public.source_workbooks(id) on delete cascade,
  sheet_id uuid not null references public.source_sheets(id) on delete cascade,
  row_index int not null,
  row_json jsonb not null,
  row_hash text,
  detected_entity_type text,
  mapping_status text not null default 'unmapped' check (mapping_status in ('unmapped','mapped','ignored','needs_review')),
  mapped_entity_table text,
  mapped_entity_id uuid,
  notes text,
  created_at timestamptz not null default now(),
  unique(sheet_id, row_index)
);
create index import_rows_workbook_idx on public.import_rows(workbook_id);
create index import_rows_status_idx on public.import_rows(mapping_status);

create table public.mapping_reviews (
  id uuid primary key default gen_random_uuid(),
  workbook_id uuid not null references public.source_workbooks(id) on delete cascade,
  sheet_id uuid references public.source_sheets(id) on delete cascade,
  import_row_id uuid references public.import_rows(id) on delete cascade,
  issue_type text not null,
  severity text not null default 'medium' check (severity in ('low','medium','high','critical')),
  message text not null,
  suggested_mapping jsonb,
  status text not null default 'open' check (status in ('open','accepted','rejected','resolved')),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
create index mapping_reviews_status_idx on public.mapping_reviews(status);
