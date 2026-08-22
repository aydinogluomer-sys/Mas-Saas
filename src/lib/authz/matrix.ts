// Faz 24B — the permission matrix, in one place.
//
// This file and migration 0058 describe the SAME model: every table belongs to one access
// class, and a class decides which tier may run which command. They are written twice because
// they are enforced in two places — PostgreSQL policies stop a query, this module stops a
// request before it becomes one — and `db:roles-rls:verify` executes both against a live
// database to prove they still agree. A drift between them is a gate failure, not a surprise
// in production.
//
// WHY THE APPLICATION CHECKS AT ALL, GIVEN RLS EXISTS
//
// RLS is the guarantee; this is the user experience. A denied write under RLS alone is either
// an exception or — for UPDATE and DELETE — silently zero rows affected, which reads to the
// operator as "nothing happened" with no reason given. Checking here turns that into a
// sentence. The order matters: this layer may never be the ONLY check, because anything it
// forgets, the database still refuses.

export const APP_ROLES = [
  "viewer",
  "finance_operator",
  "finance_approver",
  "finance_manager",
  "admin",
] as const;
export type AppRole = (typeof APP_ROLES)[number];

export const ACTIONS = ["select", "insert", "update", "delete"] as const;
export type Action = (typeof ACTIONS)[number];

export type AccessClass =
  | "reference"
  | "operational"
  | "evidence"
  | "derived"
  | "config"
  | "approval"
  | "approval_config"
  | "auth_users"
  | "auth_sessions"
  | "ledger";

/** The PostgreSQL role each tier switches into. Mirrors migration 0057. */
export const DB_ROLE: Record<AppRole, string> = {
  viewer: "mas_radar_viewer",
  finance_operator: "mas_radar_finance_operator",
  finance_approver: "mas_radar_finance_approver",
  finance_manager: "mas_radar_finance_manager",
  admin: "mas_radar_admin",
};

/**
 * Turkish labels for the tiers. The interface is Turkish and these names appear in the security
 * screen, so the mapping lives with the roles rather than being reinvented per component.
 */
export const ROLE_LABEL: Record<AppRole, string> = {
  viewer: "izleyici",
  finance_operator: "finans operatörü",
  finance_approver: "finans onaylayıcı",
  finance_manager: "finans yöneticisi",
  admin: "yönetici",
};

const ALL: Action[] = ["select", "insert", "update", "delete"];
const READ: Action[] = ["select"];
const ENTER: Action[] = ["select", "insert", "update"];
const RECORD: Action[] = ["select", "insert"];

/**
 * class -> tier -> permitted commands.
 *
 * `evidence` grants nobody UPDATE or DELETE, admin included: those tables are append-only by
 * trigger since 0022, and a matrix that claimed admin could update them would be describing a
 * capability that does not exist.
 */
export const CLASS_MATRIX: Record<AccessClass, Record<AppRole, Action[]>> = {
  reference: {
    viewer: READ, finance_operator: READ, finance_approver: READ,
    finance_manager: ALL, admin: ALL,
  },
  operational: {
    viewer: READ, finance_operator: ENTER, finance_approver: READ,
    finance_manager: ALL, admin: ALL,
  },
  evidence: {
    viewer: READ, finance_operator: RECORD, finance_approver: RECORD,
    finance_manager: RECORD, admin: RECORD,
  },
  derived: {
    viewer: READ, finance_operator: ENTER, finance_approver: READ,
    finance_manager: ALL, admin: ALL,
  },
  config: {
    viewer: READ, finance_operator: READ, finance_approver: READ,
    finance_manager: READ, admin: ALL,
  },
  // Requesting is data entry; deciding is the approver's job; nobody deletes an approval,
  // because it is the record that a control was exercised.
  //
  // finance_approver gets select+update, NOT insert: raising a request is data entry, and an
  // approver who could also raise the requests they decide is a maker-checker split in name
  // only. The gate caught this — the code said ENTER here while migration 0058 granted INSERT
  // to operator/manager/admin, and the database had it right.
  approval: {
    viewer: READ,
    finance_operator: RECORD,
    finance_approver: ["select", "update"],
    finance_manager: ENTER,
    admin: ENTER,
  },
  // Only admin may change what requires approval — a manager who could lower the threshold
  // governing their own approvals would undo maker-checker from a settings screen.
  approval_config: {
    viewer: READ, finance_operator: READ, finance_approver: READ,
    finance_manager: READ, admin: ALL,
  },
  // users: reads are row-scoped to the caller in the database (users_self_read); only admin
  // administers accounts.
  auth_users: {
    viewer: READ, finance_operator: READ, finance_approver: READ,
    finance_manager: READ, admin: ALL,
  },
  // sessions is deliberately read-only for EVERY tier, admin included. Sessions are written by
  // the login path, which runs unswitched through sessions_app_runtime — so no tier needs to
  // write them, and a tier that could would be able to mint a session for another account.
  // Split out from users because the gate proved a single `auth` class was claiming admin
  // could INSERT sessions when the database (correctly) refused.
  auth_sessions: {
    viewer: READ, finance_operator: READ, finance_approver: READ,
    finance_manager: READ, admin: READ,
  },
  // schema_migrations — owner connection only. No tier has any access at all.
  ledger: {
    viewer: [], finance_operator: [], finance_approver: [],
    finance_manager: [], admin: [],
  },
};

