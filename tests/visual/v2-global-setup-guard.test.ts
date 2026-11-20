import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveOwnerSeedUrl, verifyOwnerSeedPoolIdentity } from "./global-setup";
import { verifierUrl } from "../interaction/harness";

const APP_E2E_URL =
  "postgres://mas_radar_app:ci-only-not-a-secret-0123456789@127.0.0.1:5432/mas_radar_e2e_verify";
const VALID_SEED_URL =
  "postgres://postgres:postgres@127.0.0.1:5432/mas_radar_e2e_verify";

const MISSING_ENV_LOCAL = (): Record<string, string> => {
  throw new Error(".env.local yok");
};

describe("F-05 — E2E global-setup & interaction verifier owner seed URL fail-closed guard", () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.MAS_E2E_DATABASE_URL;
    delete process.env.DATABASE_URL;
    delete process.env.MAS_E2E_SEED_DATABASE_URL;
    delete process.env.MAS_E2E_VERIFIER_URL;
    delete process.env.MIGRATION_DATABASE_URL;
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, savedEnv);
  });

  it("(a) fails closed when MAS_E2E_SEED_DATABASE_URL, MAS_E2E_VERIFIER_URL, MIGRATION_DATABASE_URL, and .env.local are all absent (never fabricates postgres:postgres)", () => {
    const cleanEnv: NodeJS.ProcessEnv = {
      NODE_ENV: "test",
      MAS_E2E_DATABASE_URL: APP_E2E_URL,
    };

    expect(() =>
      resolveOwnerSeedUrl(APP_E2E_URL, {
        env: cleanEnv,
        readEnvLocalFn: MISSING_ENV_LOCAL,
      }),
    ).toThrow(/MAS_E2E_SEED_DATABASE_URL|owner|GÜVENLİK DURDURMASI/i);

    expect(() =>
      verifierUrl({
        env: cleanEnv,
        readEnvLocalFn: MISSING_ENV_LOCAL,
      }),
    ).toThrow(/MAS_E2E_SEED_DATABASE_URL|owner|GÜVENLİK DURDURMASI/i);
  });

  it("(b) rejects non-disposable database names (mas_radar_dev, mas_radar_prod, postgres) on EITHER appDbUrl or seedDbUrl", () => {
    for (const protectedDb of ["mas_radar_dev", "mas_radar_prod", "postgres"]) {
      const badAppUrl = `postgres://mas_radar_app:ci-only-not-a-secret-0123456789@127.0.0.1:5432/${protectedDb}`;
      expect(() =>
        resolveOwnerSeedUrl(badAppUrl, {
          env: {
            NODE_ENV: "test",
            MAS_E2E_SEED_DATABASE_URL: VALID_SEED_URL,
          },
          readEnvLocalFn: MISSING_ENV_LOCAL,
        }),
      ).toThrow(/disposable|harcanabilir|GÜVENLİK DURDURMASI/i);

      const badSeedUrl = `postgres://postgres:postgres@127.0.0.1:5432/${protectedDb}`;
      expect(() =>
        resolveOwnerSeedUrl(APP_E2E_URL, {
          env: {
            NODE_ENV: "test",
            MAS_E2E_SEED_DATABASE_URL: badSeedUrl,
          },
          readEnvLocalFn: MISSING_ENV_LOCAL,
        }),
      ).toThrow(/disposable|harcanabilir|uyuşmuyor|GÜVENLİK DURDURMASI/i);

      expect(() =>
        resolveOwnerSeedUrl(APP_E2E_URL, {
          env: {
            NODE_ENV: "test",
            MAS_E2E_VERIFIER_URL: badSeedUrl,
          },
          readEnvLocalFn: MISSING_ENV_LOCAL,
        }),
      ).toThrow(/disposable|harcanabilir|uyuşmuyor|GÜVENLİK DURDURMASI/i);
    }
  });

  it("(c) rejects database name mismatch between MAS_E2E_DATABASE_URL and MAS_E2E_SEED_DATABASE_URL / MAS_E2E_VERIFIER_URL", () => {
    const mismatchedSeedUrl =
      "postgres://postgres:postgres@127.0.0.1:5432/mas_radar_smoke_verify";

    expect(() =>
      resolveOwnerSeedUrl(APP_E2E_URL, {
        env: {
          NODE_ENV: "test",
          MAS_E2E_SEED_DATABASE_URL: mismatchedSeedUrl,
        },
        readEnvLocalFn: MISSING_ENV_LOCAL,
      }),
    ).toThrow(/mas_radar_e2e_verify.*mas_radar_smoke_verify|uyuşmuyor|mismatch/i);

    expect(() =>
      verifierUrl({
        env: {
          NODE_ENV: "test",
          MAS_E2E_DATABASE_URL: APP_E2E_URL,
          MAS_E2E_VERIFIER_URL: mismatchedSeedUrl,
        },
        readEnvLocalFn: MISSING_ENV_LOCAL,
      }),
    ).toThrow(/mas_radar_e2e_verify.*mas_radar_smoke_verify|uyuşmuyor|mismatch/i);
  });

  it("(d) rejects cluster host/port mismatch (127.0.0.1:5433 or 10.0.0.5:5432) while allowing localhost <-> 127.0.0.1 loopback equivalence", () => {
    const wrongPortSeed =
      "postgres://postgres:postgres@127.0.0.1:5433/mas_radar_e2e_verify";
    const wrongHostSeed =
      "postgres://postgres:postgres@10.0.0.5:5432/mas_radar_e2e_verify";

    expect(() =>
      resolveOwnerSeedUrl(APP_E2E_URL, {
        env: {
          NODE_ENV: "test",
          MAS_E2E_SEED_DATABASE_URL: wrongPortSeed,
        },
        readEnvLocalFn: MISSING_ENV_LOCAL,
      }),
    ).toThrow(/5432.*5433|cluster|host|port|uyuşmuyor/i);

    expect(() =>
      resolveOwnerSeedUrl(APP_E2E_URL, {
        env: {
          NODE_ENV: "test",
          MAS_E2E_SEED_DATABASE_URL: wrongHostSeed,
        },
        readEnvLocalFn: MISSING_ENV_LOCAL,
      }),
    ).toThrow(/10\.0\.0\.5|cluster|host|port|uyuşmuyor/i);

    // Loopback equivalence: localhost:5432 <-> 127.0.0.1:5432 (and implicit default port 5432)
    const localhostSeed =
      "postgres://postgres:postgres@localhost:5432/mas_radar_e2e_verify";
    expect(
      resolveOwnerSeedUrl(APP_E2E_URL, {
        env: {
          NODE_ENV: "test",
          MAS_E2E_SEED_DATABASE_URL: localhostSeed,
        },
        readEnvLocalFn: MISSING_ENV_LOCAL,
      }),
    ).toBe(localhostSeed);

    const implicitPortApp =
      "postgres://mas_radar_app:ci-only-not-a-secret-0123456789@localhost/mas_radar_e2e_verify";
    expect(
      resolveOwnerSeedUrl(implicitPortApp, {
        env: {
          NODE_ENV: "test",
          MAS_E2E_SEED_DATABASE_URL: VALID_SEED_URL,
        },
        readEnvLocalFn: MISSING_ENV_LOCAL,
      }),
    ).toBe(VALID_SEED_URL);
  });

  it("(e) rejects low-privilege runtime role (mas_radar_app / mas_radar_viewer) on owner seed URL before hitting 42501 on public.users", () => {
    expect(() =>
      resolveOwnerSeedUrl(APP_E2E_URL, {
        env: {
          NODE_ENV: "test",
          MAS_E2E_SEED_DATABASE_URL: APP_E2E_URL,
        },
        readEnvLocalFn: MISSING_ENV_LOCAL,
      }),
    ).toThrow(/mas_radar_app|düşük yetkili|42501|owner/i);

    const viewerSeed =
      "postgres://mas_radar_viewer:ci-only-not-a-secret-0123456789@127.0.0.1:5432/mas_radar_e2e_verify";
    expect(() =>
      resolveOwnerSeedUrl(APP_E2E_URL, {
        env: {
          NODE_ENV: "test",
          MAS_E2E_SEED_DATABASE_URL: viewerSeed,
        },
        readEnvLocalFn: MISSING_ENV_LOCAL,
      }),
    ).toThrow(/mas_radar_viewer|düşük yetkili|owner/i);
  });

  it("(f) resolves cleanly for a valid disposable pair (MAS_E2E_DATABASE_URL + MAS_E2E_SEED_DATABASE_URL or same-cluster MIGRATION_DATABASE_URL) without leaking secrets in errors", () => {
    const resolvedExplicit = resolveOwnerSeedUrl(APP_E2E_URL, {
      env: {
        NODE_ENV: "test",
        MAS_E2E_SEED_DATABASE_URL: VALID_SEED_URL,
      },
      readEnvLocalFn: MISSING_ENV_LOCAL,
    });
    expect(resolvedExplicit).toBe(VALID_SEED_URL);

    const resolvedViaVerifier = verifierUrl({
      env: {
        NODE_ENV: "test",
        MAS_E2E_DATABASE_URL: APP_E2E_URL,
        MAS_E2E_SEED_DATABASE_URL: VALID_SEED_URL,
      },
      readEnvLocalFn: MISSING_ENV_LOCAL,
    });
    expect(resolvedViaVerifier).toBe(VALID_SEED_URL);

    // Local workstation fallback via .env.local MIGRATION_DATABASE_URL swapped to appDbName on same cluster
    const resolvedViaEnvLocalMigration = resolveOwnerSeedUrl(APP_E2E_URL, {
      env: { NODE_ENV: "test" },
      readEnvLocalFn: () => ({
        MIGRATION_DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/mas_radar_dev",
      }),
    });
    expect(resolvedViaEnvLocalMigration).toBe(VALID_SEED_URL);

    // Ensure thrown errors never echo raw password substrings
    let caughtMessage = "";
    try {
      resolveOwnerSeedUrl(
        "postgres://mas_radar_app:ci-only-not-a-secret-0123456789@127.0.0.1:5432/mas_radar_dev",
        {
          env: { NODE_ENV: "test", MAS_E2E_SEED_DATABASE_URL: VALID_SEED_URL },
          readEnvLocalFn: MISSING_ENV_LOCAL,
        },
      );
    } catch (err) {
      caughtMessage = err instanceof Error ? err.message : String(err);
    }
    expect(caughtMessage).not.toBe("");
    expect(caughtMessage).not.toContain("ci-only-not-a-secret-0123456789");
  });

  it("(g) enforces SQL pre-seed owner identity & current_database() verification before writing to public.users", async () => {
    // 1. Mismatched current_database() -> fail-closed
    await expect(
      verifyOwnerSeedPoolIdentity(
        {
          async query() {
            return {
              rows: [
                {
                  db: "mas_radar_dev",
                  usr: "postgres",
                  rolsuper: true,
                  rolbypassrls: true,
                  is_db_owner: true,
                  can_seed_users: true,
                },
              ],
              rowCount: 1,
            } as never;
          },
        },
        "mas_radar_e2e_verify",
      ),
    ).rejects.toThrow(/mas_radar_dev|uyuşmuyor|disposable/i);

    // 2. Low-privilege runtime role lacking owner / superuser / users INSERT -> fail-closed
    await expect(
      verifyOwnerSeedPoolIdentity(
        {
          async query() {
            return {
              rows: [
                {
                  db: "mas_radar_e2e_verify",
                  usr: "mas_radar_app",
                  rolsuper: false,
                  rolbypassrls: false,
                  is_db_owner: false,
                  can_seed_users: false,
                },
              ],
              rowCount: 1,
            } as never;
          },
        },
        "mas_radar_e2e_verify",
      ),
    ).rejects.toThrow(/mas_radar_app|owner|yetki|42501/i);

    // 3. Valid superuser/owner on matching disposable DB -> passes
    await expect(
      verifyOwnerSeedPoolIdentity(
        {
          async query() {
            return {
              rows: [
                {
                  db: "mas_radar_e2e_verify",
                  usr: "postgres",
                  rolsuper: true,
                  rolbypassrls: true,
                  is_db_owner: true,
                  can_seed_users: true,
                },
              ],
              rowCount: 1,
            } as never;
          },
        },
        "mas_radar_e2e_verify",
      ),
    ).resolves.toBeUndefined();
  });
});
