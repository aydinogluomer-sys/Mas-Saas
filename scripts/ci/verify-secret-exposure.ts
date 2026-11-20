/**
 * MAS Nexus — Repository Secret & Exposure Policy Gate (`F-01` / `F-12`, Agent 12).
 *
 * Consumes `.gitleaks.toml` (owned by Agent 13) directly in Node.js without external Go binary
 * dependencies, enforces tracked-path `.gitignore` hygiene across `git ls-files`, executes a
 * mandatory positive/negative self-test before scanning the repository, and NEVER prints matched
 * raw secret values (reports strictly `ruleId`, `filePath`, and `lineNumber`).
 *
 * Exit codes:
 *   0 — Self-test passed, 0 tracked sensitive artifacts, 0 secret/IBAN policy violations
 *   1 — Policy parse failure, self-test failure, tracked sensitive file, or >= 1 exposure finding
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface GitleaksAllowlistSpec {
  description: string;
  regexTarget: "match" | "line";
  regexes: RegExp[];
  paths: RegExp[];
}

export interface GitleaksRuleSpec {
  id: string;
  description: string;
  regex: RegExp;
  secretGroup: number | null;
  keywords: string[];
  allowlists: GitleaksAllowlistSpec[];
}

export interface GitleaksPolicy {
  title: string;
  useDefault: boolean;
  globalAllowlists: GitleaksAllowlistSpec[];
  rules: GitleaksRuleSpec[];
}

export interface SecretExposureFinding {
  ruleId: string;
  filePath: string;
  lineNumber: number;
}

const REQUIRED_MAS_RULE_IDS = [
  "mas-telegram-bot-token",
  "mas-telegram-bot-url-token",
  "mas-postgres-connection-credentials",
  "mas-bearer-token",
  "mas-jwt-token",
  "mas-private-key-header",
  "mas-env-secret-assignment",
  "mas-turkish-iban",
] as const;

const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".otf",
  ".pdf",
  ".zip",
  ".gz",
  ".tar",
  ".dump",
  ".xlsx",
  ".xls",
  ".mp4",
  ".webm",
]);

const FORBIDDEN_TRACKED_FILE_PATTERNS: ReadonlyArray<{ id: string; pattern: RegExp }> = [
  { id: "tracked-dotenv-file", pattern: /(?:^|\/)\.env(?:\.(?!example$|template$|sample$)[^/]+)?$/i },
  { id: "tracked-dotenv-backup", pattern: /(?:^|\/)\.env[^/]*\.bak[^/]*$/i },
  { id: "tracked-pg-dump", pattern: /\.(?:dump|sql\.gz)$/i },
  { id: "tracked-private-key-file", pattern: /\.(?:pem|p12|pfx)$/i },
  { id: "tracked-backups-artifact", pattern: /^backups\//i },
  { id: "tracked-playwright-auth-jar", pattern: /^tests\/visual\/\.auth\//i },
];

function stripTomlLineComment(line: string): string {
  let inTripleSingle = false;
  let inTripleDouble = false;
  let inDouble = false;
  let inSingle = false;
  for (let i = 0; i < line.length; i++) {
    if (!inDouble && !inSingle && !inTripleDouble && line.startsWith("'''", i)) {
      inTripleSingle = !inTripleSingle;
      i += 2;
      continue;
    }
    if (!inDouble && !inSingle && !inTripleSingle && line.startsWith('"""', i)) {
      inTripleDouble = !inTripleDouble;
      i += 2;
      continue;
    }
    if (inTripleSingle || inTripleDouble) continue;

    const ch = line[i]!;
    if (ch === '"' && !inSingle && line[i - 1] !== "\\") {
      inDouble = !inDouble;
    } else if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === "#" && !inDouble && !inSingle) {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseTomlStringToken(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("'''") && trimmed.endsWith("'''") && trimmed.length >= 6) {
    return trimmed.slice(3, -3);
  }
  if (trimmed.startsWith('"""') && trimmed.endsWith('"""') && trimmed.length >= 6) {
    return trimmed.slice(3, -3);
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return JSON.parse(trimmed) as string;
  }
  throw new Error(`Unsupported TOML string literal in .gitleaks.toml: ${trimmed.slice(0, 40)}`);
}

function parseTomlStringArray(rawArrayBody: string): string[] {
  const items: string[] = [];
  let i = 0;
  const s = rawArrayBody;
  while (i < s.length) {
    while (i < s.length && /[\s,]/.test(s[i]!)) i++;
    if (i >= s.length) break;
    if (s[i] === "#") {
      while (i < s.length && s[i] !== "\n") i++;
      continue;
    }
    if (s.startsWith("'''", i)) {
      const end = s.indexOf("'''", i + 3);
      if (end < 0) throw new Error("Unterminated ''' literal in .gitleaks.toml array");
      items.push(s.slice(i + 3, end));
      i = end + 3;
      continue;
    }
    if (s.startsWith('"""', i)) {
      const end = s.indexOf('"""', i + 3);
      if (end < 0) throw new Error('Unterminated """ literal in .gitleaks.toml array');
      items.push(s.slice(i + 3, end));
      i = end + 3;
      continue;
    }
    if (s[i] === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0) throw new Error("Unterminated ' literal in .gitleaks.toml array");
      items.push(s.slice(i + 1, end));
      i = end + 1;
      continue;
    }
    if (s[i] === '"') {
      let end = i + 1;
      while (end < s.length) {
        if (s[end] === '"' && s[end - 1] !== "\\") break;
        end++;
      }
      if (end >= s.length) throw new Error('Unterminated " literal in .gitleaks.toml array');
      items.push(JSON.parse(s.slice(i, end + 1)) as string);
      i = end + 1;
      continue;
    }
    throw new Error(`Unexpected token in .gitleaks.toml array at offset ${i}`);
  }
  return items;
}

function buildDefaultExtendedRules(): GitleaksRuleSpec[] {
  const commonTestPathAllowlist: GitleaksAllowlistSpec = {
    description: "Allow synthetic probes in test suites",
    regexTarget: "match",
    regexes: [
      /(?:not-a-secret|NOT-A-SECRET|dummy|DUMMY|fake|FAKE|mock|MOCK|example|EXAMPLE|placeholder|PLACEHOLDER)/,
    ],
    paths: [/^tests\/.*\.(?:test|spec)\.tsx?$/, /^src\/.*\.test\.tsx?$/],
  };

  return [
    {
      id: "default-github-pat",
      description: "GitHub personal access or fine-grained token",
      regex: /\b((?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{50,})\b/g,
      secretGroup: 1,
      keywords: ["ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_"],
      allowlists: [commonTestPathAllowlist],
    },
    {
      id: "default-aws-access-key-id",
      description: "AWS IAM Access Key ID",
      regex: /\b((?:AKIA|ASIA)[0-9A-Z]{16})\b/g,
      secretGroup: 1,
      keywords: ["akia", "asia"],
      allowlists: [commonTestPathAllowlist],
    },
    {
      id: "default-openai-api-key",
      description: "OpenAI API key",
      regex: /\b(sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,})\b/g,
      secretGroup: 1,
      keywords: ["sk-"],
      allowlists: [commonTestPathAllowlist],
    },
    {
      id: "default-slack-token",
      description: "Slack Bot/User/App token",
      regex: /\b(xox[baprs]-[0-9A-Za-z-]{20,})\b/g,
      secretGroup: 1,
      keywords: ["xox"],
      allowlists: [commonTestPathAllowlist],
    },
  ];
}

/**
 * Parses `.gitleaks.toml` into compiled Node.js RegExp rules and allowlists, and verifies that
 * every mandatory MAS Nexus rule ID is present (`fail-closed` on policy truncation).
 */
