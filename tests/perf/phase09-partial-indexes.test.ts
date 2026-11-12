import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Client } from "pg";
import { MIGRATIONS_DIR, validateFileSet } from "../../scripts/db/migration-lib";
import { isDisposableDatabaseName, PROTECTED_DB_NAMES } from "../../scripts/db/owner-url";

const ROOT = process.cwd();
const MIGRATION_FILE = "0097_hot_path_partial_indexes.sql";
const DISPOSABLE_DB = "mas_radar_idx_verify";

const EXPECTED_INDEXES = [
  "idx_sessions_active_token_hash",
  "idx_payment_instances_open_due_date",
  "idx_invoices_open_direction_due_date",
  "idx_bank_transactions_queue_date",
  "idx_audit_logs_created_id_desc",
  "idx_mapping_reviews_active_sev_created",
] as const;

interface Pg16CtlTools {
  initdb: string;
  pgCtl: string;
}

function resolveLocalPg16CtlTools(): Pg16CtlTools | null {
  const ext = process.platform === "win32" ? ".exe" : "";
  const candidateDirs = [
    (process.env.MAS_PG_BIN_DIR ?? "").trim(),
    process.platform === "win32" ? "C:\\MAS\\pgsql16\\bin" : "/usr/lib/postgresql/16/bin",
  ].filter((d) => d !== "");

  for (const dir of candidateDirs) {
    const initdb = path.join(dir, `initdb${ext}`);
    const pgCtl = path.join(dir, `pg_ctl${ext}`);
    if (existsSync(initdb) && existsSync(pgCtl)) {
      return { initdb, pgCtl };
    }
  }
  return null;
}

function allocateEphemeralLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close(() => reject(new Error("Geçici loopback portu alınamadı.")));
        return;
      }
      const port = addr.port;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

