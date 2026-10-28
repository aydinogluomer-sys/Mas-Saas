import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getBlockingControlAlerts,
  assertNoBlockingControlAlerts,
} from "@/lib/controls/gatekeeper";
import { decideApproval } from "@/lib/approvals/engine";
import { DomainError } from "@/lib/domain-error";

describe("Kilit Taşı 3: Kapalı Devre İç Kontrol & Onay Kilidi", () => {
  let mockClient: any;
  let mockPool: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = {
      query: vi.fn(),
      release: vi.fn(),
    };
    mockPool = {
      connect: vi.fn().mockResolvedValue(mockClient),
    };
  });

  it("açık kritik veya uyarı seviyesinde alarm varsa blokaj listesini döner", async () => {
    mockClient.query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [
        {
          id: "alert-1",
          check_code: "CTRL_IBAN_MISMATCH",
          severity: "critical",
          title: "Fatura IBAN'ı cari profilindekiyle uyuşmuyor",
          status: "open",
          action_item_id: "task-100",
        },
      ],
    });

    const blocking = await getBlockingControlAlerts(mockClient, "invoices", "inv-1");

    expect(blocking).toHaveLength(1);
    expect(blocking[0].checkCode).toBe("CTRL_IBAN_MISMATCH");
    expect(blocking[0].severity).toBe("critical");
  });

  it("assertNoBlockingControlAlerts: açık alarm varken DomainError fırlatır", async () => {
    mockClient.query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [
        {
          id: "alert-2",
          check_code: "CTRL_DUPLICATE_INVOICE",
          severity: "warning",
          title: "Mükerrer fatura şüphesi",
          status: "acknowledged",
          action_item_id: null,
        },
      ],
    });

    await expect(
      assertNoBlockingControlAlerts(mockClient, "invoices", "inv-2"),
    ).rejects.toThrow(DomainError);
  });

  it("assertNoBlockingControlAlerts: alarm yokken sessizce geçer", async () => {
    mockClient.query.mockResolvedValueOnce({
      rowCount: 0,
      rows: [],
    });

    await expect(
      assertNoBlockingControlAlerts(mockClient, "invoices", "inv-3"),
    ).resolves.not.toThrow();
  });

  it("decideApproval: onay verilmek istendiğinde kontrol alarmı varsa işlemi bloke eder", async () => {
    // 1. begin transaction
    mockClient.query.mockResolvedValueOnce({});
    // 2. approvals tablosundan okuma mock (status: pending)
    mockClient.query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [
        {
          id: "appr-1",
          status: "pending",
          round_no: 1,
          requested_by: "user-maker",
          subject_table: "invoices",
          subject_id: "inv-99",
        },
      ],
    });

    // 3. getBlockingControlAlerts mock -> blokaj var!
    mockClient.query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [
        {
          id: "alert-3",
          check_code: "CTRL_UNMATCHED_BANK",
          severity: "critical",
          title: "Banka eşleşmesi bulunmayan ödeme talebi",
          status: "open",
          action_item_id: "task-55",
        },
      ],
    });

    await expect(
      decideApproval(
        mockPool,
        { approvalId: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11", decision: "approved" },
        "user-checker",
      ),
    ).rejects.toThrow(/İç Kontrol Kilidi/);

    expect(mockClient.query).toHaveBeenCalledWith("rollback");
  });

  it("decideApproval: reddetme (rejected) kararı kontrol alarmı olsa bile bloke edilmez", async () => {
    // 1. begin transaction
    mockClient.query.mockResolvedValueOnce({});
    // 2. approvals okuma
    mockClient.query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [
        {
          id: "appr-2",
          status: "pending",
          round_no: 1,
          requested_by: "user-maker",
          subject_table: "invoices",
          subject_id: "inv-99",
        },
      ],
    });

    // 3. update approvals
    mockClient.query.mockResolvedValueOnce({});
    // 4. max step_no
    mockClient.query.mockResolvedValueOnce({ rows: [{ n: "1" }] });
    // 5. insert approval_steps
    mockClient.query.mockResolvedValueOnce({});
    // 6. audit
    mockClient.query.mockResolvedValueOnce({ rows: [{ id: "audit-1" }] });
    // 7. commit
    mockClient.query.mockResolvedValueOnce({});

    await expect(
      decideApproval(
        mockPool,
        {
          approvalId: "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22",
          decision: "rejected",
          note: "Gereksiz harcama, reddedildi",
        },
        "user-checker",
      ),
    ).resolves.not.toThrow();
  });
});
