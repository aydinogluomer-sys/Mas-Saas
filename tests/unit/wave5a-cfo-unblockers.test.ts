import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";

const ledgerMocks = vi.hoisted(() => ({
  postJournalEntryWithClient: vi.fn(),
  reverseManagementEntryWithClient: vi.fn(),
  safeSyncDomainEventWithClient: vi.fn(),
}));

vi.mock("@/lib/ledger/posting-engine", () => ({
  postJournalEntryWithClient: ledgerMocks.postJournalEntryWithClient,
  reverseManagementEntryWithClient: ledgerMocks.reverseManagementEntryWithClient,
  safeSyncDomainEventWithClient: ledgerMocks.safeSyncDomainEventWithClient,
}));

import { DomainError } from "@/lib/domain-error";
import {
  loadDailyCashMovements,
  upsertCashOrBankAccountWithOpeningBalance,
} from "@/lib/treasury/engine";
import {
  decideApproval,
  evaluateSelfApprovalEligibility,
  toggleApprovalRule,
  updateApprovalGovernanceSettings,
  upsertApprovalRule,
} from "@/lib/approvals/engine";
import { approvePaymentRun } from "@/lib/payments/payment-runs";
import { createPayment } from "@/lib/radar/engine";
import {
  EXTENDED_MATCH_WINDOW_DAYS,
  loadOpenManualMatchTargets,
  loadUnmatchedQueue,
  manualMatchBankTransaction,
  rankExtendedCandidates,
  scoreExtendedBankMatch,
} from "@/lib/bank/engine";

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_APPROVER_ID = "22222222-2222-4222-8222-222222222222";
const VALID_TR_IBAN = "TR330006100519786457841326";

interface RecordedSql {
  sql: string;
  params: unknown[];
}

function makePoolFromHandler(
  handler: (sql: string, params: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number }> | { rows: unknown[]; rowCount?: number },
): { pool: Pool; calls: RecordedSql[] } {
  const calls: RecordedSql[] = [];
  const queryFn = vi.fn(async (sql: string, params: unknown[] = []) => {
    const normalized = sql.replace(/\s+/g, " ").trim();
    calls.push({ sql: normalized, params });
    if (/^insert into public\.audit_logs/i.test(normalized)) {
      return { rows: [{ id: "00000000-0000-4000-8000-000000000999" }], rowCount: 1 };
    }
    const res = await handler(normalized, params);
    return {
      rows: res.rows,
      rowCount: res.rowCount ?? res.rows.length,
    };
  });
  const client = {
    query: queryFn,
    release: vi.fn(),
  } as unknown as PoolClient;
  const pool = {
    connect: vi.fn(async () => client),
    query: queryFn,
  } as unknown as Pool;
  return { pool, calls };
}

beforeEach(() => {
  vi.clearAllMocks();
  ledgerMocks.postJournalEntryWithClient.mockImplementation(async () => ({
    entryId: "99999999-9999-4999-8999-999999999999",
    entryNo: "MJE-2026-000001",
    status: "posted",
    reusedExisting: false,
  }));
  ledgerMocks.reverseManagementEntryWithClient.mockImplementation(async () => ({
    reversalEntryId: "88888888-8888-4888-8888-888888888888",
  }));
  ledgerMocks.safeSyncDomainEventWithClient.mockResolvedValue(null);
});

/* ═══════════════════════════════════════════════════════════════════════════
   1) F-45 + F-43: FIN-03 Kasa/Banka + IBAN + 500.99 Opening Ledger & Daily Cash Movement
   ═══════════════════════════════════════════════════════════════════════════ */

