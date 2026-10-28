// Wave 0 — a failed role switch must STOP the request, not be logged and walked past.
//
// The unreviewed layer (46541d8) wrapped `set role` and `reset role` in try/catch "for pooler
// sessions" and then tagged the connection as switched anyway. A failed switch therefore left the
// connection in whatever role it last held — a previous request's tier, or the bare runtime
// role — while every later checkout trusted the tag, which silently disables the tier/RLS model
// every server action relies on. These tests pin the restored af210fd behaviour with a fake `pg`
// client and no database at all: the switch failure rejects, the caller's own SQL never reaches
// the connection, and the connection is destroyed instead of being handed back to the pool.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  interface Call { text: string; values?: unknown[] }

  /** Records every statement and every release() argument; fails statements matching failOn. */
  class FakeClient {
    calls: Call[] = [];
    released: Array<Error | boolean | undefined> = [];
    failOn: RegExp | null = null;

    async query(text: string | { text: string }, values?: unknown[]) {
      const sql = typeof text === "string" ? text : text.text;
      this.calls.push({ text: sql, values });
      if (this.failOn?.test(sql)) throw new Error(`simüle edilmiş hata: ${sql}`);
      return { rows: [], rowCount: 0 };
    }

    release(err?: Error | boolean) {
      this.released.push(err);
    }
  }

  const state = {
    /** When set, every checkout returns this one physical connection (pool reuse). */
    shared: null as FakeClient | null,
    created: [] as FakeClient[],
    context: { dbRole: null as string | null, userId: null as string | null },
  };

  return { FakeClient, state };
});

vi.mock("pg", () => ({
  Pool: class {
    async connect() {
      const client = h.state.shared ?? new h.FakeClient();
      h.state.created.push(client);
      return client;
    }
    async end() {}
  },
}));
vi.mock("@/lib/env", () => ({
  env: { databaseUrl: "postgres://sahte@127.0.0.1:5432/sahte", databasePoolMax: 2 },
}));
vi.mock("@/lib/authz/context", () => ({
  getDbContext: async () => h.state.context,
}));
vi.mock("@/lib/perf/request-metrics", () => ({
  countingClient: (client: unknown) => client,
  recordRequestQuery: () => {},
}));
vi.mock("@/lib/perf/slow-query", () => ({ recordQuery: () => {} }));

import { getPool, runAsReadOnlySystem, runAsSystem, runAsUser } from "./db";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

const texts = (client: InstanceType<typeof h.FakeClient>) => client.calls.map((c) => c.text);
const lastClient = () => h.state.created[h.state.created.length - 1];

beforeEach(() => {
  // getPool() memoises on the global object; every test starts from a fresh pool.
  global.__masPool = undefined;
  global.__masRawPool = undefined;
  h.state.shared = null;
  h.state.created = [];
  h.state.context = { dbRole: "mas_radar_viewer", userId: USER };
});

