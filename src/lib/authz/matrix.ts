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
  | "planning_line"
  | "evidence"
  | "derived"
  | "config"
  | "personal"
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
  // Faz 39 (0098): budget_lines and forecast_lines may be drafted by finance_operator (draft only,
  // enforced by enforce_planning_approval_role() trigger), approved (draft -> approved, maker !=
  // checker, without altering amounts/dimensions) by finance_approver, and managed by manager/admin.
  planning_line: {
    viewer: READ,
    finance_operator: ENTER,
    finance_approver: ["select", "update"],
    finance_manager: ALL,
    admin: ALL,
  },
  // Viewer stays READ at class level, and the generic insert probe in db:roles-rls:verify still
  // sees viewer refused on every evidence table. The one row-level exception, stated here so no
  // reader has to rediscover it: migration 0096 lets a viewer INSERT into audit_logs exactly the
  // row recording its OWN password change (action 'change_own_password', entity 'users', actor
  // and entity_id = current_app_user()). Without it the forced password change (0095) could not
  // be audited for viewers, and an unaudited credential change is not an option this schema
  // allows. It writes no business data and needs the viewer's own app.user_id, so a viewer-tier
  // machine identity (runAsReadOnlySystem, no user id) still cannot write anything.
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
  // Faz 36. A saved view is a PERSONAL WORKING PREFERENCE, not company data, and `operational`
  // was written for financial records — an approver may keep their own filters even though they
  // may not edit an invoice. Row-level ownership (migration 0084) limits the blast radius; this
  // class only says "you may manage personal rows at all".
  personal: {
    viewer: READ, finance_operator: ALL, finance_approver: ALL,
    finance_manager: ALL, admin: ALL,
  },
  // Requesting is data entry; deciding is the approver's job; nobody deletes an approval,
  // because it is the record that a control was exercised.
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
  // Faz 39 (0098): sessions stays un-insertable for every tier (sessions are minted only on the
  // unswitched login path via sessions_app_runtime), while admin gains row-level SELECT + UPDATE
  // solely to count and revoke active sessions (revoked_at IS NULL -> NOT NULL).
  auth_sessions: {
    viewer: READ, finance_operator: READ, finance_approver: READ,
    finance_manager: READ, admin: ["select", "update"],
  },
  // schema_migrations — owner connection only. No tier has any access at all.
  ledger: {
    viewer: [], finance_operator: [], finance_approver: [],
    finance_manager: [], admin: [],
  },
};

/**
 * Every table, and the class it belongs to. Identical to the assignment in migration 0058 + 0098.
 *
 * This is exhaustive on purpose: `db:roles-rls:verify` compares these keys against pg_class and
 * fails when a table exists that nobody classified.
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
  management_accounts: "reference",
  // operational & planning_line
  payments: "operational",
  payment_instances: "operational",
  checks: "operational",
  check_bordros: "operational",
  loans: "operational",
  loan_installments: "operational",
  invoices: "operational",
  invoice_lines: "operational",
  invoice_allocations: "operational",
  payment_runs: "operational",
  payment_run_items: "operational",
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
  promise_to_pay: "operational",
  credit_facilities: "operational",
  facility_movements: "operational",
  collateral_records: "operational",
  covenant_records: "operational",
  cost_model_items: "operational",
  fx_positions: "operational",
  budgets: "operational",
  budget_lines: "planning_line",
  forecasts: "operational",
  forecast_lines: "planning_line",
  optimization_runs: "operational",
  optimization_recommendations: "operational",
  background_jobs: "operational",
  integration_connections: "config",
  integration_sync_runs: "operational",
  integration_entity_links: "operational",
  integration_account_mappings: "operational",
  integration_staged_parties: "operational",
  management_journal_entries: "operational",
  management_journal_lines: "operational",
  statutory_trial_balances: "operational",
  statutory_trial_balance_lines: "operational",
  trial_balance_reconciliation_runs: "operational",
  trial_balance_reconciliation_items: "operational",
  forecast_snapshots_13w: "operational",
  forecast_snapshot_13w_lines: "operational",
  assistant_conversations: "personal",
  saved_views: "personal",
  documents: "operational",
  document_links: "operational",
  attachments: "evidence",
  control_alerts: "operational",
  source_sheets: "operational",
  import_rows: "operational",
  import_external_keys: "operational",
  // evidence
  audit_logs: "evidence",
  check_events: "evidence",
  iban_change_events: "evidence",
  invoice_reversals: "evidence",
  approval_steps: "evidence",
  source_cells: "evidence",
  reminder_deliveries: "evidence",
  fx_rate_snapshots: "evidence",
  reconciliation_signoffs: "evidence",
  integration_raw_payloads: "evidence",
  // derived
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
  // config / approval / auth / ledger
  settings: "config",
  treasury_policies: "config",
  cost_allocation_rules: "config",
  alert_escalation_rules: "config",
  approvals: "approval",
  approval_rules: "approval_config",
  approval_governance_settings: "approval_config",
  users: "auth_users",
  sessions: "auth_sessions",
  schema_migrations: "ledger",
};

/**
 * Tables where an operator's writes/updates are additionally restricted to rows it created.
 */
