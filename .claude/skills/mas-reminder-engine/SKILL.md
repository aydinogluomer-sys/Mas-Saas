---
name: mas-reminder-engine
description: Implement or review Telegram/email reminder scheduling for MAS Nakit Radar, including eligibility, duplicate prevention, templates, and delivery logs.
allowed-tools: Read Grep Bash Edit
---

# MAS Reminder Engine

Build reminders as deterministic scheduled logic.

Reminder rules:

- 7 days before: preparation
- 3 days before: cash readiness
- 1 day before: tomorrow due
- 0 days: today due
- -1 day: overdue check

Eligibility:

- rule active
- instance unpaid or partial
- reminder date matches today in Europe/Istanbul
- delivery not already sent
- threshold filters pass

Security:

- Telegram token server-only.
- Never expose token to client.
- Log every delivery attempt.
- Prevent duplicate messages with a unique key.

Message must include:

- payment name
- due date
- owner
- provider
- amount or “tutar eksik”
- status
- risk reason if any

Before finishing:

1. add tests for eligibility
2. add duplicate-prevention test
3. add failed delivery logging
4. update `docs/todo.md`
