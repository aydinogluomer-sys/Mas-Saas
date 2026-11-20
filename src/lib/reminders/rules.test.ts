import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Pool, PoolClient } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deliverAlerts } from "@/lib/ops/alert-delivery";
import { dispatchPending, eligibleMaturityDeliveries } from "./engine";
import {
  claimAndDispatchOutbox,
  computeNotificationIdempotencyKey,
  evaluateAndRecordOpsIncidents,
} from "./outbox";
import {
  CHRONIC_HISTORICAL_OVERDUE_DAYS,
  ESCALATION_BUCKET_LABELS,
  bucketToCanonicalStage,
  buildReminderDigestHtml,
  buildReminderMessage,
  classifyEscalationBucket,
  containsUnsubstantiatedLegalClaim,
  daysOverdue,
  eligibleDeliveries,
  evaluateEscalationDecision,
  formatRiskReasonTr,
  formatStatusLabelTr,
  isChronicHistoricalOverdue,
  isEligible,
  isOpenObligationStatus,
  matchesReminderOffset,
  resolveReminderAmounts,
  sanitizeReminderLegalWording,
  scheduledForDate,
  stageForOverdueDays,
  thresholdPasses,
  type ReminderRule,
  type ReminderTarget,
} from "./rules";
import { istanbulDateISO } from "@/lib/time/istanbul";
import {
  buildFolioEmailHtml,
  escapeTelegramHtml,
  mockTransport,
  scrubSensitiveTelegramText,
  sendTelegramChatMessage,
  splitTelegramHtmlMessage,
} from "./transport";

const rule = (over: Partial<ReminderRule>): ReminderRule => ({
  id: "r",
  name: "test",
  targetKind: "payment_instance",
  offsetDays: 3,
  channel: "telegram",
  minAmount: null,
  isActive: true,
  ...over,
});

const target = (over: Partial<ReminderTarget>): ReminderTarget => ({
  entityTable: "payment_instances",
  entityId: "11111111-1111-4111-8111-111111111111",
  name: "KİRA",
  dueDate: "2026-07-10",
  amount: 35000,
  status: "unpaid",
  owner: "MAS",
  provider: "Halk",
  riskReasons: [],
  ...over,
});

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("scheduledForDate", () => {
  it("offset N fires N days before due; -1 fires day after due (overdue)", () => {
    expect(scheduledForDate("2026-07-10", 7)).toBe("2026-07-03");
    expect(scheduledForDate("2026-07-10", 3)).toBe("2026-07-07");
    expect(scheduledForDate("2026-07-10", 1)).toBe("2026-07-09");
    expect(scheduledForDate("2026-07-10", 0)).toBe("2026-07-10");
    expect(scheduledForDate("2026-07-10", -1)).toBe("2026-07-11");
  });
});

describe("thresholdPasses (null never excluded — unknown could be large)", () => {
  it("no threshold → always passes", () => expect(thresholdPasses(null, 10)).toBe(true));
  it("known below threshold → filtered", () => expect(thresholdPasses(50000, 35000)).toBe(false));
  it("known at/above → passes", () => expect(thresholdPasses(50000, 50000)).toBe(true));
  it("unknown amount with threshold → still passes", () => expect(thresholdPasses(50000, null)).toBe(true));
});

describe("isEligible & disjoint overdue buckets (5.A)", () => {
  const today = "2026-07-07"; // 3 days before due 2026-07-10

  it("fires when scheduled date matches today, status open, rule active", () => {
    expect(isEligible(rule({ offsetDays: 3 }), target({}), today)).toBe(true);
  });

  it("wrong offset → not today → skip", () => {
    expect(isEligible(rule({ offsetDays: 7 }), target({}), today)).toBe(false);
  });

  it("paid/cancelled → skip (only unpaid/partial/planned/late)", () => {
    expect(isEligible(rule({}), target({ status: "paid" }), today)).toBe(false);
    expect(isEligible(rule({}), target({ status: "partial" }), today)).toBe(true);
  });

  it("inactive rule → skip", () => {
    expect(isEligible(rule({ isActive: false }), target({}), today)).toBe(false);
  });

  it("known amount below min_amount → skip; unknown amount → still eligible", () => {
    expect(isEligible(rule({ minAmount: 50000 }), target({ amount: 35000 }), today)).toBe(false);
    expect(isEligible(rule({ minAmount: 50000 }), target({ amount: null }), today)).toBe(true);
  });

  it("target_kind mismatch → skip", () => {
    expect(isEligible(rule({ targetKind: "check" }), target({}), today)).toBe(false);
  });

  it("disjoint overdue buckets: 4d matches -1 only; 14d matches -8 and NOT -1; 163d matches -31 and NOT -1 or -8", () => {
    const r1 = rule({ id: "r-1", offsetDays: -1, targetKind: "invoice" });
    const r8 = rule({ id: "r-8", offsetDays: -8, targetKind: "invoice" });
    const r31 = rule({ id: "r-31", offsetDays: -31, targetKind: "invoice" });
    const customNeg5 = rule({ id: "r-5", offsetDays: -5, targetKind: "invoice" });

    const inv = target({
      entityTable: "invoices",
      dueDate: "2026-07-01",
      status: "open",
    });

    // Due day itself (0d overdue) -> none of the overdue rules fire
    expect(isEligible(r1, inv, "2026-07-01")).toBe(false);
    expect(isEligible(r8, inv, "2026-07-01")).toBe(false);
    expect(isEligible(r31, inv, "2026-07-01")).toBe(false);

    // 4d overdue -> matches -1 ONLY
    expect(isEligible(r1, inv, "2026-07-05")).toBe(true);
    expect(isEligible(r8, inv, "2026-07-05")).toBe(false);
    expect(isEligible(r31, inv, "2026-07-05")).toBe(false);
    expect(isEligible(customNeg5, inv, "2026-07-05")).toBe(false);
    expect(isEligible(customNeg5, inv, "2026-07-06")).toBe(true);

    // 14d overdue -> matches -8 ONLY (NOT -1, NOT -31)
    expect(isEligible(r1, inv, "2026-07-15")).toBe(false);
    expect(isEligible(r8, inv, "2026-07-15")).toBe(true);
    expect(isEligible(r31, inv, "2026-07-15")).toBe(false);

    // 163d overdue (2026-06-07 evaluated on 2026-11-17) -> matches -31 ONLY (NOT -1, NOT -8)
    const oldInv = target({
      entityTable: "invoices",
      dueDate: "2026-06-07",
      status: "open",
    });
    expect(isEligible(r1, oldInv, "2026-11-17")).toBe(false);
    expect(isEligible(r8, oldInv, "2026-11-17")).toBe(false);
    expect(isEligible(r31, oldInv, "2026-11-17")).toBe(true);

    // eligibleMaturityDeliveries uses the exact same disjoint rule for checks & loan_installments
    const checkRules = [
      rule({ id: "c-1", targetKind: "check", offsetDays: -1 }),
      rule({ id: "c-8", targetKind: "check", offsetDays: -8 }),
      rule({ id: "c-31", targetKind: "check", offsetDays: -31 }),
    ];
    const check165 = target({
      entityTable: "checks",
      entityId: "22222222-2222-4222-8222-222222222222",
      dueDate: "2026-06-05",
      status: "in_portfolio",
    });
    const matOut = eligibleMaturityDeliveries(checkRules, [check165], "2026-11-17");
    expect(matOut).toHaveLength(1);
    expect(matOut[0].ruleId).toBe("c-31");
    expect(matchesReminderOffset(-1, "2026-06-05", "2026-11-17")).toBe(false);
  });

  it("M-59: supports covenant_record targetKind", () => {
    const covRule = rule({ offsetDays: 7, targetKind: "covenant_record" });
    const covTarget = target({
      entityTable: "covenant_records",
      dueDate: "2026-07-14",
      status: "compliant",
      amount: null,
    });
    expect(isEligible(covRule, covTarget, "2026-07-07")).toBe(true);
  });
});