export function parseGitleaksToml(tomlText: string): GitleaksPolicy {
  const lines = tomlText.split(/\r?\n/);
  let title = "";
  let useDefault = false;
  const globalAllowlists: GitleaksAllowlistSpec[] = [];
  const rules: GitleaksRuleSpec[] = [];

  type SectionKind = "root" | "extend" | "global_allowlist" | "rule" | "rule_allowlist";
  let section: SectionKind = "root";
  let currentAllowlist: GitleaksAllowlistSpec | null = null;
  let currentRule: GitleaksRuleSpec | null = null;

  for (let idx = 0; idx < lines.length; idx++) {
    const rawLine = lines[idx]!;
    const stripped = stripTomlLineComment(rawLine).trim();
    if (!stripped) continue;

    if (stripped === "[extend]") {
      section = "extend";
      continue;
    }
    if (stripped === "[[allowlists]]") {
      section = "global_allowlist";
      currentAllowlist = { description: "", regexTarget: "match", regexes: [], paths: [] };
      globalAllowlists.push(currentAllowlist);
      continue;
    }
    if (stripped === "[[rules]]") {
      section = "rule";
      currentRule = {
        id: "",
        description: "",
        regex: /(?!)/g,
        secretGroup: null,
        keywords: [],
        allowlists: [],
      };
      rules.push(currentRule);
      currentAllowlist = null;
      continue;
    }
    if (stripped === "[[rules.allowlists]]") {
      if (!currentRule) {
        throw new Error(`[[rules.allowlists]] encountered before [[rules]] at line ${idx + 1}`);
      }
      section = "rule_allowlist";
      currentAllowlist = { description: "", regexTarget: "match", regexes: [], paths: [] };
      currentRule.allowlists.push(currentAllowlist);
      continue;
    }

    const eqIdx = stripped.indexOf("=");
    if (eqIdx < 0) continue;
    const key = stripped.slice(0, eqIdx).trim();
    let rhs = stripped.slice(eqIdx + 1).trim();

    if (rhs.startsWith("[") && !rhs.endsWith("]")) {
      const buf = [rhs.slice(1)];
      while (idx + 1 < lines.length) {
        idx++;
        const nextClean = stripTomlLineComment(lines[idx]!).trim();
        if (nextClean.endsWith("]")) {
          buf.push(nextClean.slice(0, -1));
          break;
        }
        buf.push(nextClean);
      }
      rhs = `[${buf.join("\n")}]`;
    }

    if (section === "root" && key === "title") {
      title = parseTomlStringToken(rhs);
    } else if (section === "extend" && key === "useDefault") {
      useDefault = rhs === "true";
    } else if ((section === "global_allowlist" || section === "rule_allowlist") && currentAllowlist) {
      if (key === "description") {
        currentAllowlist.description = parseTomlStringToken(rhs);
      } else if (key === "regexTarget") {
        const t = parseTomlStringToken(rhs);
        currentAllowlist.regexTarget = t === "line" ? "line" : "match";
      } else if (key === "regexes" && rhs.startsWith("[") && rhs.endsWith("]")) {
        currentAllowlist.regexes = parseTomlStringArray(rhs.slice(1, -1)).map((p) => new RegExp(p));
      } else if (key === "paths" && rhs.startsWith("[") && rhs.endsWith("]")) {
        currentAllowlist.paths = parseTomlStringArray(rhs.slice(1, -1)).map((p) => new RegExp(p));
      }
    } else if (section === "rule" && currentRule) {
      if (key === "id") {
        currentRule.id = parseTomlStringToken(rhs);
      } else if (key === "description") {
        currentRule.description = parseTomlStringToken(rhs);
      } else if (key === "regex") {
        currentRule.regex = new RegExp(parseTomlStringToken(rhs), "g");
      } else if (key === "secretGroup") {
        currentRule.secretGroup = Number.parseInt(rhs, 10);
      } else if (key === "keywords" && rhs.startsWith("[") && rhs.endsWith("]")) {
        currentRule.keywords = parseTomlStringArray(rhs.slice(1, -1)).map((k) => k.toLowerCase());
      }
    }
  }

  for (const requiredId of REQUIRED_MAS_RULE_IDS) {
    if (!rules.some((r) => r.id === requiredId)) {
      throw new Error(`Policy integrity error: required rule '${requiredId}' missing in .gitleaks.toml`);
    }
  }

  const allRules = useDefault ? [...rules, ...buildDefaultExtendedRules()] : rules;
  return { title, useDefault, globalAllowlists, rules: allRules };
}