export const OWNER_SCOPED_TABLES = [
  "action_items",
  "invoice_allocations",
  "scenarios",
  "saved_views",
  "assistant_conversations",
  "background_jobs",
] as const;

/** Does this tier may run this command on this table? */
export function can(role: AppRole, table: string, action: Action): boolean {
  const cls = TABLE_CLASS[table];
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

/** Faz 39 (0098): whether a tier may transition budget_lines / forecast_lines to 'approved'. */
export function canApprovePlanningLines(role: AppRole): boolean {
  return role === "finance_approver" || role === "finance_manager" || role === "admin";
}

/** Faz 45 (0100): whether a tier may lock or reopen a financial period (cashflow_months). */
export function canManagePeriodLock(role: AppRole): boolean {
  return role === "finance_manager" || role === "admin";
}

/** Whether a tier may administer accounts. */
export function canAdministerUsers(role: AppRole): boolean {
  return can(role, "users", "update");
}

/* ── role-based navigation, backend half (Faz 24B; the UI half is Faz 36) ─────────────── */

const MODULE_MIN_TIER: Record<string, AppRole[]> = {
  "/": [...APP_ROLES],
  "/overview": [...APP_ROLES],
  "/payments": [...APP_ROLES],
  "/cashflow": [...APP_ROLES],
  "/finance": [...APP_ROLES],
  "/production": [...APP_ROLES],
  "/scenarios": [...APP_ROLES],
  "/insights/ask": [...APP_ROLES],
  "/data/quality": [...APP_ROLES],
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

/* ── role-based navigation, UI half (Faz 36) ─────────────────────────────────────────── */

const ROUTE_MIN_TIER: Record<string, AppRole[]> = {
  "/system/backup": ["admin"],
  "/system/security": ["admin"],
  "/system/diagnostics": ["admin"],
  "/data/approvals": ["finance_approver", "finance_manager", "admin"],
  "/data/imports/v2": ["finance_operator", "finance_manager", "admin"],
  "/data/integrations": ["finance_operator", "finance_manager", "admin"],
  "/data/trial-balance-bridge": ["finance_operator", "finance_approver", "finance_manager", "admin"],
};

export function canSeeRoute(role: AppRole, href: string): boolean {
  const explicit = ROUTE_MIN_TIER[href];
  if (explicit !== undefined) return explicit.includes(role);

  const modules = Object.keys(MODULE_MIN_TIER)
    .filter((m) => href === m || href.startsWith(`${m}/`))
    .sort((a, b) => b.length - a.length);
  if (modules.length > 0) return canSeeModule(role, modules[0]);
  return true;
}

export function tabsFor<T extends { href: string }>(role: AppRole, tabs: T[]): T[] {
  return tabs.filter((tab) => canSeeRoute(role, tab.href));
}

/** Every route this tier may see, for the gate to enumerate. */
export const GATED_ROUTES: readonly string[] = Object.freeze([
  ...Object.keys(MODULE_MIN_TIER), ...Object.keys(ROUTE_MIN_TIER),
]);

/* ── capability gates for in-page actions (Faz 36) ────────────────────────────────────── */

export const UI_CAPABILITIES = {
  create_document: { table: "documents", action: "insert" },
  upload_attachment: { table: "attachments", action: "insert" },
  enqueue_job: { table: "background_jobs", action: "insert" },
  replay_dead_letter: { table: "background_jobs", action: "update" },
  generate_report: { table: "reports", action: "insert" },
  save_view: { table: "saved_views", action: "insert" },
  decide_approval: { table: "approvals", action: "update" },
  approve_planning_line: { table: "budget_lines", action: "update" },
  edit_payment: { table: "payments", action: "update" },
  import_workbook_v2: { table: "source_workbooks", action: "insert" },
} as const satisfies Record<string, { table: string; action: Action }>;

export type UiCapability = keyof typeof UI_CAPABILITIES;

export function canPerform(role: AppRole, capability: UiCapability): boolean {
  if (capability === "approve_planning_line") {
    return canApprovePlanningLines(role);
  }
  const spec = UI_CAPABILITIES[capability];
  return can(role, spec.table, spec.action);
}
