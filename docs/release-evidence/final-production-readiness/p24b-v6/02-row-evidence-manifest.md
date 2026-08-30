# 02 — Satır bazlı kanıt manifesti

Üretim: `node --import tsx scripts/qa/p24b-row-evidence.ts` · 2026-08-30T08:00:46.790Z

**Kural:** `DELETE_TARGET` için en az **2 bağımsız kanıt sınıfı**. `TIME` sayıma dahil değildir.

| tablo | id | sınıflandırma | olay | xmin | kanıt sınıfları (TIME hariç) | n |
|---|---|---|---|---|---|---|
| `users` | `92cee4d3` | **DELETE_TARGET** | I1 | 537249 | TEXT, TRANSACTION_LINEAGE, BASELINE_ABSENT | 3 |
| `users` | `a794163c` | **DELETE_TARGET** | I1 | 537250 | TEXT, TRANSACTION_LINEAGE, BASELINE_ABSENT | 3 |
| `users` | `33796a14` | **DELETE_TARGET** | I1 | 537425 | TEXT, TRANSACTION_LINEAGE, BASELINE_ABSENT | 3 |
| `users` | `19688698` | **DELETE_TARGET** | I1 | 537427 | TEXT, TRANSACTION_LINEAGE, BASELINE_ABSENT | 3 |
| `users` | `cd3445b1` | **DELETE_TARGET** | I2 | 564610 | TEXT, TRANSACTION_LINEAGE, BASELINE_ABSENT | 3 |
| `users` | `4b6d2264` | **DELETE_TARGET** | I2 | 564612 | TEXT, TRANSACTION_LINEAGE, BASELINE_ABSENT | 3 |
| `action_items` | `639daf7e` | **DELETE_TARGET** | I1 | 537427 | TEXT, FK, TRANSACTION_LINEAGE, BASELINE_ABSENT | 4 |
| `action_items` | `12d7532f` | **DELETE_TARGET** | I1 | 537427 | TEXT, TRANSACTION_LINEAGE, BASELINE_ABSENT | 3 |
| `action_items` | `cdcb3e57` | **DELETE_TARGET** | I2 | 564612 | TEXT, FK, TRANSACTION_LINEAGE, BASELINE_ABSENT | 4 |
| `action_items` | `cf55cbbc` | **DELETE_TARGET** | I2 | 564612 | TEXT, TRANSACTION_LINEAGE, BASELINE_ABSENT | 3 |
| `payments` | `7b300bfe` | **DELETE_TARGET** | I1 | 537247 | TEXT, TRANSACTION_LINEAGE, BASELINE_ABSENT | 3 |
| `settings` | `p24b_fix` | **DELETE_TARGET** | I1 | 537248 | TEXT, BASELINE_ABSENT | 2 |
| `approvals` | `1fc76c28` | **DELETE_TARGET** | I1 | 537425 | FK, TRANSACTION_LINEAGE, SOURCE_PAIR, BASELINE_ABSENT | 4 |
| `approvals` | `62cd196c` | **DELETE_TARGET** | I1 | 537425 | TRANSACTION_LINEAGE, SOURCE_PAIR, BASELINE_ABSENT | 3 |
| `approvals` | `8f656a4d` | **DELETE_TARGET** | I2 | 564610 | FK, TRANSACTION_LINEAGE, SOURCE_PAIR, BASELINE_ABSENT | 4 |
| `approvals` | `f4d7db30` | **DELETE_TARGET** | I2 | 564610 | TRANSACTION_LINEAGE, SOURCE_PAIR, BASELINE_ABSENT | 3 |
| `payment_instances` | `3ab000e6` | **DELETE_TARGET** | A1 | 537435 | FK, DERIVED_FROM_FIXTURE, BASELINE_ABSENT | 3 |
| `payment_instances` | `79eccf48` | **DELETE_TARGET** | A1 | 537439 | FK, DERIVED_FROM_FIXTURE, BASELINE_ABSENT | 3 |
| `payment_instances` | `dfa79dc9` | **DELETE_TARGET** | A1 | 537438 | FK, DERIVED_FROM_FIXTURE, BASELINE_ABSENT | 3 |
| `payment_instances` | `5bcafa6a` | **DELETE_TARGET** | A2 | 564283 | FK, DERIVED_FROM_FIXTURE, BASELINE_ABSENT | 3 |
| `payment_instances` | `c79c9191` | **DELETE_TARGET** | A2 | 564284 | FK, DERIVED_FROM_FIXTURE, BASELINE_ABSENT | 3 |
| `payment_instances` | `684305b9` | **DELETE_TARGET** | A2 | 564285 | FK, DERIVED_FROM_FIXTURE, BASELINE_ABSENT | 3 |
| `payment_instances` | `8294af06` | **DELETE_TARGET** | A2 | 564286 | FK, DERIVED_FROM_FIXTURE, BASELINE_ABSENT | 3 |
| `payment_instances` | `04a8236d` | **DELETE_TARGET** | A2 | 564287 | FK, DERIVED_FROM_FIXTURE, BASELINE_ABSENT | 3 |
| `payment_instances` | `aec43bfd` | **DELETE_TARGET** | A2 | 564288 | FK, DERIVED_FROM_FIXTURE, BASELINE_ABSENT | 3 |
| `payment_instances` | `dfc12ad9` | **DELETE_TARGET** | A2 | 564289 | FK, DERIVED_FROM_FIXTURE, BASELINE_ABSENT | 3 |
| `payment_instances` | `7feca5d8` | **DELETE_TARGET** | A2 | 564290 | FK, DERIVED_FROM_FIXTURE, BASELINE_ABSENT | 3 |
| `payment_instances` | `0eacaa79` | **DELETE_TARGET** | A2 | 564291 | FK, DERIVED_FROM_FIXTURE, BASELINE_ABSENT | 3 |
| `payment_instances` | `7444214a` | **DELETE_TARGET** | A2 | 564292 | FK, DERIVED_FROM_FIXTURE, BASELINE_ABSENT | 3 |
| `payment_instances` | `6920c443` | **DELETE_TARGET** | A2 | 564293 | FK, DERIVED_FROM_FIXTURE, BASELINE_ABSENT | 3 |
| `payment_instances` | `19a3cd28` | **DELETE_TARGET** | A2 | 564294 | FK, DERIVED_FROM_FIXTURE, BASELINE_ABSENT | 3 |
| `payment_instances` | `c05e09bb` | **DELETE_TARGET** | A2 | 564295 | FK, DERIVED_FROM_FIXTURE, BASELINE_ABSENT | 3 |
| `payment_instances` | `492834d1` | **DELETE_TARGET** | A2 | 564296 | FK, DERIVED_FROM_FIXTURE, BASELINE_ABSENT | 3 |
| `payment_instances` | `74494b3c` | **DELETE_TARGET** | A2 | 564297 | FK, DERIVED_FROM_FIXTURE, BASELINE_ABSENT | 3 |
| `payment_instances` | `79c1ec15` | **DELETE_TARGET** | A2 | 564298 | FK, DERIVED_FROM_FIXTURE, BASELINE_ABSENT | 3 |
| `payment_instances` | `b183d98d` | **DELETE_TARGET** | A2 | 564299 | FK, DERIVED_FROM_FIXTURE, BASELINE_ABSENT | 3 |
| `payment_instances` | `25ad518a` | **DELETE_TARGET** | A2 | 564300 | FK, DERIVED_FROM_FIXTURE, BASELINE_ABSENT | 3 |
| `payment_instances` | `e5b90331` | **DELETE_TARGET** | A2 | 564301 | FK, DERIVED_FROM_FIXTURE, BASELINE_ABSENT | 3 |
| `payment_instances` | `375433d5` | **DELETE_TARGET** | A2 | 564302 | FK, DERIVED_FROM_FIXTURE, BASELINE_ABSENT | 3 |
| `payment_instances` | `8aef2494` | **DELETE_TARGET** | A2 | 564303 | FK, DERIVED_FROM_FIXTURE, BASELINE_ABSENT | 3 |
| `payment_instances` | `a0acd3c0` | **DELETE_TARGET** | A2 | 564304 | FK, DERIVED_FROM_FIXTURE, BASELINE_ABSENT | 3 |
| `payment_instances` | `80ef312a` | **DELETE_TARGET** | A2 | 564305 | FK, DERIVED_FROM_FIXTURE, BASELINE_ABSENT | 3 |

## Toplamlar

| tablo | n |
|---|---|
| users | 6 |
| action_items | 4 |
| payments | 1 |
| settings | 1 |
| approvals | 4 |
| payment_instances | 26 |
| **TOPLAM** | **42** |