export function loadRepoGitleaksPolicy(repoRoot = process.cwd()): GitleaksPolicy {
  const policyPath = path.join(repoRoot, ".gitleaks.toml");
  if (!fs.existsSync(policyPath)) {
    throw new Error(`.gitleaks.toml bulunamadı (${policyPath})`);
  }
  return parseGitleaksToml(fs.readFileSync(policyPath, "utf8"));
}

function isAllowlistedBySpec(
  spec: GitleaksAllowlistSpec,
  normalizedPath: string,
  candidateMatch: string,
  fullLine: string,
): boolean {
  const hasPathRules = spec.paths.length > 0;
  const hasRegexRules = spec.regexes.length > 0;
  if (!hasPathRules && !hasRegexRules) return false;

  const pathMatches = !hasPathRules || spec.paths.some((re) => re.test(normalizedPath));
  const target = spec.regexTarget === "line" ? fullLine : candidateMatch;
  const regexMatches = !hasRegexRules || spec.regexes.some((re) => re.test(target));
  return pathMatches && regexMatches;
}

export function isPathGloballySkipped(normalizedPath: string, policy: GitleaksPolicy): boolean {
  for (const allow of policy.globalAllowlists) {
    if (allow.paths.length > 0 && allow.regexes.length === 0) {
      if (allow.paths.some((re) => re.test(normalizedPath))) return true;
    }
  }
  return false;
}

