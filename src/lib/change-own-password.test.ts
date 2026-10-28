// Wave 0 / S6 — the self-service password change (the way out of a forced change, 0095).
//
// The unreviewed layer ran this change through the TIER pool. Only the admin tier may update
// public.users there, so for viewer, operator, approver and manager the row lock found nothing
// and those users could never leave /change-password; it also read the audit "before" AFTER the
// update, recording the new state as the old one. These tests drive the real changeOwnPassword
// (and the real attemptLogin it reuses) against a fake identity pool that answers by SQL text, and
// pin what each tier's change must do, in order, on one connection:
//
//   lock own row → this session still live → before → update → revoke OTHER sessions →
//   app.user_id → SET LOCAL ROLE <own tier> → audit (one writer) → commit
//
// What the database then does with that SQL (the 0096 policy, users_app_runtime) is proved by
// db:roles-rls:verify against a real PostgreSQL; this file proves the application sends it.
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { APP_ROLES, DB_ROLE, type AppRole } from "@/lib/authz/matrix";

type Row = Record<string, unknown>;
interface Logged { client: number; sql: string; values: unknown[] }

const h = vi.hoisted(() => {
  const state = {
    token: "oturum-belirteci" as string | null,
    user: {
      id: "11111111-1111-4111-8111-111111111111",
      username: "muhasebe.ayse",
      display_name: "Ayşe",
      role: "viewer" as string,
      is_active: true,
      must_change_password: true,
      password_hash: "argon2:EskiParola-2026!",
      failed_login_count: 0,
      locked_until: null as string | null,
    },
    /** What the transaction's own row lock sees (an admin may have deactivated the account). */
    activeInTransaction: true,
    sessionLive: true,
    otherSessions: 2,
    auditError: null as Error | null,
    log: [] as Logged[],
    released: [] as Array<{ client: number; err: unknown }>,
    nextClient: 0,
  };

  const norm = (sql: string): string => sql.replace(/\s+/g, " ").trim().toLowerCase();

  function answer(sql: string, values: unknown[]): { rowCount: number; rows: Row[] } {
    const t = norm(sql);
    const u = state.user;
    const none = { rowCount: 0, rows: [] as Row[] };
    if (t === "begin" || t === "commit" || t === "rollback") return none;
    // attemptLogin()
    if (t.includes("from public.users where username = $1 for update")) {
      if (values[0] !== u.username) return none;
      return {
        rowCount: 1,
        rows: [{
          id: u.id, password_hash: u.password_hash, is_active: u.is_active, locked_until: u.locked_until,
          failed_login_count: u.failed_login_count, must_change_password: u.must_change_password,
        }],
      };
    }
    if (t.startsWith("update public.users set failed_login_count = $2, locked_until = $3")) {
      u.failed_login_count = Number(values[1]);
      u.locked_until = (values[2] as string | null) ?? null;
      return { rowCount: 1, rows: [] };
    }
    if (t.startsWith("update public.users set failed_login_count = 0, locked_until = null")) {
      u.failed_login_count = 0;
      u.locked_until = null;
      return { rowCount: 1, rows: [] };
    }
    if (t.startsWith("select coalesce(locked_until > now(), false) as locked, is_active from public.users where id = $1")) {
      if (values[0] !== u.id) return none;
      return {
        rowCount: 1,
        rows: [{ locked: u.locked_until !== null && Date.parse(u.locked_until) > Date.now(), is_active: u.is_active }],
      };
    }
    // changeOwnPassword()'s transaction
    if (t.startsWith("select username, display_name, role, is_active, must_change_password from public.users where id = $1 for update")) {
      if (values[0] !== u.id) return none;
      return {
        rowCount: 1,
        rows: [{
          username: u.username, display_name: u.display_name, role: u.role,
          is_active: state.activeInTransaction, must_change_password: u.must_change_password,
        }],
      };
    }
    if (t.startsWith("select 1 from public.sessions where token_hash = $1 and user_id = $2")) {
      return state.sessionLive ? { rowCount: 1, rows: [{ "?column?": 1 }] } : none;
    }
    if (t.startsWith("update public.users set password_hash = $2, must_change_password = false")) {
      // Mutated on purpose: a "before" read AFTER this statement (the layer's order) would now
      // see must_change_password = false and the assertion on before_data would catch it.
      u.password_hash = String(values[1]);
      u.must_change_password = false;
      return { rowCount: 1, rows: [] };
    }
    if (t.startsWith("update public.sessions set revoked_at = now() where user_id = $1 and token_hash <> $2")) {
      return { rowCount: state.otherSessions, rows: [] };
    }
    if (t.startsWith("select set_config('app.user_id', $1, true)")) return { rowCount: 1, rows: [{ set_config: values[0] }] };
    if (t.startsWith("set local role ")) return none;
    if (t.startsWith("insert") && t.includes("public.audit_logs")) {
      if (state.auditError) throw state.auditError;
      return { rowCount: 1, rows: [{ id: "22222222-2222-4222-8222-222222222222" }] };
    }
    throw new Error(`beklenmeyen SQL: ${t}`);
  }

  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      state.log.push({ client: 0, sql: norm(sql), values });
      return answer(sql, values);
    },
    connect: async () => {
      const id = ++state.nextClient;
      return {
        query: async (sql: string, values: unknown[] = []) => {
          state.log.push({ client: id, sql: norm(sql), values });
          return answer(sql, values);
        },
        release: (err?: unknown) => {
          state.released.push({ client: id, err });
        },
      };
    },
  };
  return { state, pool };
});

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "mas_session" && h.state.token ? { value: h.state.token } : undefined),
    set: () => {},
    delete: () => {},
  }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT ${url}`);
  },
}));
vi.mock("@/lib/db", () => ({ getRawPool: () => h.pool }));
vi.mock("@/lib/env", () => ({ env: { qaBypassAuth: false } }));
// Deterministic stand-in for argon2: a "hash" verifies only against the password it was made from.
vi.mock("@node-rs/argon2", () => ({
  hash: async (password: string) => `argon2:${password}`,
  verify: async (hash: string, password: string) => hash === `argon2:${password}`,
}));

import { changeOwnPassword, type SessionUser } from "./auth";
import { PasswordChangeError, type PasswordChangeErrorCode } from "@/lib/users/password-policy";

const OLD = "EskiParola-2026!";
const NEW = "YepyeniParola-2026!";
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function sessionUser(role: AppRole = "viewer"): SessionUser {
  const u = h.state.user;
  return { id: u.id, username: u.username, displayName: u.display_name, role, mustChangePassword: u.must_change_password };
}

async function expectCode(p: Promise<unknown>, code: PasswordChangeErrorCode): Promise<void> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(PasswordChangeError);
  expect((err as PasswordChangeError).code).toBe(code);
}

/** The connection the change's own transaction ran on (attemptLogin used another one). */
function txClient(): number {
  const lock = h.state.log.find((l) => l.sql.startsWith("select username, display_name, role"));
  return lock?.client ?? -1;
}
const txLog = () => h.state.log.filter((l) => l.client === txClient());
const ranAnywhere = (prefix: string) => h.state.log.some((l) => l.sql.startsWith(prefix));
const auditInserts = () => h.state.log.filter((l) => l.sql.startsWith("insert") && l.sql.includes("public.audit_logs"));

beforeEach(() => {
  h.state.token = "oturum-belirteci";
  h.state.user = {
    id: "11111111-1111-4111-8111-111111111111",
    username: "muhasebe.ayse",
    display_name: "Ayşe",
    role: "viewer",
    is_active: true,
    must_change_password: true,
    password_hash: `argon2:${OLD}`,
    failed_login_count: 0,
    locked_until: null,
  };
  h.state.activeInTransaction = true;
  h.state.sessionLive = true;
  h.state.otherSessions = 2;
  h.state.auditError = null;
  h.state.log = [];
  h.state.released = [];
  h.state.nextClient = 0;
});

describe("her katman KENDİ parolasını değiştirebilir (katmanın kilitlediği dört katman dahil)", () => {
  for (const tier of APP_ROLES) {
    it(`${tier}: tek işlemde güncelle → diğer oturumları kapat → kendi katmanında denetim`, async () => {
      h.state.user.role = tier;

      const result = await changeOwnPassword(sessionUser(tier), OLD, NEW);
      expect(result).toEqual({ otherSessionsRevoked: 2 });

      const steps = txLog().map((l) => l.sql);
      const at = (prefix: string) => steps.findIndex((s) => s.startsWith(prefix));
      const order = [
        at("begin"),
        at("select username, display_name, role, is_active, must_change_password from public.users where id = $1 for update"),
        at("select 1 from public.sessions where token_hash = $1"),
        at("update public.users set password_hash = $2"),
        at("update public.sessions set revoked_at = now() where user_id = $1 and token_hash <> $2"),
        at("select set_config('app.user_id', $1, true)"),
        at(`set local role ${DB_ROLE[tier]}`),
        steps.findIndex((s) => s.startsWith("insert") && s.includes("public.audit_logs")),
        at("commit"),
      ];
      expect(order.every((i) => i >= 0), JSON.stringify(steps, null, 1)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      expect(steps.at(-1)).toBe("commit");
      // The users/sessions writes run BEFORE the switch, as the identity role (users_app_runtime);
      // only the audit row is written in the tier.
      expect(steps.filter((s) => s.startsWith("set local role"))).toEqual([`set local role ${DB_ROLE[tier]}`]);

      const tx = txLog();
      const u = h.state.user;
      expect(tx.find((l) => l.sql.startsWith("select set_config"))?.values).toEqual([u.id]);
      expect(tx.find((l) => l.sql.startsWith("update public.users set password_hash"))?.values).toEqual([u.id, `argon2:${NEW}`]);
      // Every OTHER session: the current one (this cookie) is the one excluded.
      expect(tx.find((l) => l.sql.startsWith("update public.sessions"))?.values).toEqual([u.id, sha256("oturum-belirteci")]);
      expect(tx.find((l) => l.sql.startsWith("select 1 from public.sessions"))?.values).toEqual([sha256("oturum-belirteci"), u.id]);

      // One audit row, through the canonical writer's column order.
      const [audit] = auditInserts();
      const [actor, action, entityTable, entityId, beforeJson, afterJson] = audit.values as string[];
      expect({ actor, action, entityTable, entityId }).toEqual({
        actor: u.id, action: "change_own_password", entityTable: "users", entityId: u.id,
      });
      const before = JSON.parse(beforeJson);
      const after = JSON.parse(afterJson);
      // "before" was read under the lock BEFORE the update — the layer recorded the new state here.
      expect(before).toEqual({
        username: "muhasebe.ayse", display_name: "Ayşe", role: tier, is_active: true, must_change_password: true,
      });
      expect(after).toEqual({ ...before, password_changed: true, must_change_password: false, other_sessions_revoked: 2 });
      for (const secret of [OLD, NEW, "argon2:"]) {
        expect(beforeJson + afterJson).not.toContain(secret);
      }

      // The connection goes back to the pool (no error): SET LOCAL ended with the COMMIT.
      expect(h.state.released.find((r) => r.client === txClient())).toEqual({ client: txClient(), err: undefined });
    });
  }
});

describe("kurallar veritabanına dokunmadan uygulanır", () => {
  it("12 karakterden kısa yeni parola", async () => {
    await expectCode(changeOwnPassword(sessionUser(), OLD, "Kisa-1!"), "too_short");
    expect(h.state.log).toEqual([]);
  });

  it("kullanıcı adıyla aynı (büyük/küçük harf farkı sayılmaz) — 12+ karakterlik ad ile gerçekten bu kurala ulaşır", async () => {
    // The layer's test used a 9-character pair, failed on the length rule and never reached this one.
    await expectCode(changeOwnPassword(sessionUser(), OLD, "MUHASEBE.AYSE"), "same_as_username");
    expect(h.state.log).toEqual([]);
  });

  it("mevcut parolayla aynı", async () => {
    await expectCode(changeOwnPassword(sessionUser(), OLD, OLD), "same_as_old");
    expect(h.state.log).toEqual([]);
  });

  it("oturum çerezi yoksa hiçbir şey denenmez", async () => {
    h.state.token = null;
    await expectCode(changeOwnPassword(sessionUser(), OLD, NEW), "session_ended");
    expect(h.state.log).toEqual([]);
  });
});

describe("mevcut parola GİRİŞ kuralıyla doğrulanır (attemptLogin)", () => {
  it("yanlış parola: hata sayacı artar, parola ve denetim değişmez", async () => {
    await expectCode(changeOwnPassword(sessionUser(), "YanlisParola-2026!", NEW), "invalid_old");
    expect(h.state.user.failed_login_count).toBe(1);
    expect(h.state.user.password_hash).toBe(`argon2:${OLD}`);
    expect(ranAnywhere("update public.users set password_hash")).toBe(false);
    expect(ranAnywhere("set local role")).toBe(false);
    expect(auditInserts()).toEqual([]);
  });

  it("beşinci yanlış deneme hesabı kilitler ve kullanıcıya bunu söyler", async () => {
    h.state.user.failed_login_count = 4;
    await expectCode(changeOwnPassword(sessionUser(), "YanlisParola-2026!", NEW), "locked");
    expect(h.state.user.locked_until).not.toBeNull();
    expect(ranAnywhere("update public.users set password_hash")).toBe(false);
  });

  it("kilitli hesapta DOĞRU parola da kabul edilmez (kilit süresince)", async () => {
    h.state.user.locked_until = new Date(Date.now() + 10 * 60_000).toISOString();
    await expectCode(changeOwnPassword(sessionUser(), OLD, NEW), "locked");
    expect(ranAnywhere("update public.users set password_hash")).toBe(false);
    expect(auditInserts()).toEqual([]);
  });

  it("hesap form açıkken pasifleştirildiyse 'oturum bitti' denir, 'parola hatalı' değil — sayaç da artmaz", async () => {
    // attemptLogin refuses an inactive account without counting a failure; telling this user
    // "wrong password" would be false and would only invite more attempts.
    h.state.user.is_active = false;
    await expectCode(changeOwnPassword(sessionUser(), OLD, NEW), "session_ended");
    expect(h.state.user.failed_login_count).toBe(0);
    expect(ranAnywhere("update public.users set password_hash")).toBe(false);
    expect(auditInserts()).toEqual([]);
  });

  it("kullanıcı adı başka bir hesaba çıkıyorsa oturum geçersiz sayılır", async () => {
    const someoneElse = { ...sessionUser(), id: "33333333-3333-4333-8333-333333333333" };
    await expectCode(changeOwnPassword(someoneElse, OLD, NEW), "session_ended");
    expect(ranAnywhere("update public.users set password_hash")).toBe(false);
  });
});

describe("işlem içinde: bu oturum hâlâ canlı ve hesap hâlâ aktif olmalı", () => {
  it("oturum arada iptal edildiyse (ör. yönetici sıfırladı) parola yazılmaz", async () => {
    h.state.sessionLive = false;
    await expectCode(changeOwnPassword(sessionUser(), OLD, NEW), "session_ended");
    const steps = txLog().map((l) => l.sql);
    expect(steps).toContain("rollback");
    expect(steps).not.toContain("commit");
    expect(ranAnywhere("update public.users set password_hash")).toBe(false);
    expect(auditInserts()).toEqual([]);
  });

  it("hesap arada pasifleştirildiyse parola yazılmaz", async () => {
    h.state.activeInTransaction = false;
    await expectCode(changeOwnPassword(sessionUser(), OLD, NEW), "session_ended");
    expect(ranAnywhere("update public.users set password_hash")).toBe(false);
  });

  it("tanınmayan rol SET ROLE'a hiç ulaşmaz", async () => {
    h.state.user.role = "superuser";
    await expect(changeOwnPassword(sessionUser(), OLD, NEW)).rejects.toThrow(/Tanınmayan kullanıcı katmanı/);
    expect(ranAnywhere("set local role")).toBe(false);
    expect(ranAnywhere("update public.users set password_hash")).toBe(false);
  });
});

describe("hata yolunda bağlantı havuza geri dönmez", () => {
  it("denetim satırı reddedilirse (RLS) her şey geri alınır ve bağlantı imha edilir", async () => {
    h.state.auditError = Object.assign(new Error("new row violates row-level security policy"), { code: "42501" });

    const err = await changeOwnPassword(sessionUser(), OLD, NEW).then(() => null, (e: unknown) => e);
    // A system fault, not a user mistake: it must propagate, not become a friendly redirect.
    expect(err).toBe(h.state.auditError);
    expect(err).not.toBeInstanceOf(PasswordChangeError);

    const steps = txLog().map((l) => l.sql);
    expect(steps).toContain("rollback");
    expect(steps).not.toContain("commit");
    const released = h.state.released.find((r) => r.client === txClient());
    expect(released?.err).toBeTruthy();
  });

  it("kullanıcı hatasında da işlem bağlantısı imha edilir (rol taşıyabilecek bağlantı havuza dönmez)", async () => {
    h.state.sessionLive = false;
    await expectCode(changeOwnPassword(sessionUser(), OLD, NEW), "session_ended");
    expect(h.state.released.find((r) => r.client === txClient())?.err).toBeTruthy();
  });
});
