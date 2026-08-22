-- Faz 35 — document centre: documents, attachments (versions), and links to business records.
--
-- ═══ OPEN QUESTION #7 SETTLED: LOCAL DISK, AND THE PRECEDENT ALREADY EXISTS ═══
--
-- The plan left the storage backend open. It is not actually open — this system settled it in
-- Faz 2 and nobody wrote it down. `source_workbooks` (migration 0001) carries:
--
--     storage_path text,
--     file_sha256  text,
--
-- i.e. the bytes live on local disk and the database holds the path plus a checksum. That is the
-- established pattern, and `attachments` below is deliberately the same shape rather than a
-- second, rival one.
--
-- The two alternatives were rejected for reasons this project can point at:
--
--   OBJECT STORAGE (S3 and friends) would add an external cloud dependency to a system CLAUDE.md
--   defines as a single-company, private, internal control panel running on local Docker
--   Postgres. It would also put financial documents somewhere the owner cannot inspect with a
--   file manager.
--
--   BYTES IN POSTGRES (bytea or large objects) would put every scanned contract into the backup.
--   Faz 33 measured what that costs: at 24.000 invoices the pg_dump was already large enough to
--   break the backup verification path outright. Storing documents in-row would make the dump
--   grow without bound, and the mandatory pre-migration backup is the one thing that must never
--   become impractical to take.
--
-- What local disk costs, stated honestly: the database no longer contains everything needed to
-- restore. A dump plus a lost documents directory is a dump with dead links. That is why
-- `file_sha256` is NOT NULL here (it is nullable in 0001) — a restore can at least PROVE which
-- files are missing or corrupt instead of silently serving the wrong bytes.

create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),

  title text not null check (btrim(title) <> ''),

  -- Closed list. Free text would make the archive unfilterable within a month.
  doc_type text not null default 'other' check (doc_type in (
    'contract', 'invoice_scan', 'bank_statement', 'receipt', 'tax_document',
    'insurance', 'correspondence', 'report', 'other'
  )),

  -- Tags are an array, not a join table: they carry no attributes and nothing references them.
  -- A tags table here would be three joins to answer "which documents are tagged 'kira'".
  tags text[] not null default '{}',

  description text,

  -- Lifecycle. `superseded` is distinct from `archived` on purpose: superseded means a NEWER
  -- DOCUMENT replaced this one (and says which), archived means it is simply out of active use.
  -- Collapsing them would lose the reason.
  status text not null default 'active' check (status in ('active', 'archived', 'superseded')),
  superseded_by_document_id uuid references public.documents(id),
  archived_at timestamptz,
  archive_reason text,

  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- 0026's bidirectional-consistency pattern, reused rather than reinvented.
  constraint documents_archive_consistency check (
    (status = 'archived') = (archived_at is not null)
    and (archived_at is not null) = (archive_reason is not null)
    and (archive_reason is null or btrim(archive_reason) <> '')
  ),
  -- A superseded document must say what replaced it, and must not point at itself.
  constraint documents_supersede_consistency check (
    (status = 'superseded') = (superseded_by_document_id is not null)
  ),
  constraint documents_no_self_supersede check (
    superseded_by_document_id is null or superseded_by_document_id <> id
  )
);

-- ── attachments: the physical files, and the VERSION history ────────────────────────────
--
-- A document is the logical thing ("2026 kira sözleşmesi"); an attachment is one FILE of it.
-- Versioning lives here rather than on documents, because that is what actually gets replaced:
-- a re-scan of the same contract is a new attachment, not a new document.
create table if not exists public.attachments (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,

  version_no integer not null check (version_no >= 1),

  original_filename text not null check (btrim(original_filename) <> ''),
  -- Same two columns as source_workbooks (0001). Same meaning, deliberately.
  storage_path text not null check (btrim(storage_path) <> ''),
  -- NOT NULL here, unlike 0001: without it a restore cannot tell a missing file from a corrupt
  -- one, and "the document centre served the wrong bytes" is not a recoverable failure.
  file_sha256 text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),

  byte_size bigint not null check (byte_size >= 0),
  mime_type text not null check (btrim(mime_type) <> ''),

  uploaded_by uuid references auth.users(id),
  uploaded_at timestamptz not null default now(),
  notes text,

  -- One row per version of a document.
  unique (document_id, version_no),
  -- The same bytes may legitimately appear under two different documents (the same PDF filed
  -- against two invoices), so sha256 is NOT globally unique — but it IS unique within a
  -- document, because re-uploading identical bytes as "version 4" records a change that did not
  -- happen.
  unique (document_id, file_sha256)
);