/**
 * Every table, and the class it belongs to. Identical to the assignment in migration 0058.
 *
 * This is exhaustive on purpose: `db:roles-rls:verify` compares these keys against pg_class and
 * fails when a table exists that nobody classified. A table missing here would otherwise get no
 * policy, be invisible to every tier, and present as an empty screen rather than an error.
 */
export const TABLE_CLASS: Record<string, AccessClass> = {
  // reference (16)
  categories: "reference",
  parties: "reference",
  counterparty_profiles: "reference",
  ibans: "reference",
  cash_accounts: "reference",
  bank_accounts: "reference",
  cost_centers: "reference",
  departments: "reference",
  projects: "reference",
  products: "reference",
  orders: "reference",
  capacity_models: "reference",
  cost_models: "reference",
  machine_assets: "reference",
  production_parts: "reference",
  external_assumptions: "reference",
  // operational (21)
  payments: "operational",
  payment_instances: "operational",
  checks: "operational",
  loans: "operational",
  loan_installments: "operational",
  invoices: "operational",
  invoice_lines: "operational",
  invoice_allocations: "operational",
  bank_transactions: "operational",
  bank_transaction_match_candidates: "operational",
  cashflow_months: "operational",
  cashflow_lines: "operational",
  finance_cost_allocations: "operational",
  cost_breakdown_lines: "operational",
  machine_minute_allocations: "operational",
  reminders: "operational",
  action_items: "operational",
  mapping_reviews: "operational",
  source_workbooks: "operational",
  source_sheets: "operational",
  import_rows: "operational",
  // evidence (7)
  audit_logs: "evidence",
  check_events: "evidence",
  iban_change_events: "evidence",
  invoice_reversals: "evidence",
  approval_steps: "evidence",
  source_cells: "evidence",
  reminder_deliveries: "evidence",
  // derived (11)
  metric_snapshots: "derived",
  cashflow_snapshots: "derived",
  ai_response_snapshots: "derived",
  reports: "derived",
  scenarios: "derived",
  scenario_runs: "derived",
  scenario_run_lines: "derived",
  scenario_assumptions: "derived",
  scenario_comparisons: "derived",
  machine_roi_snapshots: "derived",
  part_profitability_runs: "derived",
  // config / approval / auth / ledger (5)
  settings: "config",
  approvals: "approval",
  approval_rules: "approval_config",
  users: "auth_users",
  sessions: "auth_sessions",
  schema_migrations: "ledger",
};

/**
 * Tables where an operator's UPDATE is additionally restricted to rows it created. Mirrors the
 * `c_owned` list in 0058 — only tables that already carry `created_by`, because inventing an
 * owner column for the other 53 would have made every historical row unowned.
 */
export const OWNER_SCOPED_TABLES = ["action_items", "invoice_allocations", "scenarios"] as const;

/** Does this tier may run this command on this table? */
export function can(role: AppRole, table: string, action: Action): boolean {
  const cls = TABLE_CLASS[table];
  // An unclassified table is denied, not allowed. The gate fails on it separately; this makes
  // the runtime behaviour safe in the window before anyone notices.
  if (cls === undefined) return false;
  return CLASS_MATRIX[cls][role].includes(action);
}

/** Every table this tier may read — the backend half of role-based navigation. */
export function readableTables(role: AppRole): string[] {
  return Object.keys(TABLE_CLASS)
    .filter((t) => can(role, t, "select"))
    .sort();
}

/**
 * Whether a tier may decide approvals at all. Kept as a named question rather than an inline
 * `can(role,'approvals','update')` so the approval screens read as what they mean.
 */
export function canDecideApprovals(role: AppRole): boolean {
  return can(role, "approvals", "update");
}

/** Whether a tier may administer accounts. */
export function canAdministerUsers(role: AppRole): boolean {
  return can(role, "users", "update");
}

/* ── role-based navigation, backend half (Faz 24B; the UI half is Faz 36) ─────────────── */

/**
 * The minimum tier that may see each navigation module.
 *
 * Only the backend answer lives here — which modules a role is entitled to. Faz 36 owns how
 * that is presented. Keeping the decision server-side means a hidden module is genuinely
 * unreachable rather than merely unrendered: the pages behind /system already call
 * requireAdmin(), and the tables behind every module are governed by the policies above, so
 * this list is the third agreeing layer rather than the only one.
 */
const MODULE_MIN_TIER: Record<string, AppRole[]> = {
  // Everything a finance dashboard exists to show is visible to every tier, including viewer:
  // withholding the numbers from a colleague who may read them serves nobody, and the control
  // this phase adds is over writes.
  "/overview": [...APP_ROLES],
  "/payments": [...APP_ROLES],
  "/cashflow": [...APP_ROLES],
  "/finance": [...APP_ROLES],
  "/production": [...APP_ROLES],
  "/scenarios": [...APP_ROLES],
  "/insights/ask": [...APP_ROLES],
  "/data/quality": [...APP_ROLES],
  // System holds account administration, backup and security. A viewer or operator has nothing
  // actionable there and every page inside already refuses them, so showing it would only
  // offer a door that does not open.
  "/system": ["finance_manager", "admin"],
};

/** Whether this tier may see the given navigation module. Unknown modules stay visible. */
export function canSeeModule(role: AppRole, href: string): boolean {
  const allowed = MODULE_MIN_TIER[href];
  return allowed === undefined ? true : allowed.includes(role);
}

/** Filter a navigation list for a tier. Used by the dashboard layout. */
export function navigationFor<T extends { href: string }>(role: AppRole, items: T[]): T[] {
  return items.filter((item) => canSeeModule(role, item.href));
}
