import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { deliverAlerts } from "@/lib/ops/alert-delivery";
import {
  claimAndDispatchOutbox,
  evaluateAndRecordOpsIncidents,
  type OpsIncidentRecord,
} from "@/lib/reminders/outbox";
import { mockTransport, type DeliveryResult, type Transport } from "@/lib/reminders/transport";
import { readEnvLocal } from "../../scripts/db/app-url";
import { SUBPROCESS_TEST_TIMEOUT_MS } from "../setup/test-timeouts";

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

function resolveOwnerUrl(): string {
  let fileEnv: Record<string, string> = {};
  try {
    fileEnv = readEnvLocal();
  } catch {
    // Fallback to process.env when .env.local is absent.
  }
  const ownerUrl =
    process.env.MIGRATION_DATABASE_URL?.trim() ||
    fileEnv.MIGRATION_DATABASE_URL?.trim() ||
    process.env.DATABASE_URL?.trim() ||
    fileEnv.DATABASE_URL?.trim() ||
    "";
  if (!ownerUrl) {
    throw new Error("MIGRATION_DATABASE_URL / DATABASE_URL tanımlı değil.");
  }
  return ownerUrl;
}

describe("Agent 07 — Telemetry, Incident State Machine & Observability", () => {
  let ownerPool: Pool;

  beforeAll(async () => {
    ownerPool = new Pool({
      connectionString: resolveOwnerUrl(),
      max: 1,
      connectionTimeoutMillis: 30_000,
    });
    await ownerPool.query("select 1");
  }, SUBPROCESS_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await ownerPool?.end().catch(() => {});
  });

  it("1. emits initial [OPEN] for P0, P1, AND P2 (latest_import_age_days = 124) and enforces 6h/24h/72h cooldown deduplication", async () => {
    const dir = createTempDir("mas-agent07-cooldown-");
    const stateFilePath = path.join(dir, "ops-incident-state.json");
    const t0 = new Date("2026-11-18T08:00:00.000Z");

    const firingSignals = [
      {
        signal: "reconciliation_mismatch",
        severity: "P0" as const,
        value: "2",
        threshold: "sıfırdan farklı satır sayısı",
      },
      {
        signal: "jobs_stuck",
        severity: "P1" as const,
        value: "3",
        threshold: "> 30 dk 'running'",
      },
      {
        signal: "latest_import_age_days",
        severity: "P2" as const,
        value: "124",
        threshold: "eşik 45 gün",
        note: "TEMİZ.xlsx 124 gün önce içe aktarıldı",
      },
    ];

    // Initial OK -> OPEN emits all three (P0, P1, AND P2)
    const run1 = await evaluateAndRecordOpsIncidents(null, firingSignals, {
      now: t0,
      stateFilePath,
      correlationId: "tel-run-1",
    });
    expect(run1.notifications).toHaveLength(3);
    expect(
      run1.notifications.find((n) => n.signalKey === "reconciliation_mismatch")?.formattedLine,
    ).toContain("[OPEN][P0]");
    expect(run1.notifications.find((n) => n.signalKey === "jobs_stuck")?.formattedLine).toContain(
      "[OPEN][P1]",
    );
    expect(
      run1.notifications.find((n) => n.signalKey === "latest_import_age_days")?.formattedLine,
    ).toContain("[OPEN][P2]");

    // +2 hours: all three inside cooldown (6h P0, 24h P1, 72h P2) -> 0 notifications
    const t2h = new Date(t0.getTime() + 2 * 60 * 60 * 1_000);
    const run2 = await evaluateAndRecordOpsIncidents(null, firingSignals, {
      now: t2h,
      stateFilePath,
      correlationId: "tel-run-2",
    });
    expect(run2.notifications).toHaveLength(0);
    expect(
      run2.records.find((r) => r.signalKey === "latest_import_age_days")?.occurrenceCount,
    ).toBe(2);

    // +6 hours: ONLY P0 cooldown (6h) expires; P1 (24h) & P2 (72h) stay deduplicated
    const t6h = new Date(t0.getTime() + 6 * 60 * 60 * 1_000);
    const run3 = await evaluateAndRecordOpsIncidents(null, firingSignals, {
      now: t6h,
      stateFilePath,
      correlationId: "tel-run-3",
    });
    expect(run3.notifications.map((n) => n.signalKey)).toEqual(["reconciliation_mismatch"]);

    // +24 hours from t0: P0 (+18h since t6h >= 6h) and P1 (24h) notify; P2 (72h) still deduplicated
    const t24h = new Date(t0.getTime() + 24 * 60 * 60 * 1_000);
    const run4 = await evaluateAndRecordOpsIncidents(null, firingSignals, {
      now: t24h,
      stateFilePath,
      correlationId: "tel-run-4",
    });
    expect(run4.notifications.map((n) => n.signalKey)).toEqual([
      "reconciliation_mismatch",
      "jobs_stuck",
    ]);

    // +71 hours from t0: P2 (72h) is STILL inside cooldown -> does NOT re-emit
    const t71h = new Date(t0.getTime() + 71 * 60 * 60 * 1_000);
    const run4b = await evaluateAndRecordOpsIncidents(null, firingSignals, {
      now: t71h,
      stateFilePath,
      correlationId: "tel-run-4b",
    });
    expect(run4b.notifications.some((n) => n.signalKey === "latest_import_age_days")).toBe(false);

    // +72 hours from t0: P2 (72h) cooldown expires and re-notifies [OPEN][P2]
    const t72h = new Date(t0.getTime() + 72 * 60 * 60 * 1_000);
    const run5 = await evaluateAndRecordOpsIncidents(null, firingSignals, {
      now: t72h,
      stateFilePath,
      correlationId: "tel-run-5",
    });
    const p2Reemit = run5.notifications.find((n) => n.signalKey === "latest_import_age_days");
    expect(p2Reemit).toBeDefined();
    expect(p2Reemit!.formattedLine).toContain("[OPEN][P2]");
  });

  it("2. emits intentional transition notifications on severity escalation (P2 -> P1 and P1 -> P0) even inside cooldown", async () => {
    const dir = createTempDir("mas-agent07-escalation-");
    const stateFilePath = path.join(dir, "ops-incident-state.json");
    const t0 = new Date("2026-11-18T09:00:00.000Z");

    const openP2 = await evaluateAndRecordOpsIncidents(
      null,
      [{ signal: "import_failures_24h", severity: "P2", value: "1", note: "1 hata" }],
      { now: t0, stateFilePath, correlationId: "esc-1" },
    );
    expect(openP2.notifications).toHaveLength(1);
    expect(openP2.notifications[0]!.formattedLine).toContain("[OPEN][P2]");

    // +10 minutes (well inside 72h cooldown): escalates P2 -> P1 -> MUST notify
    const t10m = new Date(t0.getTime() + 10 * 60 * 1_000);
    const escP1 = await evaluateAndRecordOpsIncidents(
      null,
      [{ signal: "import_failures_24h", severity: "P1", value: "5", note: "5 hata" }],
      { now: t10m, stateFilePath, correlationId: "esc-2" },
    );
    expect(escP1.notifications).toHaveLength(1);
    expect(escP1.notifications[0]!.severity).toBe("P1");
    expect(escP1.notifications[0]!.formattedLine).toContain("[OPEN][P1]");
    expect(escP1.notifications[0]!.formattedLine).toContain("P2 -> P1");

    // +20 minutes (well inside 24h cooldown): escalates P1 -> P0 -> MUST notify
    const t20m = new Date(t0.getTime() + 20 * 60 * 1_000);
    const escP0 = await evaluateAndRecordOpsIncidents(
      null,
      [{ signal: "import_failures_24h", severity: "P0", value: "25", note: "kritik hata fırtınası" }],
      { now: t20m, stateFilePath, correlationId: "esc-3" },
    );
    expect(escP0.notifications).toHaveLength(1);
    expect(escP0.notifications[0]!.severity).toBe("P0");
    expect(escP0.notifications[0]!.formattedLine).toContain("[OPEN][P0]");
    expect(escP0.notifications[0]!.formattedLine).toContain("P1 -> P0");
  });

  it("3. transitions OPEN + '?' -> UNKNOWN (never RESOLVED) and preserves prior OPEN incidents on blind snapshot runs", async () => {
    const dir = createTempDir("mas-agent07-unknown-");
    const stateFilePath = path.join(dir, "ops-incident-state.json");
    const t0 = new Date("2026-11-18T10:00:00.000Z");

    await evaluateAndRecordOpsIncidents(
      null,
      [
        { signal: "jobs_stuck", severity: "P1", value: "4", threshold: "> 30 dk" },
        { signal: "latest_import_age_days", severity: "P2", value: "124", threshold: "eşik 45 gün" },
      ],
      { now: t0, stateFilePath, correlationId: "unk-0" },
    );

    // Query failure ('?') on jobs_stuck -> UNKNOWN (never RESOLVED), lastSuccessAt stays t0
    const t5m = new Date(t0.getTime() + 5 * 60 * 1_000);
    const unknownRun = await evaluateAndRecordOpsIncidents(
      null,
      [
        { signal: "jobs_stuck", severity: "P1", value: "?", note: "UNKNOWN — DB sorgusu başarısız" },
        { signal: "latest_import_age_days", severity: "P2", value: "124", threshold: "eşik 45 gün" },
      ],
      { now: t5m, stateFilePath, correlationId: "unk-1" },
    );
    const jobsUnknown = unknownRun.records.find((r) => r.signalKey === "jobs_stuck");
    expect(jobsUnknown?.state).toBe("UNKNOWN");
    expect(jobsUnknown?.state).not.toBe("RESOLVED");
    expect(jobsUnknown?.lastCheckedAt).toBe(t5m.toISOString());
    expect(jobsUnknown?.lastSuccessAt).toBe(t0.toISOString());
    expect(unknownRun.notifications).toHaveLength(1);
    expect(unknownRun.notifications[0]!.formattedLine).toContain("[UNKNOWN][P1]");

    // Blind snapshot crash (telemetry_snapshot_unavailable) MUST NOT resolve latest_import_age_days or jobs_stuck
    const t10m = new Date(t0.getTime() + 10 * 60 * 1_000);
    const blindRun = await evaluateAndRecordOpsIncidents(
      null,
      [
        {
          signal: "telemetry_snapshot_unavailable",
          severity: "P0",
          value: "SNAPSHOT_UNAVAILABLE (exit 3)",
          snapshotUnavailable: true,
        },
      ],
      { now: t10m, stateFilePath, correlationId: "watch-blind-1" },
    );

    expect(
      blindRun.records.find((r) => r.signalKey === "latest_import_age_days")?.state,
    ).toBe("OPEN");
    expect(blindRun.records.find((r) => r.signalKey === "jobs_stuck")?.state).toBe("UNKNOWN");
    expect(blindRun.notifications.every((n) => n.nextState !== "RESOLVED")).toBe(true);
  });

  it("4. honors active SUPPRESSED window with zero notifications and resumes [OPEN] once suppressedUntil expires", async () => {
    const dir = createTempDir("mas-agent07-suppressed-");
    const stateFilePath = path.join(dir, "ops-incident-state.json");
    const t0 = new Date("2026-11-18T08:00:00.000Z");

    const seededSuppressed: OpsIncidentRecord = {
      signalKey: "offdevice_backup_status",
      severity: "P1",
      state: "SUPPRESSED",
      lastValue: "TEK KOPYA (exit 3)",
      stateFingerprint: "fp-suppressed",
      note: "harici disk bakımı",
      openedAt: t0.toISOString(),
      acknowledgedAt: null,
      resolvedAt: null,
      suppressedUntil: "2026-11-18T14:00:00.000Z",
      suppressionReason: "Planlı NAS bakımı",
      lastCheckedAt: t0.toISOString(),
      lastSuccessAt: t0.toISOString(),
      resolutionEvidence: null,
      correlationId: "sup-init",
      lastNotifiedAt: null,
      lastNotifiedState: null,
      occurrenceCount: 1,
      updatedAt: t0.toISOString(),
    };
    writeFileSync(
      stateFilePath,
      JSON.stringify(
        { updatedAt: t0.toISOString(), incidents: { offdevice_backup_status: seededSuppressed } },
        null,
        2,
      ),
      "utf8",
    );

    // Active suppression window (12:00Z < 14:00Z) -> state stays SUPPRESSED, 0 notifications
    const duringWindow = await evaluateAndRecordOpsIncidents(
      null,
      [{ signal: "offdevice_backup_status", severity: "P1", value: "TEK KOPYA (exit 3)" }],
      { now: new Date("2026-11-18T12:00:00.000Z"), stateFilePath, correlationId: "sup-active" },
    );
    const activeRec = duringWindow.records.find((r) => r.signalKey === "offdevice_backup_status");
    expect(activeRec?.state).toBe("SUPPRESSED");
    expect(activeRec?.suppressedUntil).toBe("2026-11-18T14:00:00.000Z");
    expect(activeRec?.suppressionReason).toBe("Planlı NAS bakımı");
    expect(activeRec?.occurrenceCount).toBe(2);
    expect(duringWindow.notifications).toHaveLength(0);

    // Expired suppression window (14:05Z > 14:00Z) -> transitions to OPEN and emits [OPEN][P1]
    const afterExpiry = await evaluateAndRecordOpsIncidents(
      null,
      [{ signal: "offdevice_backup_status", severity: "P1", value: "TEK KOPYA (exit 3)" }],
      { now: new Date("2026-11-18T14:05:00.000Z"), stateFilePath, correlationId: "sup-expired" },
    );
    const reopenedRec = afterExpiry.records.find((r) => r.signalKey === "offdevice_backup_status");
    expect(reopenedRec?.state).toBe("OPEN");
    expect(reopenedRec?.suppressedUntil).toBeNull();
    expect(reopenedRec?.suppressionReason).toBeNull();
    expect(afterExpiry.notifications).toHaveLength(1);
    expect(afterExpiry.notifications[0]!.formattedLine).toContain("[OPEN][P1]");
  });

  it("5. populates complete resolutionEvidence and correlationId on OPEN -> RESOLVED via deliverAlerts", async () => {
    const dir = createTempDir("mas-agent07-resolve-");
    const logPath = path.join(dir, "alerts.jsonl");
    const tg = mockTransport({ channel: "telegram" });

    const tOpen = new Date("2026-11-18T08:00:00.000Z");
    const openReport = await deliverAlerts({
      runId: "tel-corr-open-01",
      alerts: [
        {
          signal: "schema_ledger",
          section: "APP",
          value: "115/0115",
          threshold: "beklenen 119/0119",
          severity: "P0",
          message: "schema_ledger = 115/0115 (beklenen 119/0119)",
        },
      ],
      logPath,
      channels: ["log", "telegram"],
      transports: { telegram: tg },
      now: tOpen,
    });
    expect(openReport.allDelivered).toBe(true);
    expect(openReport.incidentNotifications).toHaveLength(1);
    expect(openReport.incidentNotifications![0]!.correlationId).toBe("tel-corr-open-01");

    const tResolved = new Date("2026-11-18T09:15:00.000Z");
    const resolvedReport = await deliverAlerts({
      runId: "tel-corr-resolved-02",
      alerts: [],
      logPath,
      channels: ["log", "telegram"],
      transports: { telegram: tg },
      now: tResolved,
    });
    expect(resolvedReport.allDelivered).toBe(true);
    expect(resolvedReport.incidentNotifications).toHaveLength(1);

    const notif = resolvedReport.incidentNotifications![0]!;
    const rec = resolvedReport.incidentRecords?.find((r) => r.signalKey === "schema_ledger");

    expect(notif.nextState).toBe("RESOLVED");
    expect(notif.correlationId).toBe("tel-corr-resolved-02");
    expect(notif.formattedLine).toContain("[RESOLVED][P0]");
    expect(notif.formattedLine).toContain("telemetry:schema_ledger -> OK");

    expect(rec?.state).toBe("RESOLVED");
    expect(rec?.correlationId).toBe("tel-corr-resolved-02");
    expect(rec?.lastCheckedAt).toBe(tResolved.toISOString());
    expect(rec?.lastSuccessAt).toBe(tResolved.toISOString());
    expect(rec?.resolutionEvidence).toEqual({
      whatChanged: "schema_ledger: 115/0115 -> OK",
      verifiedByCheck: "telemetry:schema_ledger",
      verifiedAtISO: tResolved.toISOString(),
      measuredValue: "OK",
      evidenceSource: "telemetry:tel-corr-resolved-02",
    });
    expect(notif.resolutionEvidence).toEqual(rec?.resolutionEvidence);

    // Persisted JSON fallback also carries resolutionEvidence
    const stateJson = JSON.parse(
      readFileSync(path.join(dir, "ops-incident-state.json"), "utf8"),
    ) as { incidents: Record<string, OpsIncidentRecord> };
    expect(stateJson.incidents.schema_ledger?.resolutionEvidence?.verifiedByCheck).toBe(
      "telemetry:schema_ledger",
    );
  });

  it("6. transitions uncertainOutcome outbox deliveries to 'delivery_uncertain' without immediate blind retry and honors retryAfterSeconds", async () => {
    const executedUpdates: Array<{ sql: string; params: unknown[] }> = [];
    const claimedRows = [
      {
        id: "outbox-uncertain-row",
        stream: "ops_incident",
        channel: "telegram",
        recipient_target: "-1001111111",
        idempotency_key: "idem-unc-07",
        subject: null,
        body_text: "Kritik P0 Uyarısı",
        body_format: "plain",
        metadata: {},
        claim_token: "11111111-1111-4111-8111-111111111111",
        attempt_count: 0,
        max_attempts: 5,
      },
      {
        id: "outbox-429-row",
        stream: "ops_incident",
        channel: "email",
        recipient_target: "ops@mas.local",
        idempotency_key: "idem-429-07",
        subject: "Uyarı",
        body_text: "Rate limited test",
        body_format: "plain",
        metadata: {},
        claim_token: "22222222-2222-4222-8222-222222222222",
        attempt_count: 0,
        max_attempts: 5,
      },
    ];

    const mockPool = {
      async connect() {
        return {
          async query(sql: string) {
            if (sql.toLowerCase().includes("returning")) {
              return { rows: claimedRows, rowCount: claimedRows.length };
            }
            return { rows: [], rowCount: 0 };
          },
          release() {},
        };
      },
      async query(sql: string, params: unknown[] = []) {
        executedUpdates.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
        return { rows: [{ id: params[0] }], rowCount: 1 };
      },
    } as unknown as Pool;

    const summary = await claimAndDispatchOutbox(mockPool, {
      transportResolver: (ch): Transport => ({
        channel: ch,
        async send(): Promise<DeliveryResult> {
          if (ch === "telegram") {
            return {
              ok: false,
              error: "TimeoutError after socket write",
              uncertainOutcome: true,
            } as DeliveryResult;
          }
          return {
            ok: false,
            error: "HTTP 429 Too Many Requests",
            retryAfterSeconds: 95,
          } as DeliveryResult;
        },
      }),
    });

    expect(summary).toEqual({
      claimed: 2,
      sent: 0,
      retried: 1,
      deadLettered: 0,
      skipped: 0,
      uncertain: 1,
    });

    expect(executedUpdates[0]!.sql.toLowerCase()).toContain("set status = 'delivery_uncertain'");
    expect(executedUpdates[0]!.params[0]).toBe("outbox-uncertain-row");
    expect(executedUpdates[0]!.params[1]).toBe("11111111-1111-4111-8111-111111111111");

    // Second row (429 retryAfterSeconds = 95 > default 30s backoff) uses 95s
    expect(executedUpdates[1]!.params[2]).toBe("failed_retryable");
    expect(executedUpdates[1]!.params[4]).toBe(95);
  });

  it("7. persists full incident lifecycle (OPEN -> SUPPRESSED -> RESOLVED with resolution_evidence & correlation_id) to live PostgreSQL public.ops_incidents", async () => {
    const dir = createTempDir("mas-agent07-pg-");
    const logPath = path.join(dir, "alerts.jsonl");
    const testSignalKey = `test_remediation_sig_${randomUUID().slice(0, 8)}`;

    const preExistingActive = await ownerPool.query<{
      signal_key: string;
      severity: "P0" | "P1" | "P2";
      state: string;
      last_value: string;
      note: string;
    }>(
      `select signal_key, severity, state, last_value, note
         from public.ops_incidents
        where signal_key <> $1
          and state in ('OPEN', 'ACKNOWLEDGED', 'UNKNOWN')`,
      [testSignalKey],
    );
    const passthroughAlerts = preExistingActive.rows.map((r) => ({
      signal: r.signal_key,
      section: "APP",
      value: r.state === "UNKNOWN" ? "?" : r.last_value,
      threshold: r.note,
      severity: r.severity,
      message: `${r.signal_key} = ${r.last_value}`,
    }));

    const beforeCountRes = await ownerPool.query<{ n: number }>(
      "select count(*)::int as n from public.ops_incidents",
    );
    const beforeCount = beforeCountRes.rows[0]?.n ?? 0;

    try {
      const tOpen = new Date("2026-11-18T11:00:00.000Z");
      await deliverAlerts({
        runId: "pg-corr-open-07",
        alerts: [
          ...passthroughAlerts,
          {
            signal: testSignalKey,
            section: "APP",
            value: "124",
            threshold: "eşik 45 gün",
            severity: "P2",
            message: `${testSignalKey} = 124`,
          },
        ],
        logPath,
        channels: ["log"],
        pool: ownerPool,
        now: tOpen,
      });

      const dbOpen = await ownerPool.query<{
        state: string;
        severity: string;
        last_value: string;
        correlation_id: string | null;
        has_checked_at: boolean;
        has_success_at: boolean;
      }>(
        `select state,
                severity,
                last_value,
                correlation_id,
                (last_checked_at is not null) as has_checked_at,
                (last_success_at is not null) as has_success_at
           from public.ops_incidents
          where signal_key = $1`,
        [testSignalKey],
      );
      expect(dbOpen.rowCount).toBe(1);
      expect(dbOpen.rows[0]).toEqual({
        state: "OPEN",
        severity: "P2",
        last_value: "124",
        correlation_id: "pg-corr-open-07",
        has_checked_at: true,
        has_success_at: true,
      });

      // Mark SUPPRESSED in DB and verify active suppression window silences notifications in PostgreSQL
      await ownerPool.query(
        `update public.ops_incidents
            set state = 'SUPPRESSED',
                suppressed_until = '2026-11-18T12:00:00.000Z',
                suppression_reason = 'Planlı veri aktarımı'
          where signal_key = $1`,
        [testSignalKey],
      );

      const supReport = await deliverAlerts({
        runId: "pg-corr-suppressed-07",
        alerts: [
          ...passthroughAlerts,
          {
            signal: testSignalKey,
            section: "APP",
            value: "124",
            threshold: "eşik 45 gün",
            severity: "P2",
            message: `${testSignalKey} = 124`,
          },
        ],
        logPath,
        channels: ["log"],
        pool: ownerPool,
        now: new Date("2026-11-18T11:30:00.000Z"),
      });
      expect(
        supReport.incidentNotifications?.filter((n) => n.signalKey === testSignalKey) ?? [],
      ).toHaveLength(0);

      // After suppression window expires (12:30Z > 12:00Z) AND signal clears -> RESOLVED in PostgreSQL
      const tResolved = new Date("2026-11-18T12:30:00.000Z");
      await deliverAlerts({
        runId: "pg-corr-resolved-07",
        alerts: passthroughAlerts,
        logPath,
        channels: ["log"],
        pool: ownerPool,
        now: tResolved,
      });

      const dbResolved = await ownerPool.query<{
        state: string;
        correlation_id: string | null;
        suppressed_until: Date | null;
        resolution_evidence: Record<string, unknown> | null;
      }>(
        `select state, correlation_id, suppressed_until, resolution_evidence
           from public.ops_incidents
          where signal_key = $1`,
        [testSignalKey],
      );
      expect(dbResolved.rowCount).toBe(1);
      expect(dbResolved.rows[0]?.state).toBe("RESOLVED");
      expect(dbResolved.rows[0]?.suppressed_until).toBeNull();
      expect(dbResolved.rows[0]?.correlation_id).toBe("pg-corr-resolved-07");
      expect(dbResolved.rows[0]?.resolution_evidence).toEqual({
        whatChanged: `${testSignalKey}: 124 -> OK`,
        verifiedByCheck: `telemetry:${testSignalKey}`,
        verifiedAtISO: tResolved.toISOString(),
        measuredValue: "OK",
        evidenceSource: "telemetry:pg-corr-resolved-07",
      });
    } finally {
      await ownerPool.query("delete from public.ops_incidents where signal_key = $1", [
        testSignalKey,
      ]);
    }

    const afterCountRes = await ownerPool.query<{ n: number }>(
      "select count(*)::int as n from public.ops_incidents",
    );
    expect(afterCountRes.rows[0]?.n ?? 0).toBe(beforeCount);
  }, SUBPROCESS_TEST_TIMEOUT_MS);

  it("8. ensures empty/pending/failed source_workbooks NEVER reset latest_import_age_days while valid parsed/mapped workbooks with import_rows do", async () => {
    const client = await ownerPool.connect();
    try {
      await client.query("BEGIN");

      const baselineRes = await client.query<{ age_days: string }>(
        `select coalesce(round(extract(epoch from (now() - max(imported_at))) / 86400)::text, 'İÇE AKTARIM YOK') as age_days
           from public.valid_workbook_imports`,
      );
      const baselineAge = Number(baselineRes.rows[0]?.age_days ?? "0");
      expect(baselineAge).toBeGreaterThan(45);

      // Insert fresh 'pending', 'failed', and empty 'parsed' (0 import_rows) workbooks -> age MUST NOT reset to 0
      await client.query(
        `insert into public.source_workbooks (original_filename, status, imported_at)
         values ('agent07-pending.xlsx', 'pending', now()),
                ('agent07-failed.xlsx', 'failed', now()),
                ('agent07-empty-parsed.xlsx', 'parsed', now())`,
      );

      const afterInvalidRes = await client.query<{ age_days: string }>(
        `select coalesce(round(extract(epoch from (now() - max(imported_at))) / 86400)::text, 'İÇE AKTARIM YOK') as age_days
           from public.valid_workbook_imports`,
      );
      expect(Number(afterInvalidRes.rows[0]?.age_days)).toBe(baselineAge);

      // Insert a valid 'parsed' workbook WITH >= 1 import_rows -> age resets to 0
      const validWb = await client.query<{ id: string }>(
        `insert into public.source_workbooks (original_filename, status, imported_at)
         values ('agent07-valid-parsed.xlsx', 'parsed', now())
         returning id`,
      );
      const validSheet = await client.query<{ id: string }>(
        `insert into public.source_sheets (workbook_id, sheet_name, sheet_index)
         values ($1, 'Sheet1', 0)
         returning id`,
        [validWb.rows[0]!.id],
      );
      await client.query(
        `insert into public.import_rows (workbook_id, sheet_id, row_index, row_json)
         values ($1, $2, 1, '{"A":"valid"}'::jsonb)`,
        [validWb.rows[0]!.id, validSheet.rows[0]!.id],
      );

      const afterValidRes = await client.query<{ age_days: string }>(
        `select coalesce(round(extract(epoch from (now() - max(imported_at))) / 86400)::text, 'İÇE AKTARIM YOK') as age_days
           from public.valid_workbook_imports`,
      );
      expect(afterValidRes.rows[0]?.age_days).toBe("0");
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  }, SUBPROCESS_TEST_TIMEOUT_MS);
});
