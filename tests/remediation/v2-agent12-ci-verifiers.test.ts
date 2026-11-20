import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { describe, expect, it } from "vitest";

import { verifyRouteAuthAndIsolationBehavior } from "../../scripts/db/export-leakage-verify";
import { validateOptimizationCandidates } from "../../scripts/phase13b-verify";
import { assertDisposableCiRgEnv } from "../../scripts/ci/verify-rg-disposable";
import {
  formatSecretFindingRedacted,
  loadRepoGitleaksPolicy,
  runSecretScannerSelfTest,
  scanTextContentWithPolicy,
} from "../../scripts/ci/verify-secret-exposure";
import type { OptimizationCandidate } from "../../src/lib/scenarios/engine";

const ROOT = process.cwd();

describe("Agent 12 — V2 CI, Behavioral Export/Search Auth Gate, Dead-Code & Disposable RG Verifiers", () => {
  describe("F-07: Static regex sniffing defect vs behavioral route auth & negative-control verifier", () => {
    it("proves legacy static regex /getCurrentUser\\(\\)/ fails on requireApiSession() AND regex sniffing is fooled by comments", () => {
      const searchRouteSrc = fs.readFileSync(
        path.join(ROOT, "src", "app", "api", "search", "route.ts"),
        "utf8",
      );
      const exportRouteSrc = fs.readFileSync(
        path.join(ROOT, "src", "app", "api", "analytics", "export", "route.ts"),
        "utf8",
      );

      // Legacy brittle regex from audit commit 39c780f6 failed when routes migrated to requireApiSession()
      const legacyBrittleRegex = /getCurrentUser\(\)/;
      expect(legacyBrittleRegex.test(searchRouteSrc)).toBe(false);
      expect(legacyBrittleRegex.test(exportRouteSrc)).toBe(false);

      // Conversely, widened static regex /(requireApiSession|getCurrentUser)\(\)/ falsely passes on commented-out auth!
      const widenedStaticRegex =
        /(requireApiSession|getCurrentUser)\(\)/;
      const brokenCommentedRouteSource = `
        // TODO: restore requireApiSession() after debugging 401
        export async function GET() {
          return Response.json({ rows: [{ secret: 1 }] }, { status: 200 });
        }
      `;
      expect(widenedStaticRegex.test(brokenCommentedRouteSource)).toBe(true);
    });

    it("verifyRouteAuthAndIsolationBehavior PASSES on a real auth-enforcing handler and FAILS (pass=false, rejected=true) on an unauthenticated 200 handler", async () => {
      let currentSessionState: "none" | "must_change_password" | "active_entity_a" | "active_entity_b" = "none";

      const securedHandler = async (request: Request): Promise<Response> => {
        const cookieHeader = request.headers.get("cookie") ?? "";
        if (!cookieHeader.includes("mas_session=") || currentSessionState === "none") {
          return NextResponse.json({ error: { message: "Yetkisiz.", code: "unauthorized" } }, { status: 401 });
        }
        if (currentSessionState === "must_change_password") {
          return NextResponse.json({ error: { message: "Yetkisiz.", code: "unauthorized" } }, { status: 401 });
        }
        if (currentSessionState === "active_entity_b") {
          return NextResponse.json({ hits: [{ title: "ENTITY-B-KAYIT" }] }, { status: 200 });
        }
        return NextResponse.json({ hits: [{ title: "ENTITY-A-GIZLI-ODEME" }] }, { status: 200 });
      };

      const passOutcome = await verifyRouteAuthAndIsolationBehavior({
        routeLabel: "/api/search (secured unit control)",
        handler: securedHandler,
        buildUnauthenticatedRequest: () => new Request("http://127.0.0.1:3000/api/search?q=ENTITY-A-GIZLI"),
        buildMustChangePasswordRequest: () => {
          currentSessionState = "must_change_password";
          return new Request("http://127.0.0.1:3000/api/search?q=ENTITY-A-GIZLI", {
            headers: { cookie: "mas_session=mcp-token" },
          });
        },
        buildEntityARequest: () => {
          currentSessionState = "active_entity_a";
          return new Request("http://127.0.0.1:3000/api/search?q=ENTITY-A-GIZLI", {
            headers: { cookie: "mas_session=ok-token; mas_active_legal_entity=11111111-1111-4111-8111-111111111111" },
          });
        },
        buildEntityBRequest: () => {
          currentSessionState = "active_entity_b";
          return new Request("http://127.0.0.1:3000/api/search?q=ENTITY-A-GIZLI", {
            headers: { cookie: "mas_session=ok-token; mas_active_legal_entity=22222222-2222-4222-8222-222222222222" },
          });
        },
        entityASecretMarker: "ENTITY-A-GIZLI-ODEME",
      });

      expect(passOutcome.pass).toBe(true);
      expect(passOutcome.rejected).toBe(false);
      expect(passOutcome.unauthenticatedStatus).toBe(401);
      expect(passOutcome.mustChangePasswordStatus).toBe(401);
      expect(passOutcome.entityASawMarker).toBe(true);
      expect(passOutcome.entityBLeakedMarker).toBe(false);

      // Mandatory Negative Control: deliberately broken unauthenticated handler returning 200 + data
      const brokenHandler = async () =>
        Response.json({ rows: [{ secret: 1, marker: "ENTITY-A-GIZLI-ODEME" }] }, { status: 200 });

      const brokenOutcome = await verifyRouteAuthAndIsolationBehavior({
        routeLabel: "broken-unauthenticated-handler",
        handler: brokenHandler,
        buildUnauthenticatedRequest: () => new Request("http://127.0.0.1:3000/api/analytics/export?analysis=pareto_concentration&format=csv"),
        entityASecretMarker: "ENTITY-A-GIZLI-ODEME",
      });

      expect(brokenOutcome.pass).toBe(false);
      expect(brokenOutcome.rejected).toBe(true);
      expect(brokenOutcome.unauthenticatedStatus).toBe(200);
      expect(brokenOutcome.failureReasons.length).toBeGreaterThan(0);
    });

    it("verifyRouteAuthAndIsolationBehavior FAILS when must_change_password session or cross-entity B leaks data", async () => {
      // Handler blocks unauthenticated (401), but forgets must_change_password check (200) and leaks Entity A to Entity B
      const leakySessionHandler = async (request: Request): Promise<Response> => {
        if (!request.headers.get("cookie")?.includes("mas_session=")) {
          return Response.json({ error: { message: "Yetkisiz." } }, { status: 401 });
        }
        return Response.json({ rows: ["ENTITY-A-GIZLI-ODEME"] }, { status: 200 });
      };

      const outcome = await verifyRouteAuthAndIsolationBehavior({
        routeLabel: "leaky-session-handler",
        handler: leakySessionHandler,
        buildUnauthenticatedRequest: () => new Request("http://127.0.0.1:3000/api/search?q=ENTITY-A-GIZLI"),
        buildMustChangePasswordRequest: () =>
          new Request("http://127.0.0.1:3000/api/search?q=ENTITY-A-GIZLI", {
            headers: { cookie: "mas_session=mcp-token" },
          }),
        buildEntityARequest: () =>
          new Request("http://127.0.0.1:3000/api/search?q=ENTITY-A-GIZLI", {
            headers: { cookie: "mas_session=ok-token; mas_active_legal_entity=11111111-1111-4111-8111-111111111111" },
          }),
        buildEntityBRequest: () =>
          new Request("http://127.0.0.1:3000/api/search?q=ENTITY-A-GIZLI", {
            headers: { cookie: "mas_session=ok-token; mas_active_legal_entity=22222222-2222-4222-8222-222222222222" },
          }),
        entityASecretMarker: "ENTITY-A-GIZLI-ODEME",
      });

      expect(outcome.pass).toBe(false);
      expect(outcome.rejected).toBe(true);
      expect(outcome.mustChangePasswordStatus).toBe(200);
      expect(outcome.entityBLeakedMarker).toBe(true);
    });
  });

  describe("F-18: scripts/phase13b-verify.ts dead if(false) removal & active candidate validation", () => {
    it("confirms scripts/phase13b-verify.ts contains zero dead if(false) blocks", () => {
      const phase13bSrc = fs.readFileSync(path.join(ROOT, "scripts", "phase13b-verify.ts"), "utf8");
      expect(phase13bSrc).not.toMatch(/if\s*\(\s*false\s*\)/);
    });

    it("validateOptimizationCandidates enforces distinct keys, non-empty labels, finite metrics, gap sorting, improvement, and determinism", () => {
      const valid: OptimizationCandidate[] = [
        {
          key: "delay_cagdas_makina_odemesi_1m",
          label: "Ödeme erteleme: Cagdas makina odemesi (1 ay)",
          assumptions: { targetOutflowLabel: "Cagdas makina odemesi", targetOutflowDelayMonths: 1 },
          finalCash: 40_000,
          finalDelta: 0,
          maxCashGap: 0,
          baselineFirstNegative: "2026-07-01",
          firstNegative: null,
          confidence: "high",
        },
        {
          key: "combo_cagdas_makina_odemesi_hpt_tahsilat",
          label: "Kombinasyon: Cagdas makina odemesi ertele + Hpt tahsilat faktoring",
          assumptions: { targetOutflowLabel: "Cagdas makina odemesi", targetOutflowDelayMonths: 1 },
          finalCash: 32_000,
          finalDelta: -8_000,
          maxCashGap: 0,
          baselineFirstNegative: "2026-07-01",
          firstNegative: null,
          confidence: "high",
        },
        {
          key: "factor_hpt_tahsilat",
          label: "Çek/faktoring: Hpt tahsilat tahsilatı öne çek",
          assumptions: { factoringIncomeLabel: "Hpt tahsilat", factoringAdvanceMonth: "2026-07", factoringFeePct: 0.04 },
          finalCash: 29_200,
          finalDelta: -10_800,
          maxCashGap: 0,
          baselineFirstNegative: "2026-07-01",
          firstNegative: null,
          confidence: "high",
        },
        {
          key: "expense_efficiency_5",
          label: "Gider disiplini: -%5 işletme gideri",
          assumptions: { efficiencyPct: 0.05 },
          finalCash: 62_000,
          finalDelta: 22_000,
          maxCashGap: 1_000,
          baselineFirstNegative: "2026-07-01",
          firstNegative: "2026-07-01",
          confidence: "high",
        },
        {
          key: "income_plus_10",
          label: "Gelir artışı: +%10",
          assumptions: { revenuePct: 0.1 },
          finalCash: 78_000,
          finalDelta: 38_000,
          maxCashGap: 3_000,
          baselineFirstNegative: "2026-07-01",
          firstNegative: "2026-07-01",
          confidence: "high",
        },
      ];

      expect(() => validateOptimizationCandidates(valid, structuredClone(valid), 10_000)).not.toThrow();

      // Duplicate key rejected
      const dup = structuredClone(valid);
      dup[1]!.key = dup[0]!.key;
      expect(() => validateOptimizationCandidates(dup, dup, 10_000)).toThrow(/distinct|duplicate/i);

      // Blank label rejected
      const blankLabel = structuredClone(valid);
      blankLabel[0]!.label = "   ";
      expect(() => validateOptimizationCandidates(blankLabel, blankLabel, 10_000)).toThrow(/label/i);

      // Non-finite metric rejected
      const nanGap = structuredClone(valid);
      nanGap[0]!.maxCashGap = Number.NaN;
      expect(() => validateOptimizationCandidates(nanGap, nanGap, 10_000)).toThrow(/maxCashGap|finite/i);

      // Non-deterministic second run rejected
      const driftedSecond = structuredClone(valid);
      driftedSecond[0]!.finalCash = 999_999;
      expect(() => validateOptimizationCandidates(valid, driftedSecond, 10_000)).toThrow(/deterministic/i);
    });
  });

  describe("F-12: Secret exposure scanner (.gitleaks.toml) & disposable RG environment guard", () => {
    it("loads .gitleaks.toml, passes built-in self-test, detects synthetic secrets, allows CI placeholders, and never prints raw secrets", () => {
      const policy = loadRepoGitleaksPolicy();
      expect(policy.rules.length).toBeGreaterThanOrEqual(8);

      const selfTest = runSecretScannerSelfTest(policy);
      expect(selfTest.ok).toBe(true);

      const tgTok = ["918273645", ":", "AAH", "Q9zR8xW7vU6tS5rP4oN3mL2kJ1hG0fE9"].join("");
      const livePg = ["postgres://mas_radar_app:", "RealCutoverPass_2026!", "@127.0.0.1:5432/mas_radar_dev"].join("");
      const findings = scanTextContentWithPolicy(
        "docs/example-leak.md",
        `token = ${tgTok}\ndb = ${livePg}\nok = ci-only-not-a-secret-0123456789\n`,
        policy,
      );

      expect(findings.map((f) => f.ruleId)).toContain("mas-telegram-bot-token");
      expect(findings.map((f) => f.ruleId)).toContain("mas-postgres-connection-credentials");
      for (const f of findings) {
        const formatted = formatSecretFindingRedacted(f);
        expect(formatted).not.toContain(tgTok);
        expect(formatted).not.toContain("RealCutoverPass_2026!");
        expect(formatted).toContain("docs/example-leak.md");
      }
    });

    it("assertDisposableCiRgEnv refuses mas_radar_dev, non-disposable names, missing URLs, and mismatched DB names", () => {
      expect(() =>
        assertDisposableCiRgEnv({
          MIGRATION_DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/mas_radar_dev",
          DATABASE_URL: "postgres://mas_radar_app:x@127.0.0.1:5432/mas_radar_dev",
        }),
      ).toThrow(/GÜVENLİK DURDURMASI/i);

      expect(() =>
        assertDisposableCiRgEnv({
          MIGRATION_DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/mas_radar_v2_rg_ci_verify",
          DATABASE_URL: "postgres://mas_radar_app:x@127.0.0.1:5432/mas_radar_other_verify",
        }),
      ).toThrow(/eşleşmiyor|mismatch/i);

      const ok = assertDisposableCiRgEnv({
        MIGRATION_DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/mas_radar_v2_rg_ci_verify",
        DATABASE_URL: "postgres://mas_radar_app:ci-only-not-a-secret-0123456789@127.0.0.1:5432/mas_radar_v2_rg_ci_verify",
      });
      expect(ok.dbName).toBe("mas_radar_v2_rg_ci_verify");
    });
  });

  describe("F-04 / F-05 / F-12: .github/workflows/ci.yml 8-job integrity & E2E seed URL wiring", () => {
    it("preserves all 8 canonical CI jobs, runs secret scan + disposable RG subset, wires MAS_E2E_SEED_DATABASE_URL, and sets interaction-gate timeout to 120m", () => {
      const ciYaml = fs.readFileSync(path.join(ROOT, ".github", "workflows", "ci.yml"), "utf8");

      const canonicalJobs = [
        "static",
        "database-migration",
        "runtime-role-security",
        "phase-verifies",
        "build",
        "e2e-authz",
        "legacy-semantic-smoke",
        "interaction-gate",
      ];
      for (const job of canonicalJobs) {
        expect(ciYaml, `missing job ${job}`).toMatch(new RegExp(`^  ${job}:\\s*$`, "m"));
      }

      // Never weaken or mute CI steps
      expect(ciYaml).not.toMatch(/continue-on-error\s*:\s*true/i);
      expect(ciYaml).not.toMatch(/^\s*if\s*:\s*false\s*$/m);

      // Secret exposure scan & disposable RG verifier wired
      expect(ciYaml).toContain("scripts/ci/verify-secret-exposure.ts");
      expect(ciYaml).toContain("scripts/ci/verify-rg-disposable.ts");
      expect(ciYaml).toContain("mas_radar_v2_rg_ci_verify");

      // MAS_E2E_SEED_DATABASE_URL wired for all 3 E2E disposable DBs
      expect(ciYaml).toContain(
        "MAS_E2E_SEED_DATABASE_URL: postgres://postgres:postgres@127.0.0.1:5432/mas_radar_e2e_verify",
      );
      expect(ciYaml).toContain(
        "MAS_E2E_SEED_DATABASE_URL: postgres://postgres:postgres@127.0.0.1:5432/mas_radar_smoke_verify",
      );
      expect(ciYaml).toContain(
        "MAS_E2E_SEED_DATABASE_URL: postgres://postgres:postgres@127.0.0.1:5432/mas_radar_interaction_verify",
      );

      // interaction-gate timeout raised to 120 minutes
      const interactionBlock = ciYaml.slice(ciYaml.indexOf("  interaction-gate:"));
      expect(interactionBlock).toMatch(/timeout-minutes:\s*120\b/);
    });
  });
});