/**
 * Scans a single file's text against `.gitleaks.toml` rules + allowlists.
 * Never retains matched secret strings in returned findings.
 */
export function scanTextContentWithPolicy(
  filePath: string,
  content: string,
  policy: GitleaksPolicy,
): SecretExposureFinding[] {
  const normalizedPath = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (isPathGloballySkipped(normalizedPath, policy)) {
    return [];
  }

  const findings: SecretExposureFinding[] = [];
  const lines = content.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line) continue;
    const lowerLine = line.toLowerCase();

    for (const rule of policy.rules) {
      if (rule.keywords.length > 0 && !rule.keywords.some((kw) => lowerLine.includes(kw))) {
        continue;
      }

      const re = new RegExp(rule.regex.source, rule.regex.flags.includes("g") ? rule.regex.flags : `${rule.regex.flags}g`);
      let match: RegExpExecArray | null;
      while ((match = re.exec(line)) !== null) {
        const extracted =
          rule.secretGroup != null && match[rule.secretGroup] !== undefined
            ? match[rule.secretGroup]!
            : match[0]!;

        const globallyAllowlisted = policy.globalAllowlists.some((allow) =>
          isAllowlistedBySpec(allow, normalizedPath, extracted, line),
        );
        if (globallyAllowlisted) continue;

        const ruleAllowlisted = rule.allowlists.some((allow) =>
          isAllowlistedBySpec(allow, normalizedPath, extracted, line),
        );
        if (ruleAllowlisted) continue;

        findings.push({
          ruleId: rule.id,
          filePath: normalizedPath,
          lineNumber: i + 1,
        });
        break;
      }
    }
  }

  return findings;
}

export function formatSecretFindingRedacted(finding: SecretExposureFinding): string {
  return `[SECRET-EXPOSURE] rule=${finding.ruleId} file=${finding.filePath} line=${finding.lineNumber}`;
}

/**
 * Built-in positive & negative control self-test (`F-12`).
 * All synthetic probes are assembled at runtime from split fragments so this source file itself
 * contains zero literal secret patterns.
 */
