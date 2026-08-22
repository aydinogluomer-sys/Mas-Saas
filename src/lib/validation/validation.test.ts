// Faz 18 — Zod boundary tests.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DomainError } from "@/lib/domain-error";
import { formObject, formatIssues, parseOrIssues, parseOrThrow } from "./index";

const checkSchema = z.object({
  maturityDate: z.string().min(1),
  amount: z.coerce.number().positive(),
  direction: z.enum(["inflow", "outflow"]),
});

describe("parseOrThrow", () => {
  it("returns typed data on success, coercions applied", () => {
    const parsed = parseOrThrow(checkSchema, {
      maturityDate: "2026-09-01", amount: "1500.50", direction: "outflow",
    }, "Çek formu");
    expect(parsed.amount).toBe(1500.5);
    expect(parsed.direction).toBe("outflow");
  });

  it("throws a DomainError, so the caller may show the message", () => {
    // api-response.ts maps DomainError -> 400 with the message passed through, and everything
    // else -> a generic 500. Invalid form input must land on the first branch.
    expect(() => parseOrThrow(checkSchema, {}, "Çek formu")).toThrow(DomainError);
  });

  it("does NOT leak Zod's raw JSON issue dump", () => {
    // Zod v4's ZodError.message is a JSON array of issue objects with origin/code/format
    // internals. That is the string this helper exists to keep out of user-facing errors.
    let message = "";
    try {
      parseOrThrow(checkSchema, { maturityDate: "", amount: "-5", direction: "sideways" }, "Çek formu");
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toContain('"origin"');
    expect(message).not.toContain('"code"');
    expect(message).not.toContain("[\n");
  });

  it("names the form and the offending fields", () => {
    let message = "";
    try {
      parseOrThrow(checkSchema, { maturityDate: "2026-01-01", amount: "-5", direction: "outflow" }, "Çek formu");
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("Çek formu geçersiz");
    expect(message).toContain("amount");
  });

  it("falls back to a generic label when none is given", () => {
    expect(() => parseOrThrow(checkSchema, {})).toThrow(/Girdi geçersiz/);
  });
});

describe("formatIssues", () => {
  it("joins every issue, not just the first", () => {
    const result = checkSchema.safeParse({ maturityDate: "", amount: "0", direction: "nope" });
    expect(result.success).toBe(false);
    if (result.success) return;
    const text = formatIssues(result.error);
    expect(text.split(";")).toHaveLength(3);
  });

  it("prefixes each message with its field path", () => {
    const result = checkSchema.safeParse({ maturityDate: "2026-01-01", amount: "-1", direction: "inflow" });
    if (result.success) throw new Error("expected failure");
    expect(formatIssues(result.error)).toMatch(/^amount: /);
  });

  it("omits the path prefix for a top-level (non-object) failure", () => {
    // Note the message Zod itself produces already contains a colon ("Too small: expected
    // …"), so the assertion is that no PATH was prepended — not that no colon appears.
    const result = z.string().min(3).safeParse("ab");
    if (result.success) throw new Error("expected failure");
    expect(formatIssues(result.error)).toBe(result.error.issues[0].message);
  });
});

describe("parseOrIssues", () => {
  it("reports success with data", () => {
    const r = parseOrIssues(checkSchema, { maturityDate: "2026-09-01", amount: "10", direction: "inflow" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.amount).toBe(10);
  });

  it("reports failure with a message instead of throwing", () => {
    const r = parseOrIssues(checkSchema, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message.length).toBeGreaterThan(0);
  });
});

describe("formObject", () => {
  it("reads scalar fields", () => {
    const fd = new FormData();
    fd.set("maturityDate", "2026-09-01");
    fd.set("amount", "250.75");
    expect(formObject(fd)).toEqual({ maturityDate: "2026-09-01", amount: "250.75" });
  });

  it("collects repeated keys into an array instead of keeping only the last", () => {
    // Object.fromEntries(formData) silently drops all but the final value — the trap this
    // helper exists to avoid for multi-selects.
    const fd = new FormData();
    fd.append("tag", "a");
    fd.append("tag", "b");
    fd.append("tag", "c");
    expect(formObject(fd)).toEqual({ tag: ["a", "b", "c"] });
  });

  it("preserves an empty string rather than dropping the field", () => {
    // "operator cleared this" and "field not submitted" are different statements.
    const fd = new FormData();
    fd.set("note", "");
    const obj = formObject(fd);
    expect(obj).toHaveProperty("note", "");
  });

  it("drops File entries", () => {
    const fd = new FormData();
    fd.set("name", "kapasite");
    fd.set("upload", new File(["x"], "book.xlsx"));
    expect(formObject(fd)).toEqual({ name: "kapasite" });
  });

  it("feeds a schema end-to-end", () => {
    const fd = new FormData();
    fd.set("maturityDate", "2026-09-01");
    fd.set("amount", "1200");
    fd.set("direction", "outflow");
    expect(parseOrThrow(checkSchema, formObject(fd), "Çek formu").amount).toBe(1200);
  });
});