describe("F-45 & F-43 — FIN-03 Kasa/Banka Açılış Bakiyesi + 500.99 Yönetim Defteri ve Günlük Nakit Özeti", () => {
  it("yeni banka hesabı pozitif açılış bakiyesiyle oluşturulduğunda IBAN doğrular ve 102 Borç / 500.99 Alacak fişi keser", async () => {
    const newAcctId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
    const postedEntryId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
    ledgerMocks.postJournalEntryWithClient.mockResolvedValueOnce({
      entryId: postedEntryId,
      entryNo: "MJE-2026-000101",
      status: "posted",
      reusedExisting: false,
    });

    const { pool, calls } = makePoolFromHandler((sql) => {
      if (/^insert into public\.cash_accounts/i.test(sql)) {
        return { rows: [{ id: newAcctId }], rowCount: 1 };
      }
      if (/from public\.bank_accounts where cash_account_id/i.test(sql)) {
        return { rows: [], rowCount: 0 };
      }
      if (/^insert into public\.bank_accounts/i.test(sql)) {
        return { rows: [{ iban_normalized: VALID_TR_IBAN }], rowCount: 1 };
      }
      if (/^update public\.cash_accounts set opening_journal_entry_id/i.test(sql)) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });

    const res = await upsertCashOrBankAccountWithOpeningBalance(
      pool,
      {
        name: "Garanti Ticari TL",
        kind: "bank",
        currency: "TRY",
        openingBalance: 250000.5,
        openingBalanceDate: "2026-01-01",
        iban: "TR33 0006 1005 1978 6457 8413 26",
        bankName: "Garanti BBVA",
      },
      ADMIN_ID,
    );

    expect(res.cashAccountId).toBe(newAcctId);
    expect(res.accountType).toBe("bank_account");
    expect(res.ibanNormalized).toBe(VALID_TR_IBAN);
    expect(res.openingJournalEntryId).toBe(postedEntryId);

    expect(ledgerMocks.postJournalEntryWithClient).toHaveBeenCalledTimes(1);
    const [, journalInput, actor] = ledgerMocks.postJournalEntryWithClient.mock.calls[0];
    expect(actor).toBe(ADMIN_ID);
    expect(journalInput).toMatchObject({
      entryDate: "2026-01-01",
      sourceType: "manual_adjustment",
      sourceId: newAcctId,
      idempotencyKey: `opening_balance:${newAcctId}`,
      currency: "TRY",
      lines: [
        { accountCode: "102", debitNative: 250000.5, memo: expect.stringContaining("Garanti Ticari TL") },
        { accountCode: "500.99", creditNative: 250000.5, memo: expect.stringContaining("Garanti Ticari TL") },
      ],
    });
    expect(calls.some((c) => c.sql === "commit")).toBe(true);
  });

  it("negatif açılış bakiyesinde (KMH/kasa alacak bakiyesi) 500.99 Borç / 100 Alacak ters yönlü fiş keser", async () => {
    const cashId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
    const { pool } = makePoolFromHandler((sql) => {
      if (/^insert into public\.cash_accounts/i.test(sql)) {
        return { rows: [{ id: cashId }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });

    await upsertCashOrBankAccountWithOpeningBalance(
      pool,
      {
        name: "Merkez Kasa",
        kind: "cash",
        currency: "TRY",
        openingBalance: -15000,
        openingBalanceDate: "2026-02-01",
      },
      ADMIN_ID,
    );

    expect(ledgerMocks.postJournalEntryWithClient).toHaveBeenCalledTimes(1);
    const [, journalInput] = ledgerMocks.postJournalEntryWithClient.mock.calls[0];
    expect(journalInput.lines).toEqual([
      { accountCode: "500.99", debitNative: 15000, memo: expect.any(String) },
      { accountCode: "100", creditNative: 15000, memo: expect.any(String) },
    ]);
  });

  it("mevcut açılış bakiyesi değiştiğinde eski 'posted' 500.99 fişini önce null'a çekip tersler ve yeni fişi yazar", async () => {
    const existingId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
    const oldEntryId = "77777777-7777-4777-8777-777777777777";
    const newEntryId = "66666666-6666-4666-8666-666666666666";

    ledgerMocks.postJournalEntryWithClient.mockResolvedValueOnce({
      entryId: newEntryId,
      entryNo: "MJE-2026-000102",
      status: "posted",
      reusedExisting: false,
    });

    const { pool, calls } = makePoolFromHandler((sql) => {
      if (/from public\.cash_accounts where id = \$1 for update/i.test(sql)) {
        return {
          rows: [
            {
              id: existingId,
              name: "İş Bankası EUR",
              account_type: "bank_account",
              currency: "EUR",
              opening_balance: "10000.00",
              opening_balance_date: "2026-01-01",
              opening_journal_entry_id: oldEntryId,
              is_active: true,
            },
          ],
          rowCount: 1,
        };
      }
      if (/from public\.bank_accounts where cash_account_id = \$1 for update/i.test(sql)) {
        return {
          rows: [
            {
              cash_account_id: existingId,
              iban: VALID_TR_IBAN,
              iban_normalized: VALID_TR_IBAN,
              bank_name: "İş Bankası",
              branch_code: null,
              branch_name: null,
              account_number: null,
              swift_bic: null,
              overdraft_limit: null,
            },
          ],
          rowCount: 1,
        };
      }
      if (/^insert into public\.bank_accounts/i.test(sql)) {
        return { rows: [{ iban_normalized: VALID_TR_IBAN }], rowCount: 1 };
      }
      if (/from public\.management_journal_entries where id = \$1 for update/i.test(sql)) {
        return {
          rows: [{ id: oldEntryId, status: "posted", entry_date: "2026-01-01" }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    });

    const res = await upsertCashOrBankAccountWithOpeningBalance(
      pool,
      {
        cashAccountId: existingId,
        openingBalance: 18500,
        openingBalanceDate: "2026-01-01",
      },
      ADMIN_ID,
    );

    expect(ledgerMocks.reverseManagementEntryWithClient).toHaveBeenCalledTimes(1);
    expect(ledgerMocks.reverseManagementEntryWithClient.mock.calls[0][1]).toBe(oldEntryId);
    expect(ledgerMocks.postJournalEntryWithClient).toHaveBeenCalledTimes(1);
    expect(res.openingJournalEntryId).toBe(newEntryId);

    const clearIdx = calls.findIndex((c) =>
      /update public\.cash_accounts set opening_journal_entry_id = null/i.test(c.sql),
    );
    const linkIdx = calls.findIndex((c) =>
      /update public\.cash_accounts set opening_journal_entry_id = \$2/i.test(c.sql),
    );
    expect(clearIdx).toBeGreaterThan(-1);
    expect(linkIdx).toBeGreaterThan(clearIdx);
  });

  it("hatalı MOD-97 IBAN girildiğinde VALIDATION hatası fırlatır ve fiş kesmez", async () => {
    const { pool } = makePoolFromHandler(() => ({ rows: [], rowCount: 0 }));
    await expect(
      upsertCashOrBankAccountWithOpeningBalance(
        pool,
        {
          name: "Hatalı IBAN Hesabı",
          kind: "bank",
          currency: "TRY",
          openingBalance: 5000,
          openingBalanceDate: "2026-01-01",
          iban: "TR000006100519786457841326",
        },
        ADMIN_ID,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(ledgerMocks.postJournalEntryWithClient).not.toHaveBeenCalled();
  });

  it("loadDailyCashMovements (F-43) public.daily_cash_movement görünümünü doğru sayısal alanlarla okur", async () => {
    const { pool } = makePoolFromHandler(() => ({
      rows: [
        {
          txn_date: "2026-07-10",
          currency: "TRY",
          inflow: "125000.50",
          outflow: "45000.00",
          net_movement: "80000.50",
          movement_count: 6,
          running_net: "310000.50",
          foreign_txn_count: 0,
        },
      ],
      rowCount: 1,
    }));

    const rows = await loadDailyCashMovements(pool, 15);
    expect(rows).toEqual([
      {
        txnDate: "2026-07-10",
        currency: "TRY",
        inflow: 125000.5,
        outflow: 45000,
        netMovement: 80000.5,
        movementCount: 6,
        runningNet: 310000.5,
        foreignTxnCount: 0,
      },
    ]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   2) F-46: Controlled Single-Operator 4-Eyes Policy (A1) & Rule CRUD
   ═══════════════════════════════════════════════════════════════════════════ */

describe("F-46 — Kontrollü Tek Operatör 4-Göz (Maker-Checker) Öz-Onay Politikası ve Kural CRUD", () => {
  it("aktif onaycı sayısı 1 olan admin, >=10 karakter gerekçeyle kendi onay talebini ve ödeme paketini onaylayabilir", async () => {
    const approvalId = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
    const runId = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1";

    const { pool: approvalPool, calls: approvalCalls } = makePoolFromHandler((sql) => {
      if (/from public\.approvals where id\s*=\s*\$1 for update/i.test(sql)) {
        return {
          rows: [
            {
              id: approvalId,
              status: "pending",
              requested_by: ADMIN_ID,
              subject_table: "payment_runs",
              subject_id: runId,
              request_kind: "payment_run",
              round_no: 1,
            },
          ],
          rowCount: 1,
        };
      }
      if (/select count\(\*\)::int as cnt from public\.users/i.test(sql)) {
        return { rows: [{ cnt: 1 }], rowCount: 1 };
      }
      if (/select role from public\.users where id\s*=\s*\$1/i.test(sql)) {
        return { rows: [{ role: "admin" }], rowCount: 1 };
      }
      if (/from public\.approval_governance_settings/i.test(sql)) {
        return {
          rows: [{ allow_single_operator_self_approval: true, min_justification_length: 10 }],
          rowCount: 1,
        };
      }
      if (/from public\.approval_steps/i.test(sql) && /^select/i.test(sql)) {
        return { rows: [{ n: 2 }], rowCount: 1 };
      }
      if (/from public\.payment_run_items pri/i.test(sql)) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 1 };
    });

    await decideApproval(
      approvalPool,
      {
        approvalId,
        decision: "approved",
        justification: "Şirkette tek aktif yönetici olarak acil tedarikçi ödemesini onaylıyorum.",
      },
      ADMIN_ID,
    );

    const updApproval = approvalCalls.find((c) => /^update public\.approvals set status\s*=\s*\$2/i.test(c.sql));
    expect(updApproval?.params[4]).toBe(true); // self_approved_override = true
    expect(updApproval?.params[5]).toContain("tek aktif yönetici");

    // Same single-operator policy on approvePaymentRun
    const { pool: runPool } = makePoolFromHandler((sql) => {
      if (/from public\.payment_runs where id = \$1 for update/i.test(sql)) {
        return {
          rows: [
            {
              id: runId,
              run_code: "PR-20260715-ABCD",
              status: "pending_approval",
              created_by: ADMIN_ID,
              approval_id: approvalId,
            },
          ],
          rowCount: 1,
        };
      }
      if (/select count\(\*\)::int as cnt from public\.users/i.test(sql)) {
        return { rows: [{ cnt: 1 }], rowCount: 1 };
      }
      if (/select role from public\.users where id = \$1/i.test(sql)) {
        return { rows: [{ role: "admin" }], rowCount: 1 };
      }
      if (/from public\.approval_governance_settings/i.test(sql)) {
        return {
          rows: [{ allow_single_operator_self_approval: true, min_justification_length: 10 }],
          rowCount: 1,
        };
      }
      if (/from public\.payment_run_items pri/i.test(sql)) {
        return { rows: [], rowCount: 0 };
      }
      if (/^update public\.approvals/i.test(sql)) {
        return { rows: [{ status: "approved" }], rowCount: 1 };
      }
      if (/select coalesce\(max\(step_no\), 0\) \+ 1 as n/i.test(sql)) {
        return { rows: [{ n: 2 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });

    const runResult = await approvePaymentRun(
      runPool,
      {
        runId,
        justification: "Tek aktif yönetici onayı — pain.001 banka paketi ihracı.",
      },
      ADMIN_ID,
    );
    expect(runResult).toEqual({
      runId,
      status: "approved",
      selfApprovedOverride: true,
    });
  });

  it("aktif onaycı sayısı >= 2 olduğunda admin dahil hiç kimse kendi kaydını onaylayamaz (sıkı 4-göz)", async () => {
    const runId = "dddddddd-dddd-4ddd-8ddd-ddddddddddd2";
    const { pool } = makePoolFromHandler((sql) => {
      if (/from public\.payment_runs where id = \$1 for update/i.test(sql)) {
        return {
          rows: [
            {
              id: runId,
              run_code: "PR-20260715-TWOO",
              status: "pending_approval",
              created_by: ADMIN_ID,
              approval_id: null,
            },
          ],
          rowCount: 1,
        };
      }
      if (/select count\(\*\)::int as cnt from public\.users/i.test(sql)) {
        return { rows: [{ cnt: 2 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(
      approvePaymentRun(
        pool,
        {
          runId,
          justification: "2 onaycı varken kendi paketimi onaylamayı deniyorum.",
        },
        ADMIN_ID,
      ),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("2 aktif onaycı"),
    });
  });

  it("tek operatörde gerekçe 10 karakterden kısaysa VALIDATION, politika kapalıysa FORBIDDEN fırlatır", async () => {
    const shortClient = {
      query: vi.fn(async (sql: string) => {
        if (/select count\(\*\)::int as cnt/i.test(sql)) return { rows: [{ cnt: 1 }], rowCount: 1 };
        if (/select role from public\.users/i.test(sql)) return { rows: [{ role: "admin" }], rowCount: 1 };
        return {
          rows: [{ allow_single_operator_self_approval: true, min_justification_length: 12 }],
          rowCount: 1,
        };
      }),
    } as unknown as Pick<PoolClient, "query">;

    await expect(
      evaluateSelfApprovalEligibility(shortClient, ADMIN_ID, "kısa"),
    ).rejects.toMatchObject({ code: "VALIDATION" });

    const disabledClient = {
      query: vi.fn(async (sql: string) => {
        if (/select count\(\*\)::int as cnt/i.test(sql)) return { rows: [{ cnt: 1 }], rowCount: 1 };
        if (/select role from public\.users/i.test(sql)) return { rows: [{ role: "admin" }], rowCount: 1 };
        return {
          rows: [{ allow_single_operator_self_approval: false, min_justification_length: 10 }],
          rowCount: 1,
        };
      }),
    } as unknown as Pick<PoolClient, "query">;

    await expect(
      evaluateSelfApprovalEligibility(disabledClient, ADMIN_ID, "Uzun ama politika kapalı gerekçesi"),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("updateApprovalGovernanceSettings, upsertApprovalRule ve toggleApprovalRule yalnızca admin için çalışır", async () => {
    const nonAdminPool = makePoolFromHandler((sql) => {
      if (/select role from public\.users/i.test(sql)) {
        return { rows: [{ role: "finance_manager" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }).pool;

    await expect(
      updateApprovalGovernanceSettings(
        nonAdminPool,
        { allowSingleOperatorSelfApproval: false, minJustificationLength: 15 },
        OTHER_APPROVER_ID,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const ruleId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1";
    const { pool: adminPool } = makePoolFromHandler((sql) => {
      if (/select role from public\.users/i.test(sql)) {
        return { rows: [{ role: "admin" }], rowCount: 1 };
      }
      if (/^insert into public\.approval_rules/i.test(sql)) {
        return { rows: [{ id: ruleId }], rowCount: 1 };
      }
      if (/from public\.approval_rules where id = \$1 for update/i.test(sql)) {
        return { rows: [{ id: ruleId, code: "payment_over_threshold", is_active: true }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });

    const saved = await upsertApprovalRule(
      adminPool,
      {
        code: "payment_over_threshold",
        description: "250.000 TL üzeri ödeme kalemi onayı",
        triggerKind: "amount_gte",
        thresholdAmount: 250000,
        currency: "TRY",
        appliesTo: ["payment_instances"],
        isActive: true,
      },
      ADMIN_ID,
    );
    expect(saved.ruleId).toBe(ruleId);

    await expect(toggleApprovalRule(adminPool, ruleId, false, ADMIN_ID)).resolves.toBeUndefined();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   3) F-47: /payments/new "Tek seferlik" (one_off) Atomic Instance Generation
   ═══════════════════════════════════════════════════════════════════════════ */

describe("F-47 — /payments/new 'Tek seferlik' (one_off) Atomik payment_instances Üretimi", () => {
  it("recurrence_type='one_off' ödeme oluşturulduğunda aynı DB işleminde 1 adet payment_instances satırı ekler", async () => {
    const payId = "ffffffff-ffff-4fff-8fff-fffffffffff1";
    const instId = "ffffffff-ffff-4fff-8fff-fffffffffff2";

    const { pool, calls } = makePoolFromHandler((sql) => {
      if (/^insert into public\.payments/i.test(sql)) {
        return { rows: [{ id: payId }], rowCount: 1 };
      }
      if (/from public\.cashflow_months/i.test(sql)) {
        return { rows: [], rowCount: 0 };
      }
      if (/from public\.accounting_periods/i.test(sql)) {
        return { rows: [], rowCount: 0 };
      }
      if (/from public\.payment_instances/i.test(sql) && /^select/i.test(sql)) {
        return { rows: [], rowCount: 0 };
      }
      if (/^insert into public\.payment_instances/i.test(sql)) {
        return { rows: [{ id: instId }], rowCount: 1 };
      }
      if (/from public\.approval_rules/i.test(sql)) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 1 };
    });

    const result = await createPayment(
      pool,
      {
        name: "Yıllık Sigorta Poliçesi Peşin",
        recurrence_type: "one_off",
        due_date: "2026-08-20",
        default_amount: 84500,
        currency: "TRY",
        direction: "outflow",
        priority: "high",
      },
      "2026-07-12",
      ADMIN_ID,
    );

    expect(result.paymentId).toBe(payId);
    expect(result.createdInstanceIds).toEqual([instId]);

    const insertPayCall = calls.find((c) => /^insert into public\.payments/i.test(c.sql));
    const insertInstCall = calls.find((c) => /^insert into public\.payment_instances/i.test(c.sql));
    expect(insertPayCall?.params[1]).toBe("one_off");
    expect(insertPayCall?.params[3]).toBe("2026-08-20");
    expect(insertInstCall?.params[0]).toBe(payId);
    expect(insertInstCall?.params[1]).toBe("2026-08-01"); // period_month
    expect(insertInstCall?.params[2]).toBe("2026-08-20"); // due_date
    expect(insertInstCall?.params[3]).toBe(84500);
    expect(calls.some((c) => c.sql === "commit")).toBe(true);
  });

  it("one_off ödemede vade tarihi ve günü verilmezse VALIDATION hatası fırlatır", async () => {
    const { pool } = makePoolFromHandler(() => ({ rows: [], rowCount: 0 }));
    await expect(
      createPayment(
        pool,
        {
          name: "Tarihsiz Tek Seferlik Ödeme",
          recurrence_type: "one_off",
          default_amount: 12000,
        },
        "2026-07-12",
        ADMIN_ID,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   4) F-48: Flexible Bank Matching ±90 Days + Manual Target Settlement
   ═══════════════════════════════════════════════════════════════════════════ */

describe("F-48 — Esnek ±90 Gün Banka Eşleştirme Puanlaması ve Tek Tıkla Manuel Kapanış", () => {
  it("±90 gün kademeli tarih puanlaması: <=10g > 30g > 60g > 90g >= 0.50 iken 95g eşik altında kalır", () => {
    expect(EXTENDED_MATCH_WINDOW_DAYS).toBe(90);

    const baseTarget = {
      table: "invoices" as const,
      id: "12345678-1234-4234-8234-123456789012",
      amount: 42500,
      label: null,
      direction: "inflow" as const,
      currency: "TRY",
    };

    const tx = {
      amount: 42500,
      txnDate: "2026-07-15",
      description: "HAVALE TAHSILAT",
      counterparty: null,
      currency: "TRY",
    };

    const score3d = scoreExtendedBankMatch(tx, { ...baseTarget, dueDate: "2026-07-13" });
    const score9d = scoreExtendedBankMatch(tx, { ...baseTarget, dueDate: "2026-07-06" });
    const score30d = scoreExtendedBankMatch(tx, { ...baseTarget, dueDate: "2026-06-15" });
    const score60d = scoreExtendedBankMatch(tx, { ...baseTarget, dueDate: "2026-05-16" });
    const score90d = scoreExtendedBankMatch(tx, { ...baseTarget, dueDate: "2026-04-16" });
    const score95d = scoreExtendedBankMatch(tx, { ...baseTarget, dueDate: "2026-04-11" });

    expect(score3d.confidence).toBeGreaterThan(score9d.confidence);
    expect(score9d.confidence).toBeGreaterThan(score30d.confidence);
    expect(score30d.confidence).toBeGreaterThan(score60d.confidence);
    expect(score60d.confidence).toBeGreaterThan(score90d.confidence);
    expect(score30d.confidence).toBeGreaterThanOrEqual(0.5);
    expect(score90d.confidence).toBeGreaterThanOrEqual(0.5);
    expect(score95d.confidence).toBeLessThan(0.5);

    const ranked = rankExtendedCandidates(tx, [
      { ...baseTarget, id: "t-95", dueDate: "2026-04-11" },
      { ...baseTarget, id: "t-35", dueDate: "2026-06-10" },
      { ...baseTarget, id: "t-09", dueDate: "2026-07-06" },
    ]);
    expect(ranked.map((r) => r.id)).toEqual(["t-09", "t-35"]);
  });

  it("manualMatchBankTransaction targetKey ('loan_installments:<uuid>') ile 'unpaid' kredi taksitini atomik kapatır", async () => {
    const txId = "91919191-9191-4919-8919-919191919191";
    const liId = "92929292-9292-4929-8929-929292929292";

    const { pool, calls } = makePoolFromHandler((sql) => {
      if (/from public\.bank_transactions bt/i.test(sql)) {
        return {
          rows: [
            {
              id: txId,
              status: "unmatched",
              matched_entity_table: null,
              matched_entity_id: null,
              amount: "-32500.00",
              txn_date: "2026-07-12",
              currency: "TRY",
            },
          ],
          rowCount: 1,
        };
      }
      if (/from public\.loan_installments li/i.test(sql)) {
        return {
          rows: [
            {
              id: liId,
              status: "unpaid",
              amount: "32500.00",
              paid_amount: "0.00",
              currency: "TRY",
            },
          ],
          rowCount: 1,
        };
      }
      if (/^update public\.loan_installments/i.test(sql)) {
        return { rows: [], rowCount: 1 };
      }
      if (/from public\.bank_transaction_match_candidates/i.test(sql)) {
        return { rows: [], rowCount: 0 };
      }
      if (/^update public\.bank_transactions/i.test(sql)) {
        return { rows: [], rowCount: 1 };
      }
      if (/from public\.payment_run_items pri/i.test(sql)) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 1 };
    });

    await manualMatchBankTransaction(
      pool,
      {
        transactionId: txId,
        targetKey: `loan_installments:${liId}`,
      },
      ADMIN_ID,
    );

    const updInstallment = calls.find((c) => /^update public\.loan_installments/i.test(c.sql));
    expect(updInstallment).toBeDefined();
    expect(ledgerMocks.safeSyncDomainEventWithClient).toHaveBeenCalledWith(
      expect.anything(),
      { kind: "loan_installment", installmentId: liId },
      ADMIN_ID,
    );

    const auditInsert = calls.find((c) => /insert into public\.audit_logs/i.test(c.sql));
    expect(JSON.stringify(auditInsert?.params ?? [])).toContain("manual_match_bank_transaction");
  });

  it("loadOpenManualMatchTargets ve loadUnmatchedQueue döviz ve yön bilgilerini eksiksiz döndürür", async () => {
    const { pool } = makePoolFromHandler((sql) => {
      if (/from public\.bank_unmatched_queue q/i.test(sql)) {
        return {
          rows: [
            {
              id: "tx-usd-1",
              account_name: "USD Ticari",
              txn_date: "2026-07-11",
              description: "SWIFT INCOMING",
              counterparty_name_raw: "ACME CORP",
              amount: "12000.00",
              direction: "inflow",
              category: "incoming_payment",
              category_rule: "incoming_transfer",
              status: "unmatched",
              open_candidate_count: 0,
              best_confidence: null,
              currency: "USD",
            },
          ],
          rowCount: 1,
        };
      }
      return {
        rows: [
          {
            target_table: "invoices",
            target_id: "inv-usd-1",
            reference_label: "Fatura EXP-2026-09",
            counterparty_name: "ACME CORP",
            open_amount: "12000.00",
            currency: "USD",
            direction: "inflow",
            due_date: "2026-05-20",
          },
        ],
        rowCount: 1,
      };
    });

    const queue = await loadUnmatchedQueue(pool, 50, 0);
    expect(queue[0]?.currency).toBe("USD");
    expect(queue[0]?.direction).toBe("inflow");

    const targets = await loadOpenManualMatchTargets(pool, 50);
    expect(targets).toEqual([
      {
        targetKey: "invoices:inv-usd-1",
        targetTable: "invoices",
        targetId: "inv-usd-1",
        referenceLabel: "Fatura EXP-2026-09",
        counterpartyName: "ACME CORP",
        openAmount: 12000,
        currency: "USD",
        direction: "inflow",
        dueDate: "2026-05-20",
      },
    ]);
    expect(DomainError).toBeDefined();
  });
});
