-- Harmless index — deliberately chosen as the first real "pending migration applied to
-- an already-migrated DB" proof for the migration ledger runner (P0-C).
create index if not exists schema_migrations_applied_at_idx
  on public.schema_migrations (applied_at);