describe("db.ts — rol geçişi başarısızsa istek DURUR (af210fd davranışı)", () => {
  it("set role reddedilirse sorgu reddedilir ve çağıranın SQL'i bağlantıya hiç ulaşmaz", async () => {
    const client = new h.FakeClient();
    client.failOn = /^set role/;
    h.state.shared = client;

    await expect(getPool().query("select 1")).rejects.toThrow(/set role/);
    expect(texts(client)).not.toContain("select 1");
  });

  it("katman yokken reset role reddedilirse sorgu reddedilir (eski katmanda kalmaz)", async () => {
    // First checkout leaves the physical connection sitting in the viewer tier, exactly as a
    // real pooled connection would after serving a signed-in request.
    const client = new h.FakeClient();
    h.state.shared = client;
    await getPool().query("select 1");

    // Next checkout has no tier (a script, a request without a session). The reset fails.
    h.state.context = { dbRole: null, userId: null };
    client.failOn = /^reset role/;
    await expect(getPool().query("select 2")).rejects.toThrow(/reset role/);
    expect(texts(client)).not.toContain("select 2");
  });

  it("hazırlık hatasından sonra bağlantı havuza geri VERİLMEZ, hatayla imha edilir", async () => {
    const client = new h.FakeClient();
    client.failOn = /^set role/;
    h.state.shared = client;

    await expect(getPool().query("select 1")).rejects.toThrow();
    expect(client.released).toHaveLength(1);
    // pg-pool: a truthy argument to release() destroys the client instead of pooling it.
    expect(client.released[0]).toBeTruthy();
  });

  it("connect() yolu da aynı: set role reddedilirse reddedilir ve bağlantı imha edilir", async () => {
    const client = new h.FakeClient();
    client.failOn = /^set role/;
    h.state.shared = client;

    await expect(getPool().connect()).rejects.toThrow(/set role/);
    expect(client.released).toHaveLength(1);
    expect(client.released[0]).toBeTruthy();
  });

  it("app.user_id yazılamazsa da istek durur (rol değiştirilmeden)", async () => {
    const client = new h.FakeClient();
    client.failOn = /set_config\('app\.user_id', \$1/;
    h.state.shared = client;

    await expect(getPool().query("select 1")).rejects.toThrow(/set_config/);
    expect(texts(client).some((t) => t.startsWith("set role"))).toBe(false);
    expect(texts(client)).not.toContain("select 1");
  });

  it("geçersiz rol adı SQL'e hiç ulaşmaz", async () => {
    h.state.context = { dbRole: "mas_radar_viewer; drop table x", userId: USER };
    await expect(getPool().query("select 1")).rejects.toThrow(/Geçersiz veritabanı rolü/);
    expect(texts(lastClient()).some((t) => t.startsWith("set role"))).toBe(false);
  });
});

describe("db.ts — mutlu yol", () => {
  it("app.user_id, set role'dan ÖNCE yazılır; bağlantı normal biçimde havuza döner", async () => {
    await getPool().query("select 1");
    const client = lastClient();

    expect(texts(client)).toEqual([
      "select set_config('app.user_id', $1, false)",
      "set role mas_radar_viewer",
      "select 1",
    ]);
    expect(client.calls[0].values).toEqual([USER]);
    expect(client.released).toEqual([undefined]);
  });

  it("kimlik her checkout'ta yeniden yazılır (aynı kullanıcı için bile); rol geçişi yalnız gerektiğinde", async () => {
    const client = new h.FakeClient();
    h.state.shared = client;

    // Same user twice: the layer's per-connection user-id tag skipped the second write. The
    // identity is never trusted from a tag — it is written on every checkout.
    await getPool().query("select 1");
    await getPool().query("select 2");
    h.state.context = { dbRole: "mas_radar_viewer", userId: OTHER };
    await getPool().query("select 3");

    const identityWrites = client.calls.filter((c) => c.text.startsWith("select set_config('app.user_id', $1"));
    expect(identityWrites.map((c) => c.values)).toEqual([[USER], [USER], [OTHER]]);
    // The ROLE is still cached per connection: one switch for three checkouts in the same tier.
    expect(texts(client).filter((t) => t.startsWith("set role"))).toEqual(["set role mas_radar_viewer"]);
  });

  it("runAsReadOnlySystem viewer katmanına, runAsSystem finance_manager katmanına geçer", async () => {
    h.state.context = { dbRole: null, userId: null };

    await runAsReadOnlySystem(() => getPool().query("select 1"));
    expect(texts(lastClient())).toContain("set role mas_radar_viewer");

    await runAsSystem(() => getPool().query("select 1"));
    expect(texts(lastClient())).toContain("set role mas_radar_finance_manager");
  });
});

describe("db.ts — runAsUser (Wave 0: asenkron önizleme işçisi, kişinin KENDİ katmanı)", () => {
  it("kullanıcının katmanına geçer ve app.user_id onu adlandırır — iş kimliği (finance_manager) değil", async () => {
    h.state.context = { dbRole: null, userId: null };

    await runAsUser({ id: OTHER, role: "finance_operator" }, () => getPool().query("select 1"));
    const client = lastClient();

    expect(texts(client)).toEqual([
      "select set_config('app.user_id', $1, false)",
      "set role mas_radar_finance_operator",
      "select 1",
    ]);
    expect(client.calls[0].values).toEqual([OTHER]);
  });

  it("bağlam yalnız fonksiyonun içinde geçerlidir; dışarıdaki istek kendi katmanına döner", async () => {
    await runAsUser({ id: OTHER, role: "admin" }, () => getPool().query("select 1"));
    await getPool().query("select 2");
    expect(texts(lastClient())).toContain("set role mas_radar_viewer");
  });

  it("beş katmandan biri olmayan rol ve uuid olmayan kimlik SQL'e hiç ulaşmaz", () => {
    const bad = { id: OTHER, role: "superuser" } as unknown as Parameters<typeof runAsUser>[0];
    expect(() => runAsUser(bad, async () => 1)).toThrow(/Bilinmeyen kullanıcı katmanı/);
    expect(() => runAsUser({ id: "admin-1", role: "admin" }, async () => 1)).toThrow(/Geçersiz kullanıcı kimliği/);
    expect(h.state.created).toHaveLength(0);
  });
});
