// Faz 18 — audit writer tests.
//
// These assert the SQL and the parameter array, not a database round-trip. That is the right
// level for this module: the thing that could regress is the mapping from named fields to
// positional bind parameters, which is exactly what a real database would NOT catch — every
// column here is nullable jsonb/text, so swapping before and after produces a perfectly valid
// row that is simply wrong. Migration 0022's append-only triggers and the audit rows written
// by real transitions are covered by db:transitions:verify against a live database.

import { describe, expect, it, vi } from "vitest";
import { audit, type AuditClient } from "./audit";

function fakeClient(): { client: AuditClient; calls: Array<{ sql: string; params: unknown[] }> } {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[]) => {
    calls.push({ sql, params });
    return { rows: [{ id: "11111111-1111-1111-1111-111111111111" }], rowCount: 1 };
  });
  return { client: { query } as unknown as AuditClient, calls };
}

describe("column order is not guessable — it is asserted", () => {
  it("binds actor, action, entity_table, entity_id, before, after in that order", async () => {
    const { client, calls } = fakeClient();
    await audit(client, {
      actor: "actor-1",
      action: "mark_paid",
      entityTable: "payment_instances",
      entityId: "inst-1",
      before: { status: "unpaid" },
      after: { status: "paid" },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].params).toEqual([
      "actor-1",
      "mark_paid",
      "payment_instances",
      "inst-1",
      JSON.stringify({ status: "unpaid" }),
      JSON.stringify({ status: "paid" }),
    ]);
  });

  it("puts before BEFORE after — the bug the old financing helper invited", async () => {
    // financing/engine.ts's local helper took (…, after, before?), the opposite of every
    // other copy. With a named-field API the mistake cannot be made, but this test pins the
    // resulting column order so a future edit to the SQL cannot silently swap them.
    const { client, calls } = fakeClient();
    await audit(client, {
      actor: "a", action: "mark_check_cleared", entityTable: "checks", entityId: "c1",
      before: { status: "planned" },
      after: { status: "cleared" },
    });
    const [, , , , beforeParam, afterParam] = calls[0].params as string[];
    expect(JSON.parse(beforeParam)).toEqual({ status: "planned" });
    expect(JSON.parse(afterParam)).toEqual({ status: "cleared" });
    expect(calls[0].sql).toMatch(/before_data,\s*after_data/);
  });
});

describe("omitted fields become explicit nulls, not undefined", () => {
  it("a creation with no before writes null, not the string 'undefined'", async () => {
    const { client, calls } = fakeClient();
    await audit(client, {
      actor: "a", action: "create_user", entityTable: "users", entityId: "u1",
      after: { username: "x" },
    });
    expect(calls[0].params[4]).toBe("null");
    expect(calls[0].params[4]).not.toBe(undefined);
  });

  it("an action with no payload at all writes null for both", async () => {
    const { client, calls } = fakeClient();
    await audit(client, { actor: "a", action: "noop", entityTable: "t" });
    expect(calls[0].params[4]).toBe("null");
    expect(calls[0].params[5]).toBe("null");
  });

  it("entityId defaults to null for batch actions with no single subject", async () => {
    // generate_instances / reconcile_instances / snapshot refresh all rely on this.
    const { client, calls } = fakeClient();
    await audit(client, {
      actor: "a", action: "generate_instances", entityTable: "payment_instances",
      after: { created: 12 },
    });
    expect(calls[0].params[3]).toBeNull();
  });

  it("a null actor is preserved — system work has no interactive user", async () => {
    const { client, calls } = fakeClient();
    await audit(client, { actor: null, action: "legacy_repair_summary", entityTable: "legacy_repair" });
    expect(calls[0].params[0]).toBeNull();
  });
});

describe("createdAt override", () => {
  it("is left to the column default when omitted", async () => {
    const { client, calls } = fakeClient();
    await audit(client, { actor: "a", action: "x", entityTable: "t", entityId: "1" });
    expect(calls[0].sql).not.toContain("created_at");
    expect(calls[0].params).toHaveLength(6);
  });

  it("is bound as a seventh parameter when supplied", async () => {
    const { client, calls } = fakeClient();
    await audit(client, {
      actor: null, action: "legacy_cancel_metadata_repair", entityTable: "payment_instances",
      entityId: "i1", createdAt: "2026-01-02T03:04:05.000Z",
    });
    expect(calls[0].sql).toContain("created_at");
    expect(calls[0].params).toHaveLength(7);
    expect(calls[0].params[6]).toBe("2026-01-02T03:04:05.000Z");
  });
});

describe("the inserted id is returned", () => {
  it("returns the id so legacy repair can link its receipt", async () => {
    const { client } = fakeClient();
    const id = await audit(client, { actor: "a", action: "x", entityTable: "t" });
    expect(id).toBe("11111111-1111-1111-1111-111111111111");
  });

  it("always asks for it, so no caller has to opt in", async () => {
    const { client, calls } = fakeClient();
    await audit(client, { actor: "a", action: "x", entityTable: "t" });
    expect(calls[0].sql).toContain("returning id");
  });
});

describe("payload encoding matches what the thirteen helpers wrote", () => {
  it("stringifies objects rather than passing them to pg as objects", async () => {
    const { client, calls } = fakeClient();
    await audit(client, {
      actor: "a", action: "x", entityTable: "t", entityId: "1",
      before: { a: 1 }, after: { b: [1, 2] },
    });
    expect(typeof calls[0].params[4]).toBe("string");
    expect(typeof calls[0].params[5]).toBe("string");
    expect(calls[0].params[5]).toBe('{"b":[1,2]}');
  });

  it("an explicit null payload is indistinguishable from an omitted one, as before", async () => {
    const { client, calls } = fakeClient();
    await audit(client, { actor: "a", action: "x", entityTable: "t", before: null, after: null });
    expect(calls[0].params[4]).toBe("null");
    expect(calls[0].params[5]).toBe("null");
  });
});
