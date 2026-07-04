---
name: mas-dashboard-ux
description: Build or review the MAS private finance dashboard UI using shadcn/ui, TanStack Table, and Recharts. Use for dashboard, calendar, ledger, and data-quality screens.
allowed-tools: Read Grep Bash Edit
---

# MAS Dashboard UX

Design target: dense, serious, finance-oriented internal dashboard. No marketing/SaaS landing aesthetic.

Core dashboard questions:

- What is due today?
- What is due tomorrow?
- What is due in the next 7 days?
- What is the known remaining load this month?
- Which amounts are missing?
- Which payments are overdue?
- Which days are risky?

UI rules:

- Unknown amount must be visible.
- Critical and overdue items must be visually dominant.
- Same-day clusters must be obvious.
- Tables must be filterable and scannable.
- Calendar must show day count, known total, missing count, and risk.
- Mobile must support quick checking, not full desktop parity.

Components to prefer:

- shadcn Card, Table, Dialog, Sheet, Tabs, Badge, Select, Popover, Calendar, Form, Input, Textarea, Alert
- TanStack Table for ledgers and data quality lists
- Recharts for trend/load charts

Before finishing:

1. verify empty/loading/error states
2. verify null amount display
3. verify critical/overdue visibility
4. update `docs/todo.md`
