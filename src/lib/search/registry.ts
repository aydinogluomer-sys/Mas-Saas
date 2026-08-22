// Faz 35 — the searchable-entity registry.
//
// ═══ WHY THIS IS A CLOSED REGISTRY AND NOT A QUERY BUILDER ═══
//
// Every table name, column name and href in this file is a LITERAL, written by hand and checked
// against the live schema by introspection before being added. Nothing here is assembled from
// user input, and nothing here can be assembled from a language model's output.
//
// That is the entire safety design of natural-language search: the model may only choose WHICH
// registry entry to use and WHAT to put in a bound parameter. It can never name a table, name a
// column, or contribute a fragment of SQL — because no code path exists that would let it. A
// model that returned `parties; drop table invoices` produces a Zod validation failure, not a
// query.
//
// Pure: no database, no LLM. Just definitions.

export type SearchEntityKey =
  | "parties" | "invoices" | "payment_instances" | "checks" | "loans"
  | "bank_transactions" | "promise_to_pay" | "documents" | "audit_logs";

export interface SearchEntity {
  key: SearchEntityKey;
  label: string;
  /** Real table or view name. Literal, never interpolated from input. */
  table: string;
  /** Columns matched with ILIKE. Literals. */
  textColumns: readonly string[];
  /** Column rendered as the result title. */
  titleColumn: string;
  /** Optional date column, so "son 30 gün" can be applied. */
  dateColumn: string | null;
  /** Optional amount column, so "10.000 TL üzeri" can be applied. */
  amountColumn: string | null;
  /** Where a result links to. `:id` is replaced with the row id, never with user text. */
  hrefTemplate: string;
  /**
   * Faz 24B access class of the underlying table.
   *
   * Recorded here so the gate can assert that NOTHING in this registry is a table some tier
   * cannot read. Search must never be the one place a restricted table becomes visible.
   */
  accessClass: "reference" | "operational" | "evidence" | "derived" | "config";
}

export const SEARCH_ENTITIES: Readonly<Record<SearchEntityKey, SearchEntity>> = Object.freeze({
  parties: {
    key: "parties", label: "Karşı taraf", table: "parties",
    textColumns: ["name", "notes"], titleColumn: "name",
    dateColumn: "created_at", amountColumn: null,
    hrefTemplate: "/finance/counterparties?party=:id", accessClass: "reference",
  },
  invoices: {
    key: "invoices", label: "Fatura", table: "invoices",
    textColumns: ["invoice_no", "notes"], titleColumn: "invoice_no",
    dateColumn: "issue_date", amountColumn: "gross_amount",
    hrefTemplate: "/finance/invoices?invoice=:id", accessClass: "operational",
  },
  payment_instances: {
    key: "payment_instances", label: "Ödeme", table: "payment_instances",
    // payment_instances carries no text column of its own; `note` is the only free text.
    textColumns: ["note"], titleColumn: "note",
    dateColumn: "due_date", amountColumn: "amount",
    hrefTemplate: "/payments/calendar?instance=:id", accessClass: "operational",
  },
  checks: {
    key: "checks", label: "Çek", table: "checks",
    textColumns: ["serial_no", "counterparty_label", "notes"], titleColumn: "serial_no",
    dateColumn: "maturity_date", amountColumn: "amount",
    hrefTemplate: "/finance/checks?check=:id", accessClass: "operational",
  },
  loans: {
    key: "loans", label: "Kredi", table: "loans",
    textColumns: ["name", "notes"], titleColumn: "name",
    dateColumn: "created_at", amountColumn: "principal_amount",
    hrefTemplate: "/finance/loans?loan=:id", accessClass: "operational",
  },
  bank_transactions: {
    key: "bank_transactions", label: "Banka hareketi", table: "bank_transactions",
    textColumns: ["description", "counterparty_name_raw", "reference_no", "notes"],
    titleColumn: "description",
    dateColumn: "txn_date", amountColumn: "amount",
    hrefTemplate: "/finance/bank?txn=:id", accessClass: "operational",
  },
  promise_to_pay: {
    key: "promise_to_pay", label: "Ödeme sözü", table: "promise_to_pay",
    textColumns: ["note"], titleColumn: "note",
    dateColumn: "promised_date", amountColumn: "promised_amount",
    hrefTemplate: "/finance/promises?promise=:id", accessClass: "operational",
  },
  documents: {
    key: "documents", label: "Doküman", table: "documents",
    textColumns: ["title", "description"], titleColumn: "title",
    dateColumn: "created_at", amountColumn: null,
    hrefTemplate: "/data/documents?document=:id", accessClass: "operational",
  },
  audit_logs: {
    key: "audit_logs", label: "Denetim kaydı", table: "audit_logs",
    textColumns: ["action", "entity_table"], titleColumn: "action",
    dateColumn: "created_at", amountColumn: null,
    // Evidence class: append-only, and searchable so "who touched this" has an answer.
    hrefTemplate: "/system/audit?entry=:id", accessClass: "evidence",
  },
});

export const SEARCH_ENTITY_KEYS = Object.keys(SEARCH_ENTITIES) as SearchEntityKey[];

/** Identifier guard used by the gate AND at query-build time — belt and braces. */
const SAFE_IDENT = /^[a-z_][a-z0-9_]*$/;

/**
 * Assert every literal in the registry is a plain identifier.
 *
 * Called at query-build time, not only in tests: if a future edit ever put something exotic in a
 * column name, this throws instead of concatenating it into SQL. The registry is trusted because
 * it is checked, not because it is ours.
 */
export function assertSafeIdentifiers(entity: SearchEntity): void {
  const idents = [entity.table, entity.titleColumn, ...entity.textColumns,
    entity.dateColumn, entity.amountColumn].filter((x): x is string => x != null);
  for (const ident of idents) {
    if (!SAFE_IDENT.test(ident)) {
      throw new Error(`Güvenli olmayan tanımlayıcı: ${ident} (${entity.key})`);
    }
  }
}

export function hrefFor(entity: SearchEntity, id: string): string {
  // Only the id is substituted, and it is a uuid from the database — never user text.
  return entity.hrefTemplate.replace(":id", encodeURIComponent(id));
}
