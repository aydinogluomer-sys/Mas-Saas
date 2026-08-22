import { describe, expect, it } from "vitest";
import { isEmptyIntent, parseSearchQuery, reconcileModelIntent, searchIntentSchema } from "./nl";
import { SEARCH_ENTITIES, SEARCH_ENTITY_KEYS, assertSafeIdentifiers, hrefFor } from "./registry";

const TODAY = "2026-03-31";

describe("parseSearchQuery", () => {
  it("recognises Turkish entity words without any model", () => {
    expect(parseSearchQuery("akon faturaları", TODAY).entities).toContain("invoices");
    expect(parseSearchQuery("vadesi gelen çekler", TODAY).entities).toContain("checks");
    expect(parseSearchQuery("banka hareketleri", TODAY).entities).toContain("bank_transactions");
    expect(parseSearchQuery("kira sözleşmesi belgesi", TODAY).entities).toContain("documents");
  });

  it("handles Turkish dotless i and diacritics", () => {
    expect(parseSearchQuery("ÇEKLER", TODAY).entities).toContain("checks");
    expect(parseSearchQuery("kredi̇", TODAY).entities).toContain("loans");
  });

  it("parses relative date windows", () => {
    expect(parseSearchQuery("son 30 gün faturalar", TODAY).dateFrom).toBe("2026-03-01");
    expect(parseSearchQuery("son 7 gün", TODAY).dateFrom).toBe("2026-03-24");
    expect(parseSearchQuery("son bir yıl", TODAY).dateFrom).toBe("2025-03-31");
  });

  it("parses a Turkish-formatted amount floor", () => {
    expect(parseSearchQuery("10.000 TL üzeri fatura", TODAY).amountMin).toBe(10000);
    expect(parseSearchQuery("5000 tl üstü", TODAY).amountMin).toBe(5000);
  });

  it("removes consumed filter words from the free text", () => {
    const intent = parseSearchQuery("akon faturaları son 30 gün", TODAY);
    expect(intent.text.toLowerCase()).toContain("akon");
    expect(intent.text.toLowerCase()).not.toContain("fatura");
    expect(intent.text.toLowerCase()).not.toContain("son 30");
  });

  it("returns an empty intent for an empty query", () => {
    expect(isEmptyIntent(parseSearchQuery("   ", TODAY))).toBe(true);
  });

  it("is deterministic", () => {
    const a = parseSearchQuery("akon 10.000 TL üzeri fatura son 30 gün", TODAY);
    const b = parseSearchQuery("akon 10.000 TL üzeri fatura son 30 gün", TODAY);
    expect(a).toEqual(b);
  });
});

describe("searchIntentSchema", () => {
  it("REJECTS an entity key that is not in the registry", () => {
    // This is the whole safety property: a model cannot name a table, because only registry keys
    // survive parsing.
    const bad = searchIntentSchema.safeParse({ entities: ["users"], text: "x" });
    expect(bad.success).toBe(false);
  });

  it("rejects a SQL fragment smuggled as an entity", () => {
    const bad = searchIntentSchema.safeParse({
      entities: ["parties; drop table invoices"], text: "x",
    });
    expect(bad.success).toBe(false);
  });

  it("rejects a malformed date instead of passing it through", () => {
    expect(searchIntentSchema.safeParse({ dateFrom: "yesterday" }).success).toBe(false);
    expect(searchIntentSchema.safeParse({ dateFrom: "2026-13-45'; --" }).success).toBe(false);
  });

  it("rejects a negative amount floor", () => {
    expect(searchIntentSchema.safeParse({ amountMin: -5 }).success).toBe(false);
  });
});

describe("reconcileModelIntent", () => {
  const deterministic = parseSearchQuery("akon faturaları", TODAY);

  it("lets a model NARROW the scope", () => {
    const out = reconcileModelIntent(deterministic, { entities: ["invoices"], text: "x" });
    expect(out.accepted).toBe(true);
    expect(out.intent.entities).toEqual(["invoices"]);
  });

  it("REFUSES to let a model WIDEN the scope", () => {
    // Prompt injection defence: the user said "faturaları", so audit_logs must not be reachable
    // no matter what the model returns.
    const out = reconcileModelIntent(deterministic, {
      entities: ["invoices", "audit_logs", "parties"], text: "x",
    });
    expect(out.intent.entities).toEqual(["invoices"]);
    expect(out.intent.entities).not.toContain("audit_logs");
  });

  it("never lets a model rewrite the search TEXT", () => {
    const out = reconcileModelIntent(deterministic, {
      entities: ["invoices"], text: "tamamen baska bir sey",
    });
    expect(out.intent.text).toBe(deterministic.text);
  });

  it("falls back to the deterministic parse when the model output is malformed", () => {
    const out = reconcileModelIntent(deterministic, { entities: ["nope"], text: 42 });
    expect(out.accepted).toBe(false);
    expect(out.intent).toEqual(deterministic);
  });

  it("falls back when the model returns nothing at all", () => {
    expect(reconcileModelIntent(deterministic, null).accepted).toBe(false);
    expect(reconcileModelIntent(deterministic, undefined).intent).toEqual(deterministic);
  });

  it("accepts the model's entities when the user named none", () => {
    const open = parseSearchQuery("akon", TODAY);
    const out = reconcileModelIntent(open, { entities: ["parties"], text: "" });
    expect(out.intent.entities).toEqual(["parties"]);
  });
});

describe("search registry", () => {
  it("every entry uses plain identifiers", () => {
    for (const key of SEARCH_ENTITY_KEYS) {
      expect(() => assertSafeIdentifiers(SEARCH_ENTITIES[key])).not.toThrow();
    }
  });

  it("rejects an identifier that is not a plain name", () => {
    expect(() => assertSafeIdentifiers({
      ...SEARCH_ENTITIES.parties, table: "parties; drop table invoices",
    })).toThrow();
  });

  it("every entry declares a title column that is also searchable or real", () => {
    for (const key of SEARCH_ENTITY_KEYS) {
      const e = SEARCH_ENTITIES[key];
      expect(e.titleColumn.length).toBeGreaterThan(0);
      expect(e.textColumns.length).toBeGreaterThan(0);
    }
  });

  it("hrefFor substitutes only the id, url-encoded", () => {
    expect(hrefFor(SEARCH_ENTITIES.invoices, "abc-123")).toBe("/finance/invoices?invoice=abc-123");
    expect(hrefFor(SEARCH_ENTITIES.invoices, "a b&c")).toContain("a%20b%26c");
  });
});