describe("classifyEscalationBucket (M-59 tiered overdue escalation)", () => {
  it("classifies upcoming, 1-7d, 8-30d, and 30+d buckets accurately", () => {
    expect(classifyEscalationBucket("2026-07-15", "2026-07-10")).toBe("upcoming");
    expect(classifyEscalationBucket("2026-07-10", "2026-07-10")).toBe("upcoming");
    expect(classifyEscalationBucket("2026-07-05", "2026-07-10")).toBe("overdue_1_7");
    expect(classifyEscalationBucket("2026-06-25", "2026-07-10")).toBe("overdue_8_30");
    expect(classifyEscalationBucket("2026-05-15", "2026-07-10")).toBe("overdue_30_plus");
  });
});

describe("eligibleDeliveries (rule × target cross)", () => {
  const today = "2026-07-09"; // 1 day before due
  const rules = [rule({ id: "r1", offsetDays: 1 }), rule({ id: "r7", offsetDays: 7 })];
  const targets = [
    target({ entityId: "a", dueDate: "2026-07-10" }),
    target({ entityId: "b", dueDate: "2026-07-16", status: "paid" }),
  ];
  const out = eligibleDeliveries(rules, targets, today);
  it("emits only the firing, open pairs with today as scheduledFor", () => {
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ ruleId: "r1", entityId: "a", scheduledFor: today });
    expect(out[0].message).toContain("Yarın ödeme");
  });
});

describe("buildReminderMessage, Turkish domain labels & digest HTML (5.A)", () => {
  it("translates all English snake_case statuses and risk reasons into Turkish", () => {
    expect(formatStatusLabelTr("unpaid")).toBe("Ödenmedi");
    expect(formatStatusLabelTr("planned")).toBe("Planlandı");
    expect(formatStatusLabelTr("partial")).toBe("Kısmi ödendi");
    expect(formatStatusLabelTr("late")).toBe("Gecikmiş");
    expect(formatStatusLabelTr("open")).toBe("Açık");
    expect(formatStatusLabelTr("pending")).toBe("Bekliyor");
    expect(formatStatusLabelTr("in_portfolio")).toBe("Portföyde");
    expect(formatStatusLabelTr("issued_to_vendor")).toBe("Tedarikçiye verildi");
    expect(formatStatusLabelTr("endorsed_to_vendor")).toBe("Ciro edildi");
    expect(formatStatusLabelTr("in_bank_collection")).toBe("Banka tahsilde");

    expect(formatRiskReasonTr("missing_amount")).toBe("Tutar eksik");
    expect(formatRiskReasonTr("overdue")).toBe("Vadesi geçmiş");
    expect(formatRiskReasonTr("critical_payment")).toBe("Kritik ödeme");
    expect(formatRiskReasonTr("large_payment")).toBe("Yüksek tutarlı ödeme");
    expect(formatRiskReasonTr("same_day_cluster")).toBe("Aynı gün yığılması");
    expect(formatRiskReasonTr("negative_amount")).toBe("Negatif tutar");
    expect(formatRiskReasonTr("overpaid")).toBe("Fazla ödeme");
    expect(formatRiskReasonTr("kovenant_ihlali")).toBe("Kovenant ihlali");

    const m = buildReminderMessage(
      rule({ offsetDays: 0 }),
      target({
        amount: 190000,
        riskReasons: ["critical_payment", "missing_amount", "same_day_cluster"],
        status: "unpaid",
      }),
    );
    expect(m).toContain("Bugün ödeme");
    expect(m).toContain("KİRA · 2026-07-10");
    expect(m).toContain("190.000 TL");
    expect(m).toContain("durum: Ödenmedi");
    expect(m).toContain("sahip: MAS");
    expect(m).toContain("sağlayıcı: Halk");
    expect(m).toContain("risk: Kritik ödeme, Tutar eksik, Aynı gün yığılması");
    expect(m).not.toContain("unpaid");
    expect(m).not.toContain("missing_amount");
    expect(m).not.toContain("critical_payment");
  });

  it("derives BOTH header and kademe from classifyEscalationBucket so 165d overdue NEVER prints 1-7 Gün header", () => {
    const m = buildReminderMessage(
      rule({ offsetDays: -1 }),
      target({
        dueDate: "2026-06-05",
        status: "unpaid",
        riskReasons: ["overdue"],
      }),
      "2026-11-17",
    );
    expect(m).toContain("⚖ 31+ Gün Üst Eskalasyon (İç İnceleme) kademesi");
    expect(m).toContain("kademe: 31+ Gün Üst Eskalasyon (İç İnceleme) (165 gün)");
    expect(m).not.toContain("30+ Gün");
    expect(m).not.toContain("Hukuki Eskalasyon");
    expect(m).not.toContain("1-7 Gün Gecikmiş");
    expect(m).not.toContain("unpaid");
  });

  it("null amount → 'tutar eksik', never 0; supports masked mode and consolidated digest HTML", () => {
    const m = buildReminderMessage(
      rule({}),
      target({ name: "Akon Endüstri Metal", amount: null, owner: "Akon Holding" }),
      "2026-07-07",
      { masked: true },
    );
    expect(m).toContain("tutar: tutar eksik");
    expect(m).not.toMatch(/tutar: 0/);
    expect(m).not.toContain("Akon Endüstri Metal");
    expect(m).toContain("A***");

    const digest = buildReminderDigestHtml(
      [
        {
          name: "Akon Çelik <A.Ş.>",
          dueDate: "2026-06-05",
          amount: 120000,
          status: "unpaid",
        },
        {
          name: "Belirsiz Kalem",
          dueDate: "2026-11-10",
          amount: null,
          status: "in_portfolio",
        },
      ],
      "2026-11-17",
    );
    expect(digest).toContain("<b>MAS Nakit Radar — Toplu Hatırlatma Özeti (2026-11-17)</b>");
    expect(digest).toContain("Akon Çelik &lt;A.Ş.&gt;");
    expect(digest).toContain("tutar: tutar eksik");
    expect(digest).toContain("durum: Ödenmedi");
    expect(digest).toContain("durum: Portföyde");
    expect(digest).not.toContain("unpaid");
    expect(digest).not.toContain("in_portfolio");
  });
});