create index if not exists attachments_document_version_idx
  on public.attachments (document_id, version_no desc);
create index if not exists attachments_sha_idx on public.attachments (file_sha256);
create index if not exists documents_status_type_idx on public.documents (status, doc_type, created_at desc);
-- Tag filtering: GIN, because `tags @> '{kira}'` over a btree is a sequential scan.
create index if not exists documents_tags_idx on public.documents using gin (tags);

-- ── document_links: which business record a document belongs to ─────────────────────────
--
-- Polymorphic, exactly like approvals (0053) and audit_logs: this schema already points at "one
-- of the entities" that way, and a third convention would be a third thing to learn. The closed
-- list is the safety property — an open text column would let a typo create a link nothing can
-- ever resolve.
create table if not exists public.document_links (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,

  entity_table text not null check (entity_table in (
    'invoices', 'payment_instances', 'payments', 'checks', 'loans',
    'bank_transactions', 'parties', 'contracts_placeholder'
  )),
  entity_id uuid not null,
  -- Readable at link time, so a link still means something after the subject is archived.
  entity_label text,

  -- Why this document is attached to that record.
  link_kind text not null default 'supporting' check (link_kind in (
    'supporting', 'contract', 'proof_of_payment', 'correspondence', 'other'
  )),

  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),

  unique (document_id, entity_table, entity_id, link_kind)
);

create index if not exists document_links_entity_idx
  on public.document_links (entity_table, entity_id);

-- ── transition guard, in the SAME migration as the CHECK (the 0027 lesson) ──────────────
--
-- The CHECK says which values are legal; it says nothing about which MOVES are. Allowed:
--   active     -> archived     out of active use
--   active     -> superseded   a newer document replaces it
--   archived   -> active       un-archive, a real operator action
--   archived   -> superseded   a newer document replaces an archived one
--
-- REFUSED, and this is the point:
--   superseded -> anything     the replacement already exists and points back here. Reviving a
--                              superseded document would leave two live documents both claiming
--                              to be current, and every link would silently become ambiguous.
create or replace function public.documents_guard_transition()
returns trigger
language plpgsql
as $$
begin
  if new.status = old.status then
    return new;
  end if;

  if (old.status, new.status) not in (
    ('active',   'archived'),
    ('active',   'superseded'),
    ('archived', 'active'),
    ('archived', 'superseded')
  ) then
    raise exception 'Geçersiz doküman durumu geçişi: % → % (doküman %)',
      old.status, new.status, old.id
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

drop trigger if exists documents_status_guard on public.documents;
create trigger documents_status_guard
  before update of status on public.documents
  for each row execute function public.documents_guard_transition();

drop trigger if exists documents_updated_at on public.documents;
create trigger documents_updated_at before update on public.documents
  for each row execute function public.set_updated_at();

-- ── attachments are APPEND-ONLY (the 0022 pattern) ──────────────────────────────────────
--
-- A version history that can be edited is not a history. Correcting a bad upload means adding
-- version N+1, which is also what actually happened.
create or replace function public.attachments_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'attachments append-only: sürüm geçmişi değiştirilemez (yeni sürüm ekleyin)'
    using errcode = 'check_violation';
end $$;

drop trigger if exists attachments_no_update on public.attachments;
create trigger attachments_no_update before update on public.attachments
  for each row execute function public.attachments_append_only();
