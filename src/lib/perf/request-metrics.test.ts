import { afterEach, describe, expect, it } from "vitest";
import {
  countingClient,
  disarmProbe,
  isProbeArmed,
  measureRequestQueries,
  readAndResetProbe,
  recordRequestQuery,
  sqlTextOf,
  armProbe,
} from "./request-metrics";

afterEach(() => {
  disarmProbe();
});

describe("recordRequestQuery — kapsam yokken", () => {
  it("hiçbir şey biriktirmez (üretim yolu)", () => {
    recordRequestQuery("select * from public.invoices where id = $1", 12);
    // Kapsam açık olmadığı için probe kovası hâlâ kurulmamış olmalı.
    expect(isProbeArmed()).toBe(false);
  });
});

describe("measureRequestQueries", () => {
  it("kapsam içindeki her sorguyu sayar ve DB süresini toplar", async () => {
    const { value, metrics } = await measureRequestQueries(async () => {
      recordRequestQuery("select 1", 2);
      recordRequestQuery("select 2", 3.5);
      return "bitti";
    });
    expect(value).toBe("bitti");
    expect(metrics.queryCount).toBe(2);
    expect(metrics.totalDbTimeMs).toBeCloseTo(5.5, 3);
  });

  it("en yavaş sorguyu ŞEKİL olarak tutar, değerlerini değil", async () => {
    const { metrics } = await measureRequestQueries(async () => {
      recordRequestQuery("select 1", 1);
      recordRequestQuery(
        "select * from public.invoices where counterparty = 'ACME SANAYİ A.Ş.' and gross_amount = 1234567.89",
        90,
      );
    });
    expect(metrics.slowestQueryMs).toBeCloseTo(90, 3);
    expect(metrics.slowestQueryShape).not.toBeNull();
    expect(metrics.slowestQueryShape).not.toContain("ACME");
    expect(metrics.slowestQueryShape).not.toContain("1234567");
    expect(metrics.slowestQueryShape).toContain("gross_amount = ?");
  });

  it("kapsam kapandıktan sonra sayaç yeniden ölür", async () => {
    await measureRequestQueries(async () => {
      recordRequestQuery("select 1", 1);
    });
    recordRequestQuery("select 2", 1);
    const { metrics } = await measureRequestQueries(async () => {});
    expect(metrics.queryCount).toBe(0);
  });

  it("iç içe kapsamda iç kapsam kazanır (dış sayaç kirlenmez)", async () => {
    const outer = await measureRequestQueries(async () => {
      recordRequestQuery("select outer", 1);
      const inner = await measureRequestQueries(async () => {
        recordRequestQuery("select inner", 5);
      });
      expect(inner.metrics.queryCount).toBe(1);
    });
    expect(outer.metrics.queryCount).toBe(1);
  });

  it("geçersiz süreyi yok sayar — gözlem, gözlenen şeyi bozmaz", async () => {
    const { metrics } = await measureRequestQueries(async () => {
      recordRequestQuery("select 1", Number.NaN);
      recordRequestQuery("select 1", -3);
    });
    expect(metrics.queryCount).toBe(0);
  });
});

describe("probe penceresi", () => {
  it("her okuma pencereyi sıfırlar", () => {
    armProbe();
    recordRequestQuery("select a", 4);
    recordRequestQuery("select b", 6);
    const first = readAndResetProbe();
    expect(first.queryCount).toBe(2);
    expect(first.totalDbTimeMs).toBeCloseTo(10, 3);
    const second = readAndResetProbe();
    expect(second.queryCount).toBe(0);
    expect(second.slowestQueryShape).toBeNull();
  });

  it("kurulmadan önce hiçbir şey saymaz", () => {
    recordRequestQuery("select a", 4);
    armProbe();
    expect(readAndResetProbe().queryCount).toBe(0);
  });
});

describe("sqlTextOf", () => {
  it("iki pg çağrı biçimini de tanır", () => {
    expect(sqlTextOf("select 1")).toBe("select 1");
    expect(sqlTextOf({ text: "select 2", values: [1] })).toBe("select 2");
    expect(sqlTextOf(undefined)).toBeUndefined();
    expect(sqlTextOf(null)).toBeUndefined();
    expect(sqlTextOf(42)).toBeUndefined();
  });
});

describe("countingClient", () => {
  function fakeClient() {
    const calls: string[] = [];
    return {
      calls,
      released: 0,
      query: async (sql: string) => {
        calls.push(sql);
        return { rows: [] };
      },
      release() {
        this.released += 1;
      },
    };
  }

  it("kapsam yokken istemciyi OLDUĞU GİBİ geri verir (sarmalayıcı kurulmaz)", () => {
    const client = fakeClient();
    expect(countingClient(client)).toBe(client);
  });

  it("kapsam içinde pool.connect() sorgularını sayar", async () => {
    const client = fakeClient();
    const { metrics } = await measureRequestQueries(async () => {
      const wrapped = countingClient(client);
      await wrapped.query("begin");
      await wrapped.query("update public.payment_instances set status = 'paid' where id = $1");
      await wrapped.query("commit");
    });
    expect(metrics.queryCount).toBe(3);
    expect(client.calls).toEqual([
      "begin",
      "update public.payment_instances set status = 'paid' where id = $1",
      "commit",
    ]);
  });

  it("query dışındaki üyeler geçer ve release çalışır", async () => {
    const client = fakeClient();
    await measureRequestQueries(async () => {
      const wrapped = countingClient(client);
      wrapped.release();
    });
    expect(client.released).toBe(1);
  });

  it("düşen sorgu da sayılır ve hata çağırana ULAŞIR", async () => {
    const failing = {
      query: async () => {
        throw new Error("sorgu düştü");
      },
    };
    const { metrics } = await measureRequestQueries(async () => {
      const wrapped = countingClient(failing);
      await expect(wrapped.query()).rejects.toThrow("sorgu düştü");
    });
    // Hata veren sorgu bir round trip'tir; SQL metni olmadığı için süre kaydı yapılmaz ama
    // çağrı çağırana olduğu gibi yansır — sarmalayıcı hatayı yutmaz.
    expect(metrics.queryCount).toBe(0);
  });
});
