---
name: mas-implementation-slicer
description: Slice the MAS Nakit Radar implementation into safe Claude Code phases and prevent scope creep. Use before starting a new phase or when the task feels too large.
allowed-tools: Read Grep Edit
---

# MAS Implementation Slicer

When invoked:

1. Read `implementation.md`.
2. Read `docs/todo.md`.
3. Identify the current phase.
4. Cut the next task into the smallest safe vertical slice.
5. State files likely to change.
6. State tests required.
7. State explicit non-goals.
8. Update `docs/todo.md` only if the plan changes.

Rules:

- Do not start several phases at once.
- Do not polish UI before data correctness.
- Do not add public SaaS features.
- Do not add AI mutation powers.
- Prefer one verified vertical slice over broad partial implementation.