drop trigger if exists attachments_no_delete on public.attachments;
create trigger attachments_no_delete before delete on public.attachments
  for each row execute function public.attachments_append_only();

-- ── read model: current version per document ────────────────────────────────────────────
--
-- A VIEW, not a `current_attachment_id` column: a stored pointer is a second source of truth for
-- something max(version_no) already answers, and it goes stale the first time somebody inserts a
-- version without updating it.
create or replace view public.document_current_version as
  select d.id                as document_id,
         d.title,
         d.doc_type,
         d.tags,
         d.status,
         a.id                as attachment_id,
         a.version_no,
         a.original_filename,
         a.storage_path,
         a.file_sha256,
         a.byte_size,
         a.mime_type,
         a.uploaded_at,
         (select count(*)::int from public.attachments x where x.document_id = d.id) as version_count
  from public.documents d
  left join lateral (
    select * from public.attachments a2
     where a2.document_id = d.id
     order by a2.version_no desc
     limit 1
  ) a on true;

-- ── RLS: Faz 24B five-tier classification, never a blanket `authenticated` ──────────────
--
-- documents/document_links are `operational` (filing a document is data entry; everyone may
-- read; only manager/admin may delete). attachments are `evidence`: insert and select for every
-- working tier, and NO update or delete for anyone — the append-only triggers above enforce that
-- in the database, and the grants make it explicit at the permission layer too.
alter table public.documents enable row level security;
alter table public.attachments enable row level security;
alter table public.document_links enable row level security;

drop policy if exists documents_select_all_tiers on public.documents;
create policy documents_select_all_tiers on public.documents
  for select to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver,
                mas_radar_finance_manager, mas_radar_admin using (true);
drop policy if exists documents_insert_enter on public.documents;
create policy documents_insert_enter on public.documents
  for insert to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin with check (true);
drop policy if exists documents_update_enter on public.documents;
create policy documents_update_enter on public.documents
  for update to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin
  using (true) with check (true);
drop policy if exists documents_delete_manage on public.documents;
create policy documents_delete_manage on public.documents
  for delete to mas_radar_finance_manager, mas_radar_admin using (true);

drop policy if exists attachments_select_all_tiers on public.attachments;
create policy attachments_select_all_tiers on public.attachments
  for select to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver,
                mas_radar_finance_manager, mas_radar_admin using (true);
drop policy if exists attachments_insert_record on public.attachments;
create policy attachments_insert_record on public.attachments
  for insert to mas_radar_finance_operator, mas_radar_finance_approver,
                mas_radar_finance_manager, mas_radar_admin with check (true);

drop policy if exists document_links_select_all_tiers on public.document_links;
create policy document_links_select_all_tiers on public.document_links
  for select to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver,
                mas_radar_finance_manager, mas_radar_admin using (true);
drop policy if exists document_links_insert_enter on public.document_links;
create policy document_links_insert_enter on public.document_links
  for insert to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin with check (true);
drop policy if exists document_links_update_enter on public.document_links;
create policy document_links_update_enter on public.document_links
  for update to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin
  using (true) with check (true);
drop policy if exists document_links_delete_manage on public.document_links;
create policy document_links_delete_manage on public.document_links
  for delete to mas_radar_finance_manager, mas_radar_admin using (true);

grant select on public.documents, public.attachments, public.document_links
  to mas_radar_viewer, mas_radar_finance_approver;
grant select, insert, update on public.documents, public.document_links
  to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin;
grant select, insert on public.attachments
  to mas_radar_finance_operator, mas_radar_finance_approver,
     mas_radar_finance_manager, mas_radar_admin;
grant delete on public.documents, public.document_links
  to mas_radar_finance_manager, mas_radar_admin;

grant select on public.document_current_version to mas_radar_viewer,
  mas_radar_finance_operator, mas_radar_finance_approver,
  mas_radar_finance_manager, mas_radar_admin;
