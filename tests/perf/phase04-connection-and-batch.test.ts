import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  interface Call {
    text: string;
    values?: unknown[];
  }

  class FakeClient {
    calls: Call[] = [];
    released: Array<Error | boolean | undefined> = [];
    activeQueries = 0;
    releasedWhileActive = false;
    failOn: RegExp | null = null;
    delayOn: { pattern: RegExp; ms: number } | null = null;

    async query(text: string | { text: string }, values?: unknown[]) {
      const sql = typeof text === "string" ? text : text.text;
      this.activeQueries += 1;
      try {
        this.calls.push({ text: sql, values });
        if (this.delayOn?.pattern.test(sql)) {
          await new Promise((resolve) => setTimeout(resolve, this.delayOn!.ms));
        }
        if (this.failOn?.test(sql)) {
          throw new Error(`simüle edilmiş sorgu hatası: ${sql}`);
        }
        return { rows: [], rowCount: 0 };
      } finally {
        this.activeQueries -= 1;
      }
    }

    release(err?: Error | boolean) {
      if (this.activeQueries > 0) {
        this.releasedWhileActive = true;
      }
      this.released.push(err);
    }
  }

  const state = {
    poolOptions: [] as Array<Record<string, unknown>>,
    connectCount: 0,
    clients: [] as FakeClient[],
    nextClient: null as FakeClient | null,
    context: {
      dbRole: "mas_radar_finance_manager" as string | null,
      userId: "11111111-1111-4111-8111-111111111111" as string | null,
    },
  };

  return { FakeClient, state };
});

vi.mock("pg", () => ({
  Pool: class {
    constructor(options: Record<string, unknown>) {
      h.state.poolOptions.push(options);
    }
    async connect() {
      h.state.connectCount += 1;
      const client = h.state.nextClient ?? new h.FakeClient();
      h.state.clients.push(client);
      return client;
    }
    async end() {}
  },
}));

vi.mock("@/lib/env", () => ({
  env: {
    databaseUrl: "postgres://sahte@127.0.0.1:5432/sahte",
    databasePoolMax: 10,
    databaseStatementTimeoutMs: 5_000,
  },
}));

vi.mock("@/lib/authz/context", () => ({
  getDbContext: async () => h.state.context,
}));

vi.mock("@/lib/perf/request-metrics", () => ({
  countingClient: (client: unknown) => client,
  recordRequestQuery: () => {},
}));

vi.mock("@/lib/perf/slow-query", () => ({
  recordQuery: () => {},
}));

import { getPool, withReadConnection } from "@/lib/db";
import { loadCandidatesBatch } from "@/lib/bank/engine";

beforeEach(() => {
  global.__masPool = undefined;
  global.__masRawPool = undefined;
  h.state.poolOptions = [];
  h.state.connectCount = 0;
  h.state.clients = [];
  h.state.nextClient = null;
  h.state.context = {
    dbRole: "mas_radar_finance_manager",
    userId: "11111111-1111-4111-8111-111111111111",
  };
});

describe("Faz 4 — Tek bağlantı yeniden kullanımı (withReadConnection), statement_timeout ve toplu aday okuma", () => {
  it("havuz kurulumunda statement_timeout=5000 ms yapılandırılır", async () => {
    await getPool().query("select 1");
    expect(h.state.poolOptions).toHaveLength(1);
    expect(h.state.poolOptions[0]?.statement_timeout).toBe(5_000);
  });

  it("withReadConnection 5 paralel sorguyu tek fiziksel checkout ve tek prepare() ile çalıştırır", async () => {
    const client = new h.FakeClient();
    h.state.nextClient = client;

    await withReadConnection(getPool(), async (db) => {
      await Promise.all([
        db.query("select 1"),
        db.query("select 2"),
        db.query("select 3"),
        db.query("select 4"),
        db.query("select 5"),
      ]);
    });

    expect(h.state.connectCount).toBe(1);
    const sqls = client.calls.map((c) => c.text);
    expect(sqls.filter((s) => s.startsWith("select set_config('app.user_id'"))).toHaveLength(1);
    expect(sqls.filter((s) => s.startsWith("set role"))).toHaveLength(1);
    expect(sqls.slice(2)).toEqual(["select 1", "select 2", "select 3", "select 4", "select 5"]);
    expect(client.released).toEqual([undefined]);
  });

  it("Promise.all içinde bir sorgu hata verdiğinde kardeş sorgu bitmeden bağlantı havuza bırakılmaz", async () => {
    const client = new h.FakeClient();
    client.failOn = /^select fail$/;
    client.delayOn = { pattern: /^select slow$/, ms: 30 };
    h.state.nextClient = client;

    await expect(
      withReadConnection(getPool(), async (db) => {
        await Promise.all([db.query("select fail"), db.query("select slow")]);
      }),
    ).rejects.toThrow(/select fail/);

    expect(client.released).toHaveLength(1);
    expect(client.releasedWhileActive).toBe(false);
    expect(client.activeQueries).toBe(0);
  });

  it("withReadConnection içinden iç içe db.connect() çağrılmasına izin vermez", async () => {
    await expect(
      withReadConnection(getPool(), async (db) => {
        await db.connect();
      }),
    ).rejects.toThrow(/withReadConnection/);
  });

  it("loadCandidatesBatch boş listede 0 sorgu, çoklu harekette tek ANY($1::uuid[]) sorgusu çalıştırır", async () => {
    const executed: Array<{ sql: string; params: unknown[] | undefined }> = [];
    const fakeDb = {
      async query(sql: string, params?: unknown[]) {
        executed.push({ sql, params });
        return {
          rows: [
            {
              txn_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              id: "cand-1",
              target_table: "invoices",
              target_id: "inv-1",
              confidence: "0.94",
              reasons: ["tutar eşleşti", "IBAN eşleşti"],
              rejected: false,
            },
            {
              txn_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              id: "cand-2",
              target_table: "payment_instances",
              target_id: "pay-1",
              confidence: "0.61",
              reasons: ["ad benzerliği"],
              rejected: true,
            },
          ],
          rowCount: 2,
        };
      },
    };

    const emptyMap = await loadCandidatesBatch(fakeDb as never, []);
    expect(emptyMap.size).toBe(0);
    expect(executed).toHaveLength(0);

    const txnA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const txnB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const map = await loadCandidatesBatch(fakeDb as never, [txnA, txnB, txnA]);

    expect(executed).toHaveLength(1);
    expect(executed[0]?.sql).toMatch(/any\(\$1::uuid\[\]\)/i);
    expect(executed[0]?.params).toEqual([[txnA, txnB]]);
    expect(map.get(txnA)).toEqual([
      {
        id: "cand-1",
        targetTable: "invoices",
        targetId: "inv-1",
        confidence: 0.94,
        reasons: ["tutar eşleşti", "IBAN eşleşti"],
        rejected: false,
      },
      {
        id: "cand-2",
        targetTable: "payment_instances",
        targetId: "pay-1",
        confidence: 0.61,
        reasons: ["ad benzerliği"],
        rejected: true,
      },
    ]);
    expect(map.get(txnB)).toEqual([]);
  });

  it("Banka Merkezi sayfası N+1 loadCandidates döngüsü yerine withReadConnection + loadCandidatesBatch kullanır", () => {
    const bankPage = readFileSync(
      join(process.cwd(), "src/app/(dashboard)/finance/bank/page.tsx"),
      "utf8",
    );
    expect(bankPage).toContain("withReadConnection(");
    expect(bankPage).toContain("loadCandidatesBatch(");
    expect(bankPage).not.toMatch(/loadCandidates\s*\(/);
  });
});

