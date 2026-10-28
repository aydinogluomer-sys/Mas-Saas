// Forced password change (0095), admin side: create, reset and "force" all leave the account
// with must_change_password = true and an audit row that never carries a password or a hash.
//
// The user's OWN change moved to @/lib/auth in Wave 0 (it must run on the identity connection,
// not the caller's tier) and is tested in src/lib/change-own-password.test.ts.
//
// Wave 0 rewrite of the layer's file: no process.env mutation (it set a database URL with an
// inline owner credential for every test in the worker), typed fakes instead of `any`, and a fake
// client that answers by SQL text instead of a positional mockResolvedValueOnce chain — the chain
// passed as long as the NUMBER of queries matched, whatever they were.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";

vi.mock("@/lib/auth", () => ({ hashPassword: async (password: string) => `argon2:${password}` }));

import { createUser, forcePasswordChange, resetUserPassword } from "./engine";

interface Logged { sql: string; values: unknown[] }
interface FakeUser {
  id: string; username: string; display_name: string; role: string; is_active: boolean; must_change_password: boolean;
}

const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TARGET = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

let users: FakeUser[];
let log: Logged[];
let openSessions: number;

const norm = (sql: string): string => sql.replace(/\s+/g, " ").trim().toLowerCase();

const client = {
  query: async (sql: string, values: unknown[] = []) => {
    const t = norm(sql);
    log.push({ sql: t, values });
    const byId = users.find((u) => u.id === values[0]);
    if (t === "begin" || t === "commit" || t === "rollback") return { rowCount: 0, rows: [] };
    if (t.startsWith("select username from public.users where id=$1")) {
      return byId ? { rowCount: 1, rows: [{ username: byId.username }] } : { rowCount: 0, rows: [] };
    }
    if (t.startsWith("select username, display_name, role, is_active, must_change_password from public.users where id=$1 for update")) {
      if (!byId) return { rowCount: 0, rows: [] };
      const { username, display_name, role, is_active, must_change_password } = byId;
      return { rowCount: 1, rows: [{ username, display_name, role, is_active, must_change_password }] };
    }
    if (t.startsWith("select 1 from public.users where username=$1")) {
      return users.some((u) => u.username === values[0]) ? { rowCount: 1, rows: [{}] } : { rowCount: 0, rows: [] };
    }
    if (t.startsWith("insert into public.users")) return { rowCount: 1, rows: [{ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }] };
    if (t.startsWith("update public.users set must_change_password=true where id=$1")) return { rowCount: 1, rows: [] };
    if (t.startsWith("update public.users set password_hash=$2, must_change_password=$3")) return { rowCount: 1, rows: [] };
    if (t.startsWith("update public.sessions set revoked_at=now() where user_id=$1")) return { rowCount: openSessions, rows: [] };
    if (t.startsWith("insert") && t.includes("public.audit_logs")) return { rowCount: 1, rows: [{ id: "audit-1" }] };
    throw new Error(`beklenmeyen SQL: ${t}`);
  },
  release: () => {},
};
const pool = { connect: async () => client } as unknown as Pool;

function auditRow(): { actor: string; action: string; before: Record<string, unknown> | null; after: Record<string, unknown> } {
  const rows = log.filter((l) => l.sql.startsWith("insert") && l.sql.includes("public.audit_logs"));
  expect(rows).toHaveLength(1);
  const [actor, action, , , before, after] = rows[0].values as string[];
  return { actor, action, before: JSON.parse(before), after: JSON.parse(after) };
}
const wrote = (prefix: string) => log.some((l) => l.sql.startsWith(prefix));

