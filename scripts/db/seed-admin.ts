// P0-A bootstrap: creates (or resets) one named account, driven entirely by explicit
// CLI arguments / env — no public signup flow exists anywhere in this app by design.
//
// The password is NEVER accepted as a CLI argument — argv is visible in shell history
// and in the process list (`ps`/Task Manager) on this exact machine, and this project has
// already been burned once by assuming a "quiet" local environment is actually private.
// It comes from either:
//   1. SEED_ADMIN_PASSWORD env var, if set (documented in .env.example, never logged), or
//   2. an interactive masked prompt (raw-mode stdin, echoes '*' per character).
//
// Idempotent: re-running against an existing username updates its password/display
// name/role and reactivates it — the documented way to reset a forgotten password before
// the admin UI exists to do it, and safe to run more than once by accident.
import { Pool } from "pg";
import { hash as argon2Hash } from "@node-rs/argon2";

// `2` is Algorithm.Argon2id — @node-rs/argon2's Algorithm is a const enum, which can't be
// imported by value under this project's isolatedModules; see src/lib/auth.ts.
const ARGON2_OPTIONS = { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 };

const ENTER_LF = String.fromCharCode(10);
const ENTER_CR = String.fromCharCode(13);
const CTRL_C = String.fromCharCode(3);
const BACKSPACE_DEL = String.fromCharCode(127);
const BACKSPACE_BS = String.fromCharCode(8);

interface Args {
  username: string;
  displayName: string;
  role: "admin" | "operator";
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const username = get("--username");
  const displayName = get("--display-name");
  const role = get("--role") ?? "admin";
  if (!username) throw new Error("--username zorunlu.");
  if (!displayName) throw new Error("--display-name zorunlu.");
  if (role !== "admin" && role !== "operator") throw new Error("--role yalnız 'admin' veya 'operator' olabilir.");
  if (argv.includes("--password")) {
    throw new Error(
      "--password argv üzerinden kabul edilmiyor (shell geçmişinde/process listesinde görünür). " +
        "SEED_ADMIN_PASSWORD ortam değişkenini kullanın veya bayraksız çalıştırıp maskeli girişi kullanın.",
    );
  }
  return { username, displayName, role };
}

/** Raw-mode stdin, echoes '*' per character, never the real character — no external
 * dependency needed for this. */
function promptPasswordMasked(label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error("Interaktif parola girişi için bir TTY gerekli — SEED_ADMIN_PASSWORD ortam değişkenini kullanın."));
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
  const fromEnv = process.env.SEED_ADMIN_PASSWORD;
  if (fromEnv != null && fromEnv !== "") return fromEnv;
  const password = await promptPasswordMasked("Parola: ");
  const confirm = await promptPasswordMasked("Parola (tekrar): ");
  if (password !== confirm) throw new Error("Parolalar eşleşmiyor.");
  return password;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const password = await resolvePassword();
  if (password.length < 12) throw new Error("Parola en az 12 karakter olmalı.");
  if (password.toLowerCase() === args.username.toLowerCase()) throw new Error("Parola kullanıcı adıyla aynı olamaz.");

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL tanımlı değil.");
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const passwordHash = await argon2Hash(password, ARGON2_OPTIONS);
    const res = await pool.query<{ id: string }>(
      `insert into public.users (username, password_hash, display_name, role)
       values (lower($1), $2, $3, $4)
       on conflict (username) do update set
         password_hash = excluded.password_hash,
         display_name = excluded.display_name,
         role = excluded.role,
         is_active = true,
         failed_login_count = 0,
         locked_until = null
       returning id`,
      [args.username, passwordHash, args.displayName, args.role],
    );
    console.log(`OK — kullanıcı '${args.username.toLowerCase()}' (${args.role}), id=${res.rows[0].id}`);
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