describe("Telegram HTML single-pass escaping, IBAN scrubbing, allowlist & Folio email Markdown (5.E)", () => {
  it("escapeTelegramHtml escapes &, <, > in a single pass and NEVER produces &#91; or \\_", () => {
    const raw = "[OPEN][P0] schema_ledger = 121/0121 & <alert>";
    const escaped = escapeTelegramHtml(raw);
    expect(escaped).toBe("[OPEN][P0] schema_ledger = 121/0121 &amp; &lt;alert&gt;");
    expect(escaped).not.toContain("&#91;");
    expect(escaped).not.toContain("\\_");
  });

  it("scrubSensitiveTelegramText masks raw Turkish IBANs and bot tokens", () => {
    const raw = "Ödeme IBAN: TR33 0006 1005 1978 6457 8413 26 ve bitişik TR120006200000012345678998";
    const scrubbed = scrubSensitiveTelegramText(raw);
    expect(scrubbed).toContain("TR** **** **** **** **** **26");
    expect(scrubbed).toContain("TR** **** **** **** **** **98");
    expect(scrubbed).not.toContain("1978 6457");
    expect(scrubbed).not.toContain("000123456789");
  });

  it("splitTelegramHtmlMessage balances open tags across <= 3900-char chunks without slicing inside <...>", () => {
    const body = `<b>Başlık ve Özet</b>\n<code>${"satır_verisi_1234567890 ".repeat(240)}</code>`;
    const chunks = splitTelegramHtmlMessage(body, 3900);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(3900);
      const opens = (chunk.match(/<code>/g) ?? []).length;
      const closes = (chunk.match(/<\/code>/g) ?? []).length;
      expect(opens).toBe(closes);
    }
  });

  it("sendTelegramChatMessage enforces chat allowlist and passes parse_mode: HTML", async () => {
    const sentPayloads: Array<Record<string, unknown>> = [];
    const fakeFetch: typeof fetch = (async (_url, init) => {
      sentPayloads.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    const blocked = await sendTelegramChatMessage("999999", "<b>Gizli</b>", {
      token: "111:TEST",
      allowedChatIds: "777888",
      parseMode: "HTML",
      fetchImpl: fakeFetch,
    });
    expect(blocked.ok).toBe(false);
    expect(sentPayloads).toHaveLength(0);

    const allowed = await sendTelegramChatMessage(
      "777888",
      "<b>IBAN:</b> TR33 0006 1005 1978 6457 8413 26",
      {
        token: "111:TEST",
        allowedChatIds: "777888",
        parseMode: "HTML",
        fetchImpl: fakeFetch,
      },
    );
    expect(allowed.ok).toBe(true);
    expect(sentPayloads).toHaveLength(1);
    expect(sentPayloads[0].parse_mode).toBe("HTML");
    expect(String(sentPayloads[0].text)).toContain("TR** **** **** **** **** **26");
  });

  it("buildFolioEmailHtml strips Markdown # headings and converts **bold** without raw ## or **", () => {
    const html = buildFolioEmailHtml({
      title: "# CFO Sabah Brifingi",
      bodyText: "## Nakit Özeti\n\n- **Tutarı bilinmeyen: 2 kalem** (<script>alert(1)</script>)",
    });
    expect(html).not.toContain("## Nakit");
    expect(html).not.toContain("**Tutarı");
    expect(html).toContain("<strong>Tutarı bilinmeyen: 2 kalem</strong>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});

describe("Outbox idempotency key & Stateful Ops Incident State Machine (5.B & 5.D)", () => {
  it("computeNotificationIdempotencyKey produces deterministic 64-char SHA-256 hex", () => {
    const k1 = computeNotificationIdempotencyKey(["telegram", "invoices", "id-1", "overdue_8_30", "2026-11-17"]);
    const k2 = computeNotificationIdempotencyKey(["telegram", "invoices", "id-1", "overdue_8_30", "2026-11-17"]);
    const k3 = computeNotificationIdempotencyKey(["telegram", "invoices", "id-1", "overdue_30_plus", "2026-11-17"]);
    expect(k1).toHaveLength(64);
    expect(k1).toBe(k2);
    expect(k1).not.toBe(k3);
  });

  it("tracks OPEN -> cooldown suppression -> RESOLVED with duration, and maps '?' / blind snapshot to UNKNOWN", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "mas-incident-sm-"));
    tempDirs.push(dir);
    const logPath = path.join(dir, "alerts.jsonl");
    const statePath = path.join(dir, "ops-incident-state.json");
    const tg = mockTransport({ channel: "telegram" });

    const t0 = new Date("2026-11-17T08:00:00Z");
    const t5m = new Date("2026-11-17T08:05:00Z");
    const t20m = new Date("2026-11-17T08:20:00Z");

    // 1. P0 & P2 signals emit initial [OPEN] + '?' query failure mapped to UNKNOWN
    await deliverAlerts({
      runId: "r1",
      now: t0,
      logPath,
      incidentStatePath: statePath,
      channels: ["log", "telegram"],
      transports: { telegram: tg },
      alerts: [
        {
          signal: "runtime_user",
          section: "APP",
          value: "postgres",
          threshold: "mas_radar_app olmalı",
          severity: "P0",
          message: "runtime_user = postgres",
        },
        {
          signal: "reconciliation_mismatch",
          section: "APP",
          value: "?",
          threshold: "sıfırdan farklı satır",
          severity: "P0",
          message: "reconciliation_mismatch = ?",
        },
        {
          signal: "latest_import_age_days",
          section: "APP",
          value: "50",
          threshold: "eşik 45 gün",
          severity: "P2",
          message: "latest_import_age_days = 50",
        },
      ],
    });

    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0]).toContain("[OPEN][P0] runtime_user = postgres");
    expect(tg.sent[0]).toContain("[UNKNOWN][P0] reconciliation_mismatch = ?");
    expect(tg.sent[0]).not.toContain("[OPEN][P0] reconciliation_mismatch = ?");
    expect(tg.sent[0]).toContain("[OPEN][P2] latest_import_age_days = 50");
    expect(tg.sent[0]).not.toContain("&#91;");
    expect(tg.sent[0]).not.toContain("\\_");

    // 2. 5 minutes later (within 6h P0 / 72h P2 cooldown): duplicate repeat spam is suppressed!
    await deliverAlerts({
      runId: "r2",
      now: t5m,
      logPath,
      incidentStatePath: statePath,
      channels: ["log", "telegram"],
      transports: { telegram: tg },
      alerts: [
        {
          signal: "runtime_user",
          section: "APP",
          value: "postgres",
          threshold: "mas_radar_app olmalı",
          severity: "P0",
          message: "runtime_user = postgres",
        },
        {
          signal: "reconciliation_mismatch",
          section: "APP",
          value: "?",
          threshold: "sıfırdan farklı satır",
          severity: "P0",
          message: "reconciliation_mismatch = ?",
        },
        {
          signal: "latest_import_age_days",
          section: "APP",
          value: "50",
          threshold: "eşik 45 gün",
          severity: "P2",
          message: "latest_import_age_days = 50",
        },
      ],
    });
    expect(tg.sent).toHaveLength(1);

    // 3. 20 minutes later: signals recover -> explicit [RESOLVED] notification emitted with duration!
    await deliverAlerts({
      runId: "r3",
      now: t20m,
      logPath,
      incidentStatePath: statePath,
      channels: ["log", "telegram"],
      transports: { telegram: tg },
      alerts: [],
    });
    expect(tg.sent).toHaveLength(2);
    expect(tg.sent[1]).toContain("[RESOLVED][P0] runtime_user normale döndü (süre: 20dk · doğrulama: telemetry:runtime_user -> OK)");
    expect(tg.sent[1]).toContain("[RESOLVED][P0] reconciliation_mismatch normale döndü (süre: 20dk · doğrulama: telemetry:reconciliation_mismatch -> OK)");
    expect(tg.sent[1]).toContain("[RESOLVED][P2] latest_import_age_days normale döndü (süre: 20dk · doğrulama: telemetry:latest_import_age_days -> OK)");

    // 4. Subsequent healthy run does NOT re-send [RESOLVED]
    const directEval = await evaluateAndRecordOpsIncidents(null, [], {
      now: new Date("2026-11-17T08:25:00Z"),
      stateFilePath: statePath,
    });
    expect(directEval.notifications).toHaveLength(0);
  });

  it("claimAndDispatchOutbox asserts rowCount === 1 on claim_token and transitions retry -> dead_letter", async () => {
    let simulateClaimStolen = false;
    const rows = [
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
        stream: "ops_incident" as const,
        channel: "telegram" as const,
        recipient_target: "default:telegram",
        idempotency_key: "k-1",
        subject: null,
        body_text: "[OPEN][P1] test",
        body_format: "plain" as const,
        metadata: {},
        claim_token: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
        attempt_count: 4,
        max_attempts: 5,
      },
    ];

    let capturedDeadLetterStatus: string | null = null;
    const query = vi.fn(async (sqlRaw: string, params: unknown[] = []) => {
      const sql = sqlRaw.replace(/\s+/g, " ").trim().toLowerCase();
      if (sql === "begin" || sql === "commit" || sql === "rollback") {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("where status = 'claiming'") && !sql.includes("claim_token = $2::uuid")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("for update skip locked")) {
        return { rows, rowCount: rows.length };
      }
      if (sql.includes("where id = $1 and status = 'claiming' and claim_token = $2::uuid")) {
        return { rows: [], rowCount: simulateClaimStolen ? 0 : 1 };
      }
      if (sql.includes("where id = $1 and claim_token = $2::uuid")) {
        if (simulateClaimStolen) return { rows: [], rowCount: 0 };
        if (params.length >= 3 && typeof params[2] === "string" && !params[2].startsWith("{")) {
          capturedDeadLetterStatus = params[2];
        }
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("where idempotency_key = $1 and status = 'claiming' and claim_token is null")) {
        return { rows: [], rowCount: 0 };
      }
      throw new Error(`Unexpected outbox SQL: ${sql}`);
    });

    const fakeClient = { query, release: vi.fn() } as unknown as PoolClient;
    const fakePool = { query, connect: vi.fn(async () => fakeClient) } as unknown as Pool;

    const failSummary = await claimAndDispatchOutbox(fakePool, {
      transportResolver: () => mockTransport({ failOn: () => true }),
    });
    expect(failSummary.deadLettered).toBe(1);
    expect(capturedDeadLetterStatus).toBe("dead_letter");

    simulateClaimStolen = true;
    await expect(
      claimAndDispatchOutbox(fakePool, {
        transportResolver: () => mockTransport(),
      }),
    ).rejects.toThrow(/claim_token/);
  });

  it("dispatchPending expires stale August 'Bugün ödeme', skips closed/superseded rows, rebuilds fresh messages, and batches >5 into 1 digest", async () => {
    const outboxSentKeys = new Set<string>();
    const updatedDeliveries = new Map<string, { status: string; error: string | null; payload?: string }>();

    // 1 superseded (-1 rule on 165d overdue item) + 1 closed + 6 valid (-31 rule on 165d overdue items)
    const pendingRows = [
      {
        id: "d-superseded",
        reminder_id: "r-neg1",
        entity_table: "payment_instances",
        entity_id: "00000000-0000-4000-8000-000000000099",
        scheduled_for: "2026-06-06",
        payload: { message: "FROZEN STALE 1-7 GUN MESSAGE" },
        rule_name: "1-7g",
        target_kind: "payment_instance",
        offset_days: -1,
        channel: "telegram",
        min_amount: null,
        is_active: true,
      },
      {
        id: "d-closed",
        reminder_id: "r-neg31",
        entity_table: "payment_instances",
        entity_id: "00000000-0000-4000-8000-000000000098",
        scheduled_for: "2026-07-06",
        payload: { message: "CLOSED ITEM" },
        rule_name: "30+g",
        target_kind: "payment_instance",
        offset_days: -31,
        channel: "telegram",
        min_amount: null,
        is_active: true,
      },
      ...Array.from({ length: 6 }, (_, idx) => ({
        id: `d-valid-${idx + 1}`,
        reminder_id: "r-neg31",
        entity_table: "payment_instances",
        entity_id: `00000000-0000-4000-8000-00000000000${idx + 1}`,
        scheduled_for: "2026-07-06",
        payload: { message: "90-DAY-OLD FROZEN PAYLOAD" },
        rule_name: "30+g",
        target_kind: "payment_instance",
        offset_days: -31,
        channel: "telegram",
        min_amount: null,
        is_active: true,
      })),
    ];

    const poolQuery = vi.fn(async (sqlRaw: string, params: unknown[] = []) => {
      const sql = sqlRaw.replace(/\s+/g, " ").trim().toLowerCase();
      if (sql === "begin" || sql === "commit" || sql === "rollback") {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("error = 'expired_stale_window'")) {
        // Simulate 2 stale August 2026-08-10 "Bugün ödeme" rows expired upfront!
        return { rows: [], rowCount: 2 };
      }
      if (sql.includes("from public.reminder_deliveries d join public.reminders r")) {
        return { rows: pendingRows, rowCount: pendingRows.length };
      }
      if (sql.includes("from public.payment_instances i")) {
        // Return live open rows ONLY for 99 and 1..6 (98 is paid/closed so omitted!)
        const liveRows = [
          {
            id: "00000000-0000-4000-8000-000000000099",
            name: "Eski Kira",
            due_date: "2026-06-05",
            amount: "50000",
            status: "unpaid",
            owner: "MAS",
            provider: "Halk",
            risk_reasons: ["overdue"],
          },
          ...Array.from({ length: 6 }, (_, idx) => ({
            id: `00000000-0000-4000-8000-00000000000${idx + 1}`,
            name: `Kalem #${idx + 1}`,
            due_date: "2026-06-05",
            amount: "25000",
            status: "unpaid",
            owner: "MAS",
            provider: "Halk",
            risk_reasons: ["critical_payment"],
          })),
        ];
        return { rows: liveRows, rowCount: liveRows.length };
      }
      if (sql.includes("select idempotency_key from public.notification_outbox")) {
        return {
          rows: [...outboxSentKeys].map((k) => ({ idempotency_key: k })),
          rowCount: outboxSentKeys.size,
        };
      }
      if (sql.includes("from public.notification_outbox") && sql.includes("where idempotency_key = $1")) {
        const key = String(params[0] ?? "");
        if (outboxSentKeys.has(key)) {
          return { rows: [{ id: `ob-${key.slice(0, 8)}`, status: "sent", metadata: {} }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      if (sql.startsWith("insert into public.notification_outbox")) {
        const key = String(params[3]);
        outboxSentKeys.add(key);
        return { rows: [{ id: `ob-${key.slice(0, 8)}` }], rowCount: 1 };
      }
      if (sql.startsWith("update public.notification_outbox")) {
        return { rows: [{ id: String(params[0] ?? "ob-1") }], rowCount: 1 };
      }
      if (sql.startsWith("update public.reminder_deliveries")) {
        if (sql.includes("where status = 'claiming'") && !sql.includes("where id = $1")) {
          return { rows: [], rowCount: 0 };
        }
        if (!sql.includes("set status =")) {
          const targetCount = Array.isArray(params[0]) ? params[0].length : 1;
          return { rows: [], rowCount: targetCount };
        }
        const id = String(params[0]);
        if (sql.includes("set status = 'sent'")) {
          updatedDeliveries.set(id, {
            status: "sent",
            error: null,
            payload: typeof params[1] === "string" ? params[1] : undefined,
          });
        } else {
          updatedDeliveries.set(id, {
            status: String(params[1]),
            error: (params[2] as string | null) ?? null,
          });
        }
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL in dispatchPending test: ${sql}`);
    });

    const tg = mockTransport({ channel: "telegram" });
    const fakeDispatchClient = { query: poolQuery, release: vi.fn() } as unknown as PoolClient;
    const fakeDispatchPool = {
      query: poolQuery,
      connect: vi.fn(async () => fakeDispatchClient),
    } as unknown as Pool;
    const res = await dispatchPending(fakeDispatchPool, tg, "2026-11-17");

    // 2 expired_stale_window + 2 superseded_or_closed = 4 skipped; 6 valid sent in 1 consolidated digest!
    expect(res.skipped).toBe(4);
    expect(res.sent).toBe(6);
    expect(res.failed).toBe(0);
    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0]).toContain("<b>MAS Nakit Radar — Toplu Hatırlatma Özeti (2026-11-17)</b>");
    expect(tg.sent[0]).not.toContain("90-DAY-OLD FROZEN PAYLOAD");
    expect(tg.sent[0]).not.toContain("unpaid");

    expect(updatedDeliveries.get("d-superseded")?.error).toBe("superseded_or_closed");
    expect(updatedDeliveries.get("d-closed")?.error).toBe("superseded_or_closed");
    expect(updatedDeliveries.get("d-valid-1")?.payload).toContain("31+ Gün Üst Eskalasyon (İç İnceleme)");
  });

  it("enforces TELEGRAM_ALLOWED_USER_IDS in group chats, gates midnight briefing (< 08:00 TRT), and unlinks stale telemetry-latest.json before crashed snapshot", async () => {
    const { processTelegramUpdatesBatch } = await import("../../../scripts/ops/telegram-assistant-worker");
    const { dispatchDailyCfoBriefingIdempotent } = await import("../../../scripts/ops/background-worker");
    const { runTelemetryWatch } = await import("../../../scripts/ops/telemetry-watch");

    const dir = mkdtempSync(path.join(os.tmpdir(), "mas-ops-gates-"));
    tempDirs.push(dir);

    // A) Group chat user allowlist (`TELEGRAM_ALLOWED_USER_IDS`)
    const offsetPath = path.join(dir, "tg-offset.json");
    const sendReply = vi.fn().mockResolvedValue({ ok: true });
    const answerReadOnly = vi.fn().mockResolvedValue({ kind: "cash", answer: "Kasa: 100 TL" });

    const tgBatch = await processTelegramUpdatesBatch(
      [
        {
          update_id: 1,
          message: {
            message_id: 10,
            chat: { id: "-100555", type: "supergroup" },
            from: { id: 999, is_bot: false },
            text: "/kasa",
          },
        },
        {
          update_id: 2,
          message: {
            message_id: 11,
            chat: { id: "-100555", type: "supergroup" },
            from: { id: 42, is_bot: false },
            text: "/kasa",
          },
        },
      ],
      1,
      {
        allowedChatId: "-100555",
        allowedUserIds: ["42"],
        offsetPath,
        todayISO: () => "2026-11-17",
        answerReadOnly,
        sendReply,
      },
    );
    expect(tgBatch.unauthorizedDropped).toBe(1);
    expect(tgBatch.answered).toBe(1);
    expect(sendReply).toHaveBeenCalledTimes(1);

    // B) Midnight CFO briefing gate (`istanbulHour < 8` -> blocked, zero DB/network queries)
    const midnightBriefing = await dispatchDailyCfoBriefingIdempotent({
      pool: { query: vi.fn() } as unknown as Pool,
      systemActorId: "99999999-9999-4999-8999-999999999999",
      todayISO: "2026-11-17",
      hourSlot: "2026-11-17T00",
      targetHourTrt: 8,
    });
    expect(midnightBriefing.attempted).toBe(false);
    expect(midnightBriefing.skippedReason).toBe("before_briefing_hour");

    // C) Telemetry watch unlinks stale telemetry-latest.json BEFORE running crashing snapshot and notifies [UNKNOWN]
    const watchLogDir = path.join(dir, "watch-logs");
    const crashingScript = path.join(dir, "crash-snapshot.ts");
    const staleJson = path.join(watchLogDir, "telemetry-latest.json");
    mkdirSync(watchLogDir, { recursive: true });
    writeFileSync(
      staleJson,
      JSON.stringify({
        runId: "stale-6h-ago",
        generatedAt: "2026-11-17T00:00:00Z",
        alertCount: 0,
        verdict: "ALL_CLEAR",
        signals: [],
        delivery: { alertLogPath: path.join(watchLogDir, "alerts.jsonl"), channels: ["log"], allDelivered: true },
      }),
      "utf8",
    );
    writeFileSync(crashingScript, "process.exit(3);\n", "utf8");

    const watchTg = mockTransport({ channel: "telegram" });
    const prevChannels = process.env.MAS_ALERT_CHANNELS;
    process.env.MAS_ALERT_CHANNELS = "log,telegram";
    try {
      const code = await runTelemetryWatch({
        logDir: watchLogDir,
        snapshotScriptPath: crashingScript,
        envLocalOverride: {
          MIGRATION_DATABASE_URL: "postgres://postgres:x@127.0.0.1:5432/mas_radar_unit_dummy",
        },
        transports: { telegram: watchTg },
      });
      expect(code).toBe(3);
      expect(existsSync(staleJson)).toBe(false);
      expect(watchTg.sent).toHaveLength(1);
      expect(watchTg.sent[0]).toContain("[UNKNOWN][P0] telemetry_snapshot_unavailable");
    } finally {
      if (prevChannels === undefined) delete process.env.MAS_ALERT_CHANNELS;
      else process.env.MAS_ALERT_CHANNELS = prevChannels;
    }
  });

  it("evaluateAutomatedControls auto-resolves zero-finding control_alerts with audit, and rolloverOverduePaymentInstances marks past-due planned/unpaid rows late", async () => {
    const { evaluateAutomatedControls, rolloverOverduePaymentInstances } = await import(
      "../../../scripts/ops/background-worker"
    );

    const auditActions: string[] = [];
    const controlResolvedIds: string[] = [];
    const paymentLateIds: string[] = [];

    const query = vi.fn(async (sqlRaw: string, params: unknown[] = []) => {
      const sql = sqlRaw.replace(/\s+/g, " ").trim().toLowerCase();
      if (
        sql === "begin" ||
        sql === "commit" ||
        sql === "rollback" ||
        sql.startsWith("set local statement_timeout") ||
        sql.startsWith("savepoint ") ||
        sql.startsWith("release savepoint ")
      ) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("from public.control_dashboard")) {
        return {
          rows: [
            {
              check_code: "iban_changed",
              title: "IBAN değişti",
              default_severity: "critical",
              enforcement: "enforced_elsewhere",
              rationale: "test",
              finding_count: 0,
              state: "PASS",
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("from public.control_alerts") && sql.includes("subject_id is null")) {
        return {
          rows: [
            {
              id: "cccccccc-cccc-4ccc-8ccc-ccccccccccc1",
              check_code: "iban_changed",
              status: "open",
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.startsWith("update public.control_alerts") && sql.includes("status = 'resolved'")) {
        controlResolvedIds.push(String(params[0]));
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("from public.payment_instances") && sql.includes("status in ('planned', 'unpaid')")) {
        return {
          rows: [
            {
              id: "dddddddd-dddd-4ddd-8ddd-ddddddddddd1",
              payment_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1",
              status: "unpaid",
              due_date: "2026-11-10",
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.startsWith("update public.payment_instances") && sql.includes("set status = 'late'")) {
        paymentLateIds.push(String(params[0]));
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith("insert") && sql.includes("public.audit_logs")) {
        auditActions.push(String(params[1]));
        return { rows: [{ id: "ffffffff-ffff-4fff-8fff-fffffffffff1" }], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL in worker test: ${sql}`);
    });

    const client = { query, release: vi.fn() } as unknown as PoolClient;
    const pool = { query, connect: vi.fn(async () => client) } as unknown as Pool;
    const actorId = "99999999-9999-4999-8999-999999999999";

    const ctrlRes = await evaluateAutomatedControls(pool, actorId);
    expect(ctrlRes).toEqual({
      controlsChecked: 1,
      alertsRaisedOrUpdated: 0,
      alertsAutoResolved: 1,
    });
    expect(controlResolvedIds).toEqual(["cccccccc-cccc-4ccc-8ccc-ccccccccccc1"]);

    const piRes = await rolloverOverduePaymentInstances(pool, "2026-11-17", actorId);
    expect(piRes).toEqual({ scanned: 1, transitionedToLate: 1 });
    expect(paymentLateIds).toEqual(["dddddddd-dddd-4ddd-8ddd-ddddddddddd1"]);
    expect(auditActions).toEqual([
      "control_alert_auto_resolved",
      "payment_instance_overdue_rollover",
    ]);
  });
});

describe("V2 Agent 05 — Temporal Boundaries, Istanbul Midnight, Disjoint Escalation & Wording Safety (RG-06 & F-20)", () => {
  const stdRules: ReminderRule[] = [
    rule({ id: "r-p7", offsetDays: 7 }),
    rule({ id: "r-p3", offsetDays: 3 }),
    rule({ id: "r-p1", offsetDays: 1 }),
    rule({ id: "r-0", offsetDays: 0 }),
    rule({ id: "r-n1", offsetDays: -1 }),
    rule({ id: "r-n8", offsetDays: -8 }),
    rule({ id: "r-n31", offsetDays: -31 }),
  ];

  it("locks exact overdue day calculation and stage classification at 0, 1, 7, 8, 30, 31, 123, 364, and 400 days", () => {
    expect(CHRONIC_HISTORICAL_OVERDUE_DAYS).toBe(365);
    const asOf = "2026-11-18";
    const matrix = [
      { due: "2026-11-18", days: 0, bucket: "upcoming", stage: "NOT_DUE", ruleId: "r-0", chronic: false },
      { due: "2026-11-17", days: 1, bucket: "overdue_1_7", stage: "OVERDUE_1_7", ruleId: "r-n1", chronic: false },
      { due: "2026-11-11", days: 7, bucket: "overdue_1_7", stage: "OVERDUE_1_7", ruleId: "r-n1", chronic: false },
      { due: "2026-11-10", days: 8, bucket: "overdue_8_30", stage: "OVERDUE_8_30", ruleId: "r-n8", chronic: false },
      { due: "2026-10-19", days: 30, bucket: "overdue_8_30", stage: "OVERDUE_8_30", ruleId: "r-n8", chronic: false },
      { due: "2026-10-18", days: 31, bucket: "overdue_30_plus", stage: "OVERDUE_31_PLUS", ruleId: "r-n31", chronic: false },
      { due: "2026-07-18", days: 123, bucket: "overdue_30_plus", stage: "OVERDUE_31_PLUS", ruleId: "r-n31", chronic: false },
      { due: "2025-11-19", days: 364, bucket: "overdue_30_plus", stage: "OVERDUE_31_PLUS", ruleId: "r-n31", chronic: false },
      { due: "2025-10-14", days: 400, bucket: "overdue_30_plus", stage: "OVERDUE_31_PLUS", ruleId: "r-n31", chronic: true },
    ] as const;

    for (const row of matrix) {
      expect(daysOverdue(row.due, asOf)).toBe(row.days);
      expect(classifyEscalationBucket(row.due, asOf)).toBe(row.bucket);
      expect(bucketToCanonicalStage(row.bucket)).toBe(row.stage);
      expect(stageForOverdueDays(row.days)).toBe(row.stage);
      expect(isChronicHistoricalOverdue(row.due, asOf)).toBe(row.chronic);

      const deliveries = eligibleDeliveries(
        stdRules,
        [target({ entityId: `g-${row.days}`, dueDate: row.due, status: row.days > 0 ? "late" : "unpaid" })],
        asOf,
      );
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]!.ruleId).toBe(row.ruleId);
      expect(containsUnsubstantiatedLegalClaim(deliveries[0]!.message)).toBe(false);
    }
  });

  it("enforces disjoint bucket invariant across -30..+500 day sweep for all open obligation kinds", () => {
    const dueDate = "2026-05-01";
    const kinds: Array<{ table: string; kind: ReminderRule["targetKind"]; openStatus: string }> = [
      { table: "payment_instances", kind: "payment_instance", openStatus: "unpaid" },
      { table: "checks", kind: "check", openStatus: "in_portfolio" },
      { table: "loan_installments", kind: "loan_installment", openStatus: "unpaid" },
      { table: "invoices", kind: "invoice", openStatus: "open" },
      { table: "promise_to_pay", kind: "promise_to_pay", openStatus: "pending" },
      { table: "covenant_records", kind: "covenant_record", openStatus: "compliant" },
    ];

    for (const k of kinds) {
      const kindRules = stdRules.map((r) => ({ ...r, targetKind: k.kind }));
      const overdueOnly = kindRules.filter((r) => r.offsetDays < 0);
      for (let delta = -30; delta <= 500; delta++) {
        const asOf = scheduledForDate(dueDate, -delta);
        const t = target({ entityTable: k.table, dueDate, status: k.openStatus });
        const allMatched = kindRules.filter((r) => isEligible(r, t, asOf));
        const overdueMatched = overdueOnly.filter((r) => isEligible(r, t, asOf));
        expect(allMatched.length).toBeLessThanOrEqual(1);
        expect(overdueMatched).toHaveLength(delta > 0 ? 1 : 0);
      }
    }
  });

  it("blocks paid, cleared, collected, and cancelled obligations and immediately exits overdue on future reschedule", () => {
    const asOf = "2026-11-18";
    for (const closed of ["paid", "cleared", "collected", "cancelled", "canceled"]) {
      expect(isOpenObligationStatus("payment_instances", closed)).toBe(false);
      expect(isOpenObligationStatus("checks", closed)).toBe(false);
      expect(resolveReminderAmounts({ amount: 40_000, status: closed }).outstandingAmount).toBe(0);
      expect(resolveReminderAmounts({ amount: null, status: closed }).outstandingAmount).toBeNull();
      expect(
        eligibleDeliveries(stdRules, [target({ dueDate: "2026-11-18", status: closed }), target({ dueDate: "2026-10-01", status: closed })], asOf),
      ).toHaveLength(0);

      const dec = evaluateEscalationDecision({
        obligationId: `c-${closed}`,
        entityTable: "payment_instances",
        dueDateISO: "2026-10-01",
        asOfDateISO: asOf,
        status: closed,
      });
      expect(dec.currentStage).toBe("NOT_DUE");
      expect(dec.eligibleForCurrentNotification).toBe(false);
    }

    // Rescheduled from overdue (2026-10-15 -> 34d late) into future (2026-11-28 -> 10d ahead)
    const resched = evaluateEscalationDecision({
      obligationId: "resched-future",
      entityTable: "payment_instances",
      dueDateISO: "2026-11-28",
      rescheduledFromDateISO: "2026-10-15",
      asOfDateISO: asOf,
      status: "planned",
    });
    expect(resched.currentStage).toBe("NOT_DUE");
    expect(resched.previousStage).toBe("OVERDUE_31_PLUS");
    expect(resched.transitionReason).toBe("rescheduled");
    expect(resched.eligibleForCurrentNotification).toBe(false);
    expect(
      eligibleDeliveries(
        stdRules.filter((r) => r.offsetDays <= 0),
        [target({ dueDate: "2026-11-28", rescheduledFromDate: "2026-10-15", status: "planned" })],
        asOf,
      ),
    ).toHaveLength(0);
  });

  it("verifies Europe/Istanbul UTC+3 boundary (20:59:59Z vs 21:00:00Z), fail-closed NaN guards, and zero unsubstantiated legal claims", () => {
    expect(istanbulDateISO(new Date("2026-03-29T20:59:59Z"))).toBe("2026-03-29");
    expect(istanbulDateISO(new Date("2026-03-29T21:00:00Z"))).toBe("2026-03-30");
    expect(istanbulDateISO(new Date("2026-10-25T20:59:59Z"))).toBe("2026-10-25");
    expect(istanbulDateISO(new Date("2026-10-25T21:00:00Z"))).toBe("2026-10-26");

    expect(stageForOverdueDays(Number.NaN)).toBe("NOT_DUE");
    expect(scheduledForDate("2026-11-18", 1e15)).toBe("");
    expect(scheduledForDate("2026-11-18", 2.5)).toBe("");
    expect(buildReminderDigestHtml([{ name: "Bozuk", dueDate: "2026-13-45", amount: 1000, status: "unpaid" }], "2026-11-18")).toContain(
      "Bekleyen hatırlatma yok.",
    );

    for (const label of Object.values(ESCALATION_BUCKET_LABELS)) {
      expect(containsUnsubstantiatedLegalClaim(label)).toBe(false);
    }
    const scrubbed = sanitizeReminderLegalWording("Hukuki takip başlatıldı · İcra başlatıldı · Hukuki eskalasyon");
    expect(containsUnsubstantiatedLegalClaim(scrubbed)).toBe(false);
  });
});
