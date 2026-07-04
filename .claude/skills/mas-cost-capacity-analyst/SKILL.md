---
name: mas-cost-capacity-analyst
description: Implement or review MAS production capacity, machine time, normal vs overtime cost model, TL/minute break-even, and part-level profitability analytics.
allowed-tools: Read Grep Bash Edit
---

# MAS Cost and Capacity Analyst

Use this skill when working on `kapasite`, `maliyet-mastechnic`, `maliyet-mastechnicmesaili`, `tablo`, machine assets, capacity models, cost models, and part profitability.

Rules:

- This module is analytics, not accounting truth.
- Implement only after finance/payment/cashflow foundations are stable.
- Preserve raw source rows.
- Track normal vs overtime/mesaili scenarios separately.
- Store efficiency, monthly hours, monthly minutes, staff/apprentice assumptions, fixed costs, and break-even TL/minute.
- Part-level profitability must expose confidence and missing operation-time warnings.
- Machine ROI snapshots require manual review before being treated as reliable.

Required tests:

1. normal vs overtime comparison
2. break-even TL/minute calculation
3. missing operation time flag
4. part cost estimate
5. ROI confidence defaults to needs_review
