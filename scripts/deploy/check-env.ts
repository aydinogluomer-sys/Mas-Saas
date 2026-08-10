// Pre-flight env validation for local private production. Prints only PRESENCE/ABSENCE
// of variables — never their secret values. Exits non-zero if a required var is missing.
// Run: pnpm exec tsx scripts/deploy/check-env.ts

const REQUIRED = ["DATABASE_URL"] as const;
const OPTIONAL = [
  "SEED_ADMIN_PASSWORD",
  "MAS_QA_BYPASS_AUTH",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "POSTGRES_USER",
  "POSTGRES_PASSWORD",
  "APP_COMMIT_SHA",
  "APP_BUILD_TIME",
] as const;

function present(name: string): boolean {
  const v = process.env[name];
  return v != null && v !== "";
}

/** Mask a connection string: keep scheme/host/db, hide credentials. Never print raw. */
function safeDbHint(url: string | undefined): string {
  if (!url) return "(unset)";
  try {
    const u = new URL(url);
    return `${u.protocol}//***@${u.hostname}:${u.port || "5432"}${u.pathname}`;
  } catch {
    return "(set, unparseable)";
  }
}

let ok = true;
console.log("MAS Nakit Radar — env check\n");

console.log("Required:");
for (const name of REQUIRED) {
  const p = present(name);
  if (!p) ok = false;
  const hint = name === "DATABASE_URL" ? ` → ${safeDbHint(process.env[name])}` : "";
  console.log(`  ${p ? "✓" : "✗ MISSING"} ${name}${hint}`);
}

console.log("\nOptional:");
for (const name of OPTIONAL) {
  console.log(`  ${present(name) ? "✓ set" : "· unset"} ${name}`);
}

// Security posture notes (no values printed)
console.log("\nPosture:");
console.log(`  auth:        always required (named accounts, no env toggle disables it — see docs/local-production-deploy.md)`);
if (present("MAS_QA_BYPASS_AUTH")) {
  console.log(`  ⚠ MAS_QA_BYPASS_AUTH is set — must only ever be used against a disposable TestSprite DB, never a real one.`);
}
console.log(`  telegram:    ${present("TELEGRAM_BOT_TOKEN") && present("TELEGRAM_CHAT_ID") ? "configured (server-only)" : "not configured → reminders log 'failed'"}`);

if (!ok) {
  console.error("\nENV CHECK FAILED: fill required vars in .env.local (see .env.example).");
  process.exit(1);
}
console.log("\nENV CHECK OK.");