export function runSecretScannerSelfTest(policy: GitleaksPolicy): {
  ok: boolean;
  positiveDetected: number;
  negativeClean: number;
  errors: string[];
} {
  const errors: string[] = [];

  const synTgBot = ["918273645", ":", "AAH", "Q9zR8xW7vU6tS5rP4oN3mL2kJ1hG0fE9"].join("");
  const synTgUrl = [
    "https://api.telegram.org",
    "/bot",
    "876543210",
    ":",
    "AAH_xYz9876543210AbCdEfGhIjKlMnOpQr",
    "/sendMessage",
  ].join("");
  const synPgUri = ["postgres://mas_radar_app:", "ProdCutoverPass_99!", "@127.0.0.1:5432/mas_radar_dev"].join("");
  const synBearer = ["Authorization: Bearer ", "eySecretLiveBearerToken_9876543210abcd"].join("");
  const synJwt = [
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
    "eyJzdWIiOiJ1c2VyLTEyMyIsInJvbGUiOiJhZG1pbiJ9",
    "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
  ].join(".");
  const synPemHeader = ["-----BEGIN ", "RSA ", "PRIVATE KEY-----"].join("");
  const synEnvAssign = ["MAS_RADAR_APP_DB_PASSWORD", "=", '"LiveProdSecretValue_2026!"'].join("");
  const synIban = ["TR", "33 0006 1005 1978 6457 8413 26"].join("");

  const positiveProbes: ReadonlyArray<{ label: string; path: string; line: string; expectedRuleId: string }> = [
    { label: "synthetic-telegram-token", path: "docs/probe.md", line: `tok=${synTgBot}`, expectedRuleId: "mas-telegram-bot-token" },
    { label: "synthetic-telegram-url", path: "src/probe.ts", line: `url="${synTgUrl}"`, expectedRuleId: "mas-telegram-bot-url-token" },
    { label: "synthetic-live-pg-uri", path: "scripts/probe.ts", line: `const u = "${synPgUri}";`, expectedRuleId: "mas-postgres-connection-credentials" },
    { label: "synthetic-bearer", path: "src/probe.ts", line: synBearer, expectedRuleId: "mas-bearer-token" },
    { label: "synthetic-jwt", path: "src/probe.ts", line: `const jwt = "${synJwt}";`, expectedRuleId: "mas-jwt-token" },
    { label: "synthetic-private-key", path: "docs/probe.md", line: synPemHeader, expectedRuleId: "mas-private-key-header" },
    { label: "synthetic-env-secret", path: "scripts/probe.sh", line: synEnvAssign, expectedRuleId: "mas-env-secret-assignment" },
    { label: "synthetic-unredacted-iban", path: "docs/probe.md", line: `IBAN: ${synIban}`, expectedRuleId: "mas-turkish-iban" },
  ];

  let positiveDetected = 0;
  for (const p of positiveProbes) {
    const res = scanTextContentWithPolicy(p.path, p.line, policy);
    if (res.some((r) => r.ruleId === p.expectedRuleId)) {
      positiveDetected++;
    } else {
      errors.push(`Self-test positive control missed '${p.expectedRuleId}' (${p.label})`);
    }
  }

  const negativeProbes: ReadonlyArray<{ label: string; path: string; line: string }> = [
    {
      label: "ci-disposable-db-password",
      path: ".github/workflows/ci.yml",
      line: "APP_URL: postgres://mas_radar_app:ci-only-not-a-secret-0123456789@127.0.0.1:5432/mas_radar_e2e_verify",
    },
    {
      label: "visual-harness-placeholder",
      path: "tests/visual/global-setup.ts",
      line: 'export const TEST_PASSWORD = "faz2-visual-harness-not-a-secret";',
    },
    {
      label: "disposable-owner-postgres-uri",
      path: ".github/workflows/ci.yml",
      line: "MAS_E2E_SEED_DATABASE_URL: postgres://postgres:postgres@127.0.0.1:5432/mas_radar_e2e_verify",
    },
    {
      label: "ui-zeroed-iban-mask",
      path: "src/components/iban-input.tsx",
      line: 'placeholder="TR00 0000 0000 0000 0000 0000 00"',
    },
    {
      label: "synthetic-iban-in-unit-test",
      path: "tests/unit/iban-mod97.test.ts",
      line: `expect(isValidIban("${synIban}")).toBe(true);`,
    },
  ];

  let negativeClean = 0;
  for (const n of negativeProbes) {
    const res = scanTextContentWithPolicy(n.path, n.line, policy);
    if (res.length === 0) {
      negativeClean++;
    } else {
      errors.push(
        `Self-test false positive on '${n.label}': rules=[${res.map((r) => r.ruleId).join(",")}]`,
      );
    }
  }

  return {
    ok: errors.length === 0,
    positiveDetected,
    negativeClean,
    errors,
  };
}

