---
name: mas-report-writer
description: Generate or review daily, weekly, monthly MAS finance operation reports and AI commentary prompts without mutating financial records.
allowed-tools: Read Grep Bash Edit
---

# MAS Report Writer

Reports must be short, decision-oriented, and operational.

Daily report:

- due today
- due tomorrow
- next 7 days known total
- missing data count
- critical/overdue items
- action checklist

Weekly report:

- week payment list
- known total
- missing amount list
- largest payments
- risk days
- overdue items
- preparation actions

Monthly report:

- total known load
- paid/unpaid split
- missing amount count
- provider distribution
- category distribution
- owner distribution
- top 10 payments
- risk days
- data quality issues

AI rule:

AI can write narrative commentary only. It cannot modify, delete, mark paid, or recalculate source-of-truth values.
