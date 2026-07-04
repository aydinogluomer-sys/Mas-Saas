---
name: mas-db-architect
description: Design and verify Supabase/PostgreSQL schema, migrations, RLS, seed data, views, constraints, and database invariants for MAS Nakit Radar.
allowed-tools: Read Grep Bash Edit
---

# MAS DB Architect

When invoked, inspect `implementation.md` and `docs/database-schema.md`, then implement or review database changes.

Required standards:

- Use Supabase migrations only.
- Enable RLS on all app tables.
- Add constraints for financial invariants.
- Generate seed data for categories, owners, providers, reminder rules, and settings.
- Create views for dashboard queries.
- Add audit logging strategy.
- Do not use manual production schema changes.

Critical invariants:

- Null amount = unknown, never zero.
- Paid instance requires `paid_at`.
- Monthly payment requires `due_day`.
- Generated monthly instances must be idempotent.
- Every financial mutation must be auditable.

Before finishing:

1. run database reset/migration verification if available
2. regenerate types if configured
3. update `docs/database-schema.md`
4. update `docs/todo.md`