function listGitTrackedFiles(repoRoot: string): string[] {
  const raw = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    {
      cwd: repoRoot,
      encoding: "buffer",
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  return Array.from(
    new Set(
      raw
        .toString("utf8")
        .split("\0")
        .map((f) => f.trim())
        .filter(Boolean),
    ),
  );
}

function isBinaryBuffer(buf: Buffer): boolean {
  const sampleLen = Math.min(buf.length, 8_192);
  for (let i = 0; i < sampleLen; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

export function scanRepositoryTrackedFiles(repoRoot = process.cwd()): {
  policy: GitleaksPolicy;
  selfTest: ReturnType<typeof runSecretScannerSelfTest>;
  trackedFilesCount: number;
  evaluatedTextFilesCount: number;
  forbiddenTrackedFiles: SecretExposureFinding[];
  secretFindings: SecretExposureFinding[];
} {
  const policy = loadRepoGitleaksPolicy(repoRoot);
  const selfTest = runSecretScannerSelfTest(policy);
  const trackedFiles = listGitTrackedFiles(repoRoot);

  const forbiddenTrackedFiles: SecretExposureFinding[] = [];
  const secretFindings: SecretExposureFinding[] = [];
  let evaluatedTextFilesCount = 0;

  for (const relPath of trackedFiles) {
    const normalized = relPath.replace(/\\/g, "/");

    for (const rule of FORBIDDEN_TRACKED_FILE_PATTERNS) {
      if (rule.pattern.test(normalized)) {
        forbiddenTrackedFiles.push({ ruleId: rule.id, filePath: normalized, lineNumber: 1 });
      }
    }

    if (isPathGloballySkipped(normalized, policy)) continue;
    const ext = path.extname(normalized).toLowerCase();
    if (BINARY_EXTENSIONS.has(ext)) continue;

    const absPath = path.join(repoRoot, normalized);
    if (!fs.existsSync(absPath)) continue;
    const stat = fs.statSync(absPath);
    if (!stat.isFile()) continue;

    const buf = fs.readFileSync(absPath);
    if (isBinaryBuffer(buf)) continue;

    evaluatedTextFilesCount++;
    const fileFindings = scanTextContentWithPolicy(normalized, buf.toString("utf8"), policy);
    secretFindings.push(...fileFindings);
  }

  return {
    policy,
    selfTest,
    trackedFilesCount: trackedFiles.length,
    evaluatedTextFilesCount,
    forbiddenTrackedFiles,
    secretFindings,
  };
}

function main(): void {
  console.log("=== MAS NEXUS — CI REPOSITORY SECRET & EXPOSURE POLICY SCAN (F-01 / F-12) ===");
  const report = scanRepositoryTrackedFiles(process.cwd());

  console.log(
    `Policy loaded: '${report.policy.title}' (rules=${report.policy.rules.length}, useDefault=${report.policy.useDefault})`,
  );
  console.log(
    `Self-test: ${report.selfTest.ok ? "PASS" : "FAIL"} (positiveDetected=${report.selfTest.positiveDetected}/8, negativeAllowlisted=${report.selfTest.negativeClean}/5)`,
  );
  console.log(
    `Repository scan: trackedFiles=${report.trackedFilesCount}, textFilesEvaluated=${report.evaluatedTextFilesCount}, forbiddenPaths=${report.forbiddenTrackedFiles.length}, secretFindings=${report.secretFindings.length}`,
  );

  if (!report.selfTest.ok) {
    for (const err of report.selfTest.errors) {
      console.error(`[SELF-TEST FAIL] ${err}`);
    }
    process.exit(1);
  }

  if (report.forbiddenTrackedFiles.length > 0 || report.secretFindings.length > 0) {
    for (const f of [...report.forbiddenTrackedFiles, ...report.secretFindings]) {
      console.error(formatSecretFindingRedacted(f));
    }
    console.error(
      `SECRET EXPOSURE SCAN FAIL: ${report.forbiddenTrackedFiles.length + report.secretFindings.length} violation(s) detected (raw values suppressed).`,
    );
    process.exit(1);
  }

  console.log("SECRET EXPOSURE SCAN: ALL PASS (0 leaks)");
}

const isMainModule =
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  try {
    main();
  } catch (err) {
    console.error("SECRET EXPOSURE SCAN FATAL:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