beforeEach(() => {
  users = [
    { id: TARGET, username: "operator.mehmet", display_name: "Mehmet", role: "finance_operator", is_active: true, must_change_password: false },
    { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", username: "system", display_name: "Sistem", role: "finance_manager", is_active: false, must_change_password: false },
  ];
  log = [];
  openSessions = 2;
});

describe("forcePasswordChange", () => {
  it("bayrağı true yapar; denetim önceki ve sonraki değeri, gerçek yöneticiyi kaydeder", async () => {
    await forcePasswordChange(pool, TARGET, ADMIN);

    expect(log.find((l) => l.sql.startsWith("update public.users set must_change_password=true"))?.values).toEqual([TARGET]);
    const a = auditRow();
    expect(a.actor).toBe(ADMIN);
    expect(a.action).toBe("force_password_change");
    expect(a.before?.must_change_password).toBe(false);
    expect(a.after.must_change_password).toBe(true);
    // Sessions are deliberately left open: the next request reads the flag live and redirects.
    expect(wrote("update public.sessions")).toBe(false);
  });

  it("rezerve hesaba uygulanamaz", async () => {
    await expect(forcePasswordChange(pool, "dddddddd-dddd-4ddd-8ddd-dddddddddddd", ADMIN)).rejects.toThrow(/ayrılmıştır/);
    expect(wrote("update public.users")).toBe(false);
    expect(log.some((l) => l.sql.includes("public.audit_logs"))).toBe(false);
  });
});

describe("resetUserPassword", () => {
  it("varsayılan olarak değişimi zorunlu kılar, oturumları kapatır, parolayı denetime yazmaz", async () => {
    await resetUserPassword(pool, TARGET, "YoneticininVerdigi-2026!", ADMIN);

    const update = log.find((l) => l.sql.startsWith("update public.users set password_hash=$2, must_change_password=$3"));
    expect(update?.values).toEqual([TARGET, "argon2:YoneticininVerdigi-2026!", true]);
    const a = auditRow();
    expect(a.actor).toBe(ADMIN);
    expect(a.action).toBe("reset_user_password");
    expect(a.before?.must_change_password).toBe(false);
    expect(a.after).toMatchObject({ password_changed: true, must_change_password: true, sessions_revoked: 2 });
    expect(JSON.stringify(a)).not.toContain("YoneticininVerdigi");
    expect(JSON.stringify(a)).not.toContain("argon2:");
  });

  it("kullanıcı adıyla aynı parola reddedilir (12+ karakterlik ad: kural gerçekten çalışır)", async () => {
    await expect(resetUserPassword(pool, TARGET, "OPERATOR.MEHMET", ADMIN)).rejects.toThrow("Parola kullanıcı adıyla aynı olamaz.");
    expect(wrote("update public.users")).toBe(false);
  });

  it("12 karakterden kısa parola veritabanına gitmeden reddedilir", async () => {
    await expect(resetUserPassword(pool, TARGET, "Kisa-1!", ADMIN)).rejects.toThrow("Parola en az 12 karakter olmalı.");
    expect(log).toEqual([]);
  });

  it("rezerve hesabın parolası sıfırlanamaz", async () => {
    await expect(resetUserPassword(pool, "dddddddd-dddd-4ddd-8ddd-dddddddddddd", "YoneticininVerdigi-2026!", ADMIN)).rejects.toThrow(/ayrılmıştır/);
    expect(wrote("update public.users")).toBe(false);
  });
});

describe("createUser", () => {
  it("varsayılan olarak ilk girişte parola değişimi zorunludur", async () => {
    await createUser(pool, { username: "izleyici.zeynep", displayName: "Zeynep", role: "viewer", password: "IlkParola-2026!!" }, ADMIN);

    const insert = log.find((l) => l.sql.startsWith("insert into public.users"));
    expect(insert?.values?.at(-1)).toBe(true);
    const a = auditRow();
    expect(a.actor).toBe(ADMIN);
    expect(a.after.must_change_password).toBe(true);
    expect(JSON.stringify(a)).not.toContain("IlkParola");
  });

  it("açıkça false verilirse zorlamaz", async () => {
    await createUser(
      pool,
      { username: "izleyici.zeynep", displayName: "Zeynep", role: "viewer", password: "IlkParola-2026!!", mustChangePassword: false },
      ADMIN,
    );
    expect(log.find((l) => l.sql.startsWith("insert into public.users"))?.values?.at(-1)).toBe(false);
  });
});
