import { describe, expect, it } from "vitest";
import {
  APP_ROLES, CLASS_MATRIX, DB_ROLE, OWNER_SCOPED_TABLES, ROLE_LABEL, TABLE_CLASS,
  can, canAdministerUsers, canDecideApprovals, canSeeModule, navigationFor, readableTables,
} from "./matrix";

describe("the matrix is complete", () => {
  it("names a database role and a label for every tier", () => {
    for (const role of APP_ROLES) {
      expect(DB_ROLE[role]).toMatch(/^mas_radar_[a-z_]+$/);
      expect(ROLE_LABEL[role].length).toBeGreaterThan(0);
    }
  });

  it("defines every class for every tier", () => {
    for (const cls of Object.values(CLASS_MATRIX)) {
      for (const role of APP_ROLES) expect(Array.isArray(cls[role])).toBe(true);
    }
  });

  it("classifies every table it lists into a known class", () => {
    for (const cls of Object.values(TABLE_CLASS)) expect(CLASS_MATRIX[cls]).toBeDefined();
  });
});

describe("the tiers are actually ordered by privilege", () => {
  // The point of five tiers is that each one is a superset of the reading below it. A matrix
  // where finance_operator could do something finance_manager could not would be a mistake
  // nobody would notice from reading a single class.
  const WIDENS: [typeof APP_ROLES[number], typeof APP_ROLES[number]][] = [
    ["viewer", "finance_operator"],
    ["viewer", "finance_approver"],
    ["finance_operator", "finance_manager"],
    ["finance_approver", "finance_manager"],
  ];

  it("a higher tier can do everything the tier below it can", () => {
    for (const [lower, higher] of WIDENS) {
      for (const table of Object.keys(TABLE_CLASS)) {
        for (const action of ["select", "insert", "update", "delete"] as const) {
          if (can(lower, table, action)) {
            expect(can(higher, table, action), `${higher} < ${lower} on ${table}.${action}`).toBe(true);
          }
        }
      }
    }
  });
});

describe("the safety-critical cells", () => {
  it("viewer cannot write anywhere at all", () => {
    for (const table of Object.keys(TABLE_CLASS)) {
      for (const action of ["insert", "update", "delete"] as const) {
        expect(can("viewer", table, action), `${table}.${action}`).toBe(false);
      }
    }
  });

  it("nobody may update or delete an append-only evidence table", () => {
    const evidence = Object.entries(TABLE_CLASS).filter(([, c]) => c === "evidence").map(([t]) => t);
    expect(evidence.length).toBeGreaterThan(0);
    for (const table of evidence) {
      for (const role of APP_ROLES) {
        expect(can(role, table, "update"), `${role} on ${table}`).toBe(false);
        expect(can(role, table, "delete"), `${role} on ${table}`).toBe(false);
      }
    }
  });

  it("an operator may request approvals but never decide them", () => {
    expect(can("finance_operator", "approvals", "insert")).toBe(true);
    expect(can("finance_operator", "approvals", "update")).toBe(false);
    expect(canDecideApprovals("finance_operator")).toBe(false);
  });

  it("an approver decides but does not raise its own requests", () => {
    // Otherwise maker-checker is a split in name only: the same person on both sides.
    expect(canDecideApprovals("finance_approver")).toBe(true);
    expect(can("finance_approver", "approvals", "insert")).toBe(false);
  });

  it("nobody deletes an approval — it is the record a control was exercised", () => {
    for (const role of APP_ROLES) expect(can(role, "approvals", "delete")).toBe(false);
  });

  it("only admin may change what requires approval", () => {
    for (const role of APP_ROLES) {
      expect(can(role, "approval_rules", "update")).toBe(role === "admin");
    }
  });

  it("only admin may change settings, where the critical threshold lives", () => {
    for (const role of APP_ROLES) {
      expect(can(role, "settings", "update")).toBe(role === "admin");
    }
  });

  it("only admin administers accounts, and no tier writes sessions", () => {
    for (const role of APP_ROLES) {
      expect(canAdministerUsers(role)).toBe(role === "admin");
      expect(can(role, "sessions", "insert"), `${role} minting a session`).toBe(false);
      expect(can(role, "sessions", "update")).toBe(false);
    }
  });

  it("no tier touches the migration ledger", () => {
    for (const role of APP_ROLES) {
      for (const action of ["select", "insert", "update", "delete"] as const) {
        expect(can(role, "schema_migrations", action)).toBe(false);
      }
    }
  });

  it("an unclassified table is denied rather than allowed", () => {
    for (const role of APP_ROLES) {
      expect(can(role, "a_table_that_does_not_exist", "select")).toBe(false);
      expect(can(role, "a_table_that_does_not_exist", "insert")).toBe(false);
    }
  });
});

describe("readableTables / navigation", () => {
  it("every tier can read the financial tables — the control is over writes", () => {
    for (const role of APP_ROLES) {
      const readable = readableTables(role);
      expect(readable).toContain("payments");
      expect(readable).toContain("invoices");
      expect(readable).not.toContain("schema_migrations");
    }
  });

  it("hides the system module from tiers whose pages would refuse them anyway", () => {
    expect(canSeeModule("viewer", "/system")).toBe(false);
    expect(canSeeModule("finance_operator", "/system")).toBe(false);
    expect(canSeeModule("finance_manager", "/system")).toBe(true);
    expect(canSeeModule("admin", "/system")).toBe(true);
  });

  it("shows the financial modules to everyone, viewer included", () => {
    for (const href of ["/overview", "/payments", "/cashflow", "/finance"]) {
      for (const role of APP_ROLES) expect(canSeeModule(role, href)).toBe(true);
    }
  });

  it("leaves an unknown module visible rather than silently swallowing it", () => {
    // A new route must not disappear from the nav merely because nobody added it here.
    expect(canSeeModule("viewer", "/a-new-module")).toBe(true);
  });

  it("filters a navigation list without reordering it", () => {
    const items = [{ href: "/overview" }, { href: "/system" }, { href: "/payments" }];
    expect(navigationFor("viewer", items)).toEqual([{ href: "/overview" }, { href: "/payments" }]);
    expect(navigationFor("admin", items)).toEqual(items);
  });
});

describe("row-level scoping is claimed only where the data supports it", () => {
  it("owner-scoped tables are a subset of what an operator may update", () => {
    for (const table of OWNER_SCOPED_TABLES) {
      expect(can("finance_operator", table, "update"), table).toBe(true);
    }
  });
});
