import { beforeEach, describe, expect, it } from "vitest";
import {
  fingerprint, getSlowThreshold, recordQuery, resetSlowQueryStats,
  setSlowThreshold, slowQueryReport,
} from "./slow-query";

beforeEach(() => {
  resetSlowQueryStats();
  setSlowThreshold(200);
});

describe("fingerprint", () => {
  it("collapses two queries that differ only in their values", () => {
    const a = fingerprint("select * from invoices where party_id = '9f2c-aaa' and gross_amount > 1500.75");
    const b = fingerprint("select * from invoices where party_id = '3a1b-bbb' and gross_amount > 99.10");
    expect(a).toBe(b);
  });

  it("NEVER retains a parameter value — the values are financial data", () => {
    const fp = fingerprint(
      "select * from invoices where counterparty = 'ACME SANAYİ A.Ş.' and gross_amount = 1234567.89");
    expect(fp).not.toContain("ACME");
    expect(fp).not.toContain("1234567");
  });

  it("keeps different query SHAPES distinct", () => {
    expect(fingerprint("select a from t where x = $1"))
      .not.toBe(fingerprint("select b from t where x = $1"));
  });

  it("handles escaped quotes without leaking the tail of the string", () => {
    const fp = fingerprint("select * from t where name = 'O''BRIEN SECRET' and id = 5");
    expect(fp).not.toContain("BRIEN");
    expect(fp).not.toContain("SECRET");
  });

  it("normalises whitespace so formatting does not fork a shape", () => {
    expect(fingerprint("select  a\n  from   t")).toBe(fingerprint("select a from t"));
  });
});

describe("recordQuery", () => {
  it("ignores anything under the threshold", () => {
    recordQuery("select 1", 5);
    expect(slowQueryReport().rows).toHaveLength(0);
  });

  it("records and aggregates slow queries by shape", () => {
    recordQuery("select * from t where id = $1", 300);
    recordQuery("select * from t where id = $1", 500);
    const rows = slowQueryReport().rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(2);
    expect(rows[0].totalMs).toBe(800);
    expect(rows[0].maxMs).toBe(500);
  });

  it("ranks by CUMULATIVE time, so a frequent mid-cost query outranks one rare outlier", () => {
    recordQuery("select frequent from t", 250);
    recordQuery("select frequent from t", 250);
    recordQuery("select frequent from t", 250);
    recordQuery("select frequent from t", 250);
    recordQuery("select rare from t", 900);
    const rows = slowQueryReport().rows;
    expect(rows[0].fingerprint).toContain("frequent");
    expect(rows[0].totalMs).toBe(1000);
  });

  it("never throws on hostile input — instrumentation must not break the observed", () => {
    expect(() => recordQuery("", Number.NaN)).not.toThrow();
    expect(() => recordQuery("select 1", Number.POSITIVE_INFINITY)).not.toThrow();
    expect(() => recordQuery("select 1", -1)).not.toThrow();
  });

  it("is bounded — a pathological workload cannot grow the buffer without limit", () => {
    for (let i = 0; i < 500; i++) recordQuery(`select col${i} from t`, 300);
    const report = slowQueryReport(1000);
    expect(report.shapes).toBeLessThanOrEqual(200);
    expect(report.dropped).toBeGreaterThan(0);
  });

  it("respects a changed threshold", () => {
    setSlowThreshold(1000);
    expect(getSlowThreshold()).toBe(1000);
    recordQuery("select * from t", 500);
    expect(slowQueryReport().rows).toHaveLength(0);
    recordQuery("select * from t", 1500);
    expect(slowQueryReport().rows).toHaveLength(1);
  });
});
