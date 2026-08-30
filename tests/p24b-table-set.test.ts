import { describe, expect, it } from "vitest";
import { tableSetDiff, tableSetKey, type BaseTableRef } from "../scripts/db/p24b-cleanup-fingerprint";

/**
 * P24B v2.3.1 — the catalog-drift comparison.
 *
 * The cleanup's whole-database lock freezes DML on the tables that EXISTED when it was taken. It
 * cannot freeze the catalog: a concurrent migration could still CREATE a table, and that table
 * would sit outside both the lock and the fingerprint — invisible to every other gate.
 *
 * Reproducing that race against a live PostgreSQL is awkward and slow (the DDL would have to be
 * timed into a narrow window inside a held transaction). The DECISION, however, is a pure
 * comparison, so it is tested here directly and exhaustively; the cleanup calls this same function
 * at the start of its transaction and again immediately before COMMIT.
 */

const t = (...names: string[]): BaseTableRef[] =>
  names.map((n) => { const [schema, name] = n.split("."); return { schema, name }; });

describe("tableSetKey", () => {
  it("sıradan bağımsız — katalog sırası değişse de anahtar aynı", () => {
    expect(tableSetKey(t("public.b", "auth.a"))).toBe(tableSetKey(t("auth.a", "public.b")));
  });

  it("şema farkı ayırt ediliyor", () => {
    expect(tableSetKey(t("public.users"))).not.toBe(tableSetKey(t("auth.users")));
  });
});

describe("tableSetDiff", () => {
  it("aynı küme: equal", () => {
    const d = tableSetDiff(t("public.a", "public.b"), t("public.b", "public.a"));
    expect(d).toEqual({ equal: true, added: [], removed: [] });
  });

  it("eşzamanlı migration yeni tablo ekledi → yakalanıyor", () => {
    const d = tableSetDiff(t("public.a"), t("public.a", "public.yeni"));
    expect(d.equal).toBe(false);
    expect(d.added).toEqual(["public.yeni"]);
    expect(d.removed).toEqual([]);
  });

  it("tablo düşürüldü → yakalanıyor", () => {
    const d = tableSetDiff(t("public.a", "public.b"), t("public.a"));
    expect(d.equal).toBe(false);
    expect(d.removed).toEqual(["public.b"]);
  });

  it("hem ekleme hem kaldırma aynı anda", () => {
    const d = tableSetDiff(t("public.a", "public.b"), t("public.a", "public.c"));
    expect(d.equal).toBe(false);
    expect(d.added).toEqual(["public.c"]);
    expect(d.removed).toEqual(["public.b"]);
  });

  it("aynı adın farklı şemada belirmesi ekleme sayılıyor", () => {
    const d = tableSetDiff(t("public.users"), t("public.users", "auth.users"));
    expect(d.equal).toBe(false);
    expect(d.added).toEqual(["auth.users"]);
  });

  it("boş küme sınır durumu", () => {
    expect(tableSetDiff([], []).equal).toBe(true);
    expect(tableSetDiff([], t("public.a")).added).toEqual(["public.a"]);
    expect(tableSetDiff(t("public.a"), []).removed).toEqual(["public.a"]);
  });

  it("86 tablodan biri değişince equal false", () => {
    const before = t(...Array.from({ length: 86 }, (_, i) => `public.t${i}`));
    const after = before.slice(0, 85).concat(t("public.baska"));
    const d = tableSetDiff(before, after);
    expect(d.equal).toBe(false);
    expect(d.added).toEqual(["public.baska"]);
    expect(d.removed).toEqual(["public.t85"]);
  });
});
