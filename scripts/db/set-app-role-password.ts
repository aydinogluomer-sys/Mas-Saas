// Faz 15 — gives the low-privilege runtime role (created NOLOGIN by migration 0035) a
// password and flips it to LOGIN. Deliberately a separate, unversioned step: a credential
// must never live in a migration file, because migrations are committed to git.
//
// Run once per PostgreSQL cluster, not once per database — roles are cluster-scoped:
//   MIGRATION_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/mas_radar_dev \
//     tsx scripts/db/set-app-role-password.ts
//
// The password comes from either MAS_RADAR_APP_DB_PASSWORD (documented in .env.example,
// never logged) or an interactive masked prompt — the same two-channel rule, and the same
// masked-prompt implementation, as scripts/db/seed-admin.ts. It is never accepted as a CLI
// argument: argv is visible in shell history and in the process list.
import { Pool } from "pg";

const ROLE = "mas_radar_app";

const ENTER_LF = String.fromCharCode(10);
const ENTER_CR = String.fromCharCode(13);
const CTRL_C = String.fromCharCode(3);
const BACKSPACE_DEL = String.fromCharCode(127);
const BACKSPACE_BS = String.fromCharCode(8);

/** Raw-mode stdin, echoes '*' per character, never the real character. Copied deliberately
 * from scripts/db/seed-admin.ts rather than shared: both scripts are standalone operational
 * tools, and a shared helper would put a password-reading dependency between them. */
function promptPasswordMasked(label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error("Interaktif parola girişi için bir TTY gerekli — MAS_RADAR_APP_DB_PASSWORD ortam değişkenini kullanın."));
      return;
    }
    process.stdout.write(label);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const onData = (char: string) => {
      if (char === ENTER_LF || char === ENTER_CR) {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener("data", onData);
        process.stdout.write("\n");
        resolve(value);
        return;
      }
      if (char === CTRL_C) {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener("data", onData);
        process.stdout.write("\n");
        reject(new Error("İptal edildi."));
        return;
      }
      if (char === BACKSPACE_DEL || char === BACKSPACE_BS) {
        if (value.length > 0) {
          value = value.slice(0, -1);
          process.stdout.write("\b \b");
        }
        return;
      }
      value += char;
      process.stdout.write("*");
    };
    stdin.on("data", onData);
  });
}

async function resolvePassword(): Promise<string> {
  const fromEnv = process.env.MAS_RADAR_APP_DB_PASSWORD;
  if (fromEnv != null && fromEnv !== "") return fromEnv;
  const password = await promptPasswordMasked(`'${ROLE}' rolü için parola: `);
  const confirm = await promptPasswordMasked("Parola (tekrar): ");
  if (password !== confirm) throw new Error("Parolalar eşleşmiyor.");
  return password;
}

/** Rebuilds the owner connection string as a runtime one: same host/port/database, but the
 * app role's credentials. Used only to prove the new password actually works. */
function runtimeUrlFrom(ownerUrl: string, password: string): string {
  const u = new URL(ownerUrl);
  u.username = ROLE;
  u.password = password;
  return u.toString();
}

async function main(): Promise<void> {
  if (process.argv.slice(2).includes("--password")) {
    throw new Error(
      "--password argv üzerinden kabul edilmiyor (shell geçmişinde/process listesinde görünür). " +
        "MAS_RADAR_APP_DB_PASSWORD ortam değişkenini kullanın veya bayraksız çalıştırıp maskeli girişi kullanın.",
    );
  }

  // Owner/superuser connection — ALTER ROLE needs CREATEROLE or superuser. Falls back to
  // DATABASE_URL so a cluster that has not split its env vars yet still works.
  const ownerUrl = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!ownerUrl) throw new Error("MIGRATION_DATABASE_URL (veya DATABASE_URL) tanımlı değil.");

  const password = await resolvePassword();
  if (password.length < 12) throw new Error("Parola en az 12 karakter olmalı.");

  const owner = new Pool({ connectionString: ownerUrl, max: 1 });
  try {
    const exists = await owner.query<{ ok: boolean }>("select exists(select 1 from pg_roles where rolname = $1) as ok", [ROLE]);
    if (exists.rows[0]?.ok !== true) {
      throw new Error(`'${ROLE}' rolü yok — önce migration 0035 uygulanmalı (pnpm db:migrate).`);
    }

    // ALTER ROLE is a utility statement: PostgreSQL does not accept bind parameters in it,
    // so `alter role ... password $1` is not available. Instead the password is sent as a
    // real bind parameter to format('%L'), which is PostgreSQL's own literal-quoting
    // primitive, and the safely-escaped statement it returns is what gets executed. No
    // string escaping is done on the client side.
    //
    // Caveat worth knowing: the executed statement text contains the password, so a server
    // with log_statement='all' would write it to the PostgreSQL log. The default
    // log_statement='none' (what docker-compose.yml's stock postgres:16 image uses) does not.
    const stmt = await owner.query<{ sql: string }>(
      "select format('alter role %I login password %L', $1::text, $2::text) as sql",
      [ROLE, password],
    );
    await owner.query(stmt.rows[0].sql);
    console.log(`OK — '${ROLE}' rolüne parola atandı ve LOGIN açıldı.`);
  } finally {
    await owner.end();
  }

  // Prove it: connect as the runtime role with the password we just set.
  const runtime = new Pool({ connectionString: runtimeUrlFrom(ownerUrl, password), max: 1, connectionTimeoutMillis: 5_000 });
  try {
    const res = await runtime.query<{ who: string; one: number }>("select current_user as who, 1 as one");
    if (res.rows[0]?.who !== ROLE || res.rows[0]?.one !== 1) {
      throw new Error(`Doğrulama bağlantısı beklenmedik sonuç verdi: current_user='${res.rows[0]?.who}'.`);
    }
    console.log(`OK — doğrulama bağlantısı başarılı (current_user=${res.rows[0].who}, select 1 çalıştı).`);
    console.log(`Sıradaki adım: .env.local içindeki DATABASE_URL'i ${ROLE} rolüne çevirin (parolayı buraya yazdırmıyoruz).`);
  } finally {
    await runtime.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