describe("Faz 9 — Yerel PostgreSQL kısmi ve bileşik indeksler (migration 0097)", () => {
  const sql = readFileSync(path.join(MIGRATIONS_DIR, MIGRATION_FILE), "utf8");
  const codeOnly = sql.replace(/--.*$/gm, "");
  const schemaDoc = readFileSync(path.join(ROOT, "docs", "database-schema.md"), "utf8");

  it("koşucu dosya kümesi (validateFileSet) 0097'yi sıfır hatayla kabul eder ve docs/database-schema.md günceldir", () => {
    const validation = validateFileSet(MIGRATIONS_DIR);
    expect(validation.errors).toEqual([]);
    expect(validation.files.map((f) => f.name)).toContain(MIGRATION_FILE);

    expect(schemaDoc).toContain("0097");
    for (const idx of EXPECTED_INDEXES) {
      expect(schemaDoc).toContain(idx);
    }
  });

  it("0097 yalnız 6 idempotent CREATE INDEX IF NOT EXISTS içerir; tablo/görünüm/GRANT/RLS değişikliği yapmaz", () => {
    for (const idx of EXPECTED_INDEXES) {
      expect(codeOnly).toMatch(new RegExp(`create\\s+index\\s+if\\s+not\\s+exists\\s+${idx}\\b`, "i"));
    }
    expect(codeOnly.match(/create\s+index\b/gi)).toHaveLength(EXPECTED_INDEXES.length);
    expect(codeOnly).not.toMatch(/\bgrant\b|\brevoke\b/i);
    expect(codeOnly).not.toMatch(/\bcreate\s+(table|view|policy|function|trigger|role)\b/i);
    expect(codeOnly).not.toMatch(/\balter\s+(table|view|policy|function|role)\b/i);
    expect(codeOnly).not.toMatch(/\bdrop\s+(table|view|policy|function|trigger|role|index)\b/i);
    expect(codeOnly).not.toMatch(/security\s+definer/i);
  });

  it(
    "fiziksel olarak izole geçici PostgreSQL 16 kümesinde (mas_radar_idx_verify) 0001..0097 uygulanır ve 6 indeks sorgu planlayıcısı tarafından kullanılır",
    async () => {
      // Güvenlik kapısı: kanonik veritabanına (mas_radar_dev / C:\MAS\pgdata16 / 5432) asla dokunulmaz.
      expect(isDisposableDatabaseName(DISPOSABLE_DB)).toBe(true);
      expect(PROTECTED_DB_NAMES).not.toContain(DISPOSABLE_DB);

      const tools = resolveLocalPg16CtlTools();
      if (!tools) {
        return;
      }

      const tempRoot = mkdtempSync(path.join(os.tmpdir(), "mas-pg16-idx-verify-"));
      const dataDir = path.join(tempRoot, "pgdata");
      const logFile = path.join(tempRoot, "postgres.log");
      const port = await allocateEphemeralLoopbackPort();
      expect(port).not.toBe(5432);

      let started = false;
      let adminClient: Client | null = null;
      let verifyClient: Client | null = null;

      try {
        execFileSync(
          tools.initdb,
          ["-D", dataDir, "-U", "postgres", "-A", "trust", "--encoding=UTF8", "--locale=C", "--no-sync"],
          { stdio: "pipe" },
        );

        execFileSync(
          tools.pgCtl,
          ["-D", dataDir, "-l", logFile, "-o", `-F -h 127.0.0.1 -p ${port}`, "-w", "start"],
          { stdio: "ignore", timeout: 20_000 },
        );
        started = true;

        adminClient = new Client({
          host: "127.0.0.1",
          port,
          user: "postgres",
          database: "postgres",
        });
        await adminClient.connect();
        await adminClient.query(`create database ${DISPOSABLE_DB}`);

        verifyClient = new Client({
          host: "127.0.0.1",
          port,
          user: "postgres",
          database: DISPOSABLE_DB,
        });
        await verifyClient.connect();

        const currentDbRes = await verifyClient.query<{ db: string }>(
          "select current_database() as db",
        );
        expect(currentDbRes.rows[0]?.db).toBe(DISPOSABLE_DB);
        expect(currentDbRes.rows[0]?.db).not.toBe("mas_radar_dev");

        // Yerel Supabase uyumluluk saplamaları + tüm 0001..0097 migration dosyaları
        const bootstrapSql = readFileSync(
          path.join(ROOT, "scripts", "db", "local-bootstrap.sql"),
          "utf8",
        );
        await verifyClient.query(bootstrapSql);

        const files = validateFileSet(MIGRATIONS_DIR).files.filter((f) => f.name <= MIGRATION_FILE);
        expect(files.at(-1)?.name).toBe(MIGRATION_FILE);

        for (const file of files) {
          await verifyClient.query("begin");
          try {
            await verifyClient.query(file.content);
            await verifyClient.query("commit");
          } catch (err) {
            await verifyClient.query("rollback");
            throw new Error(`Migration ${file.name} başarısız: ${(err as Error).message}`);
          }
        }

        // 1) 6 indeksin tamamı pg_indexes + pg_index kataloglarında geçerli ve hazır olmalı
        const catalogRes = await verifyClient.query<{
          indexname: string;
          indisvalid: boolean;
          indisready: boolean;
        }>(
          `select i.indexname, ix.indisvalid, ix.indisready
             from pg_indexes i
             join pg_class c on c.relname = i.indexname
             join pg_namespace n on n.oid = c.relnamespace and n.nspname = i.schemaname
             join pg_index ix on ix.indexrelid = c.oid
            where i.schemaname = 'public'
              and i.indexname = any($1::text[])
            order by i.indexname`,
          [[...EXPECTED_INDEXES]],
        );

        expect(catalogRes.rows).toHaveLength(EXPECTED_INDEXES.length);
        for (const row of catalogRes.rows) {
          expect(row.indisvalid, `${row.indexname} indisvalid`).toBe(true);
          expect(row.indisready, `${row.indexname} indisready`).toBe(true);
        }

        // 2) İdempotency testi: 0097 ikinci kez koştuğunda sıfır hata verir
        await verifyClient.query(sql);

        // 3) Oturum tablosuna 1 aktif + 25 iptal edilmiş oturum ekleyip VACUUM ANALYZE ile
        //    kısmi kapsayıcı indeksin (idx_sessions_active_token_hash) seçildiğini doğrula.
        const userInsert = await verifyClient.query<{ id: string }>(
          `insert into public.users (username, password_hash, display_name, role)
           values ('idx_verify_admin', 'scrypt:dummy', 'Index Verify Admin', 'admin')
           returning id::text as id`,
        );
        const userId = userInsert.rows[0]!.id;
        await verifyClient.query(
          `insert into public.sessions (user_id, token_hash, expires_at, revoked_at)
           values ($1, 'active-token-hash', now() + interval '7 days', null)`,
          [userId],
        );
        await verifyClient.query(
          `insert into public.sessions (user_id, token_hash, expires_at, revoked_at)
           select $1, 'revoked-token-' || g::text, now() + interval '7 days', now()
             from generate_series(1, 25) as g`,
          [userId],
        );
        await verifyClient.query("vacuum analyze public.sessions");

        // 4) EXPLAIN (FORMAT JSON) ile 6 sıcak sorgunun tamamında yeni indekslerin planlayıcı
        //    tarafından seçildiğini kanıtla.
        await verifyClient.query("begin");
        await verifyClient.query("set local enable_seqscan = off");
        await verifyClient.query("set local enable_bitmapscan = off");

        const explainChecks: Array<{ indexName: string; query: string }> = [
          {
            indexName: "idx_sessions_active_token_hash",
            query: `select user_id, id, expires_at, last_seen_at, created_at
                      from public.sessions
                     where token_hash = 'active-token-hash'
                       and revoked_at is null
                       and expires_at > now()`,
          },
          {
            indexName: "idx_payment_instances_open_due_date",
            query: `select id, due_date, amount, status, currency
                      from public.payment_instances
                     where due_date < '2026-11-01'::date
                       and status in ('unpaid', 'partial', 'planned', 'late')
                     order by due_date, amount desc nulls last
                     limit 50`,
          },
          {
            indexName: "idx_invoices_open_direction_due_date",
            query: `select id, direction, due_date, (gross_amount - paid_amount) as remaining
                      from public.invoices
                     where direction = 'purchase'
                       and status in ('open', 'partial')
                     order by due_date
                     limit 50`,
          },
          {
            indexName: "idx_bank_transactions_queue_date",
            query: `select id, txn_date, amount
                      from public.bank_unmatched_queue
                     order by txn_date desc, abs(amount) desc, id desc
                     limit 50`,
          },
          {
            indexName: "idx_audit_logs_created_id_desc",
            query: `select id, action, entity_table, created_at
                      from public.audit_logs
                     order by created_at desc, id desc
                     limit 50 offset 0`,
          },
          {
            indexName: "idx_mapping_reviews_active_sev_created",
            query: `select severity, status, issue_type, created_at
                      from public.mapping_reviews
                     where status in ('open', 'rejected')
                       and severity = 'critical'
                     order by created_at
                     limit 50`,
          },
        ];

        for (const check of explainChecks) {
          const planRes = await verifyClient.query<{ "QUERY PLAN": unknown }>(
            `explain (format json) ${check.query}`,
          );
          const planText = JSON.stringify(planRes.rows[0]?.["QUERY PLAN"]);
          expect(planText, `${check.indexName} EXPLAIN planında yer almalı`).toContain(
            check.indexName,
          );
        }

        await verifyClient.query("rollback");
      } finally {
        if (verifyClient) {
          await verifyClient.end().catch(() => {});
        }
        if (adminClient) {
          await adminClient.end().catch(() => {});
        }
        if (started) {
          try {
            execFileSync(
              tools.pgCtl,
              ["-D", dataDir, "-m", "immediate", "-w", "stop"],
              { stdio: "ignore", timeout: 15_000 },
            );
          } catch {
            // Geçici küme zaten durmuş olabilir.
          }
        }
        rmSync(tempRoot, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
