import { describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { DomainError } from "@/lib/domain-error";
import {
  ignoreTransaction,
  unignoreTransaction,
  unmatchTransaction,
} from "@/lib/bank/engine";
import { cancelInstance, markInstanceUnpaid } from "@/lib/radar/engine";
import { cancelCheck, classifyUnknownCheck } from "@/lib/financing/engine";
import { resolvePromise } from "@/lib/collections/promises-engine";
import { FEATURE_REGISTRY } from "@/lib/feature-registry";

const ACTOR = "11111111-1111-4111-8111-111111111111";
const TX_ID = "22222222-2222-4222-8222-222222222222";
const INV_ID = "33333333-3333-4333-8333-333333333333";
const PI_ID = "44444444-4444-4444-8444-444444444444";
const CHK_ID = "55555555-5555-4555-8555-555555555555";
const PROMISE_ID = "66666666-6666-4666-8666-666666666666";

function makeMockPool(
  handler: (sql: string, params: unknown[]) => { rows: Record<string, unknown>[]; rowCount?: number },
): { pool: Pool; executed: Array<{ sql: string; params: unknown[] }> } {
  const executed: Array<{ sql: string; params: unknown[] }> = [];
  const client: Partial<PoolClient> = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      const normalized = sql.replace(/\s+/g, " ").trim();
      executed.push({ sql: normalized, params });
      if (/^(begin|commit|rollback|savepoint|release savepoint|rollback to savepoint)/i.test(normalized)) {
        return { rows: [], rowCount: 0 } as never;
      }
      if (/insert into public\.audit_logs/i.test(normalized)) {
        return { rows: [{ id: "99999999-9999-4999-8999-999999999999" }], rowCount: 1 } as never;
      }
      const res = handler(normalized, params);
      return { rows: res.rows, rowCount: res.rowCount ?? res.rows.length } as never;
    }) as unknown as PoolClient["query"],
    release: vi.fn(),
  };
  const pool = {
    connect: vi.fn(async () => client as PoolClient),
    query: client.query,
  } as unknown as Pool;
  return { pool, executed };
}

describe("Wave 6 — Durum Makineleri (F-56, F-57) ve Özellik Kaydı (F-67)", () => {
  it("F-56: ignoreTransaction eşleştirilmiş ('matched') banka hareketini doğrudan yok saymayı reddeder", async () => {
    const { pool } = makeMockPool((sql) => {
      if (/from public\.bank_transactions where id=\$1 for update/i.test(sql)) {
        return { rows: [{ id: TX_ID, status: "matched", ignored_reason: null }] };
      }
      return { rows: [] };
    });

    await expect(
      ignoreTransaction(pool, { transactionId: TX_ID, reason: "Yanlış satır" }, ACTOR),
    ).rejects.toThrow(DomainError);
  });

  it("F-56: unignoreTransaction 'ignored' hareketi 'unmatched' durumuna döndürür", async () => {
    const { pool, executed } = makeMockPool((sql) => {
      if (/from public\.bank_transactions where id = \$1 for update/i.test(sql)) {
        return { rows: [{ id: TX_ID, status: "ignored", ignored_reason: "Test" }] };
      }
      return { rows: [] };
    });

    await unignoreTransaction(pool, { transactionId: TX_ID }, ACTOR);
    expect(
      executed.some((e) =>
        /update public\.bank_transactions set status = 'unmatched', ignored_reason = null/i.test(e.sql),
      ),
    ).toBe(true);
  });

  it("F-56: unmatchTransaction 'reconciled' hareketi önce 'matched'a çeker, tahsisatı tersler ve 'unmatched' yapar", async () => {
    const { pool, executed } = makeMockPool((sql) => {
      if (/from public\.bank_transactions where id = \$1 for update/i.test(sql)) {
        return {
          rows: [
            {
              id: TX_ID,
              status: "reconciled",
              matched_entity_table: "invoices",
              matched_entity_id: INV_ID,
              settled_allocation_id: "77777777-7777-4777-8777-777777777777",
              amount: "-15000.00",
              txn_date: "2026-11-10",
            },
          ],
        };
      }
      if (/from public\.payment_run_items/i.test(sql)) {
        return {
          rows: [{ id: "88888888-8888-4888-8888-888888888888", run_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }],
        };
      }
      if (/from public\.management_journal_entries/i.test(sql)) {
        return { rows: [] };
      }
      return { rows: [], rowCount: 1 };
    });

    await unmatchTransaction(
      pool,
      { transactionId: TX_ID, reason: "Yanlış faturayla eşleşti" },
      ACTOR,
    );

    const stepMatchedIdx = executed.findIndex((e) =>
      /update public\.bank_transactions set status = 'matched', reconciled_at = null/i.test(e.sql),
    );
    const revAllocIdx = executed.findIndex((e) =>
      /update public\.invoice_allocations set reversed_at = now\(\)/i.test(e.sql),
    );
    const resetUnmatchedIdx = executed.findIndex((e) =>
      /update public\.bank_transactions set status = 'unmatched', matched_entity_table = null/i.test(e.sql),
    );

    expect(stepMatchedIdx).toBeGreaterThan(-1);
    expect(revAllocIdx).toBeGreaterThan(stepMatchedIdx);
    expect(resetUnmatchedIdx).toBeGreaterThan(revAllocIdx);
  });

  it("F-57: payment_instances 'partial' durumundan geri alınabilir ('unpaid') ve iptal edilebilir ('cancelled')", async () => {
    const { pool: poolUnpaid, executed: execUnpaid } = makeMockPool((sql) => {
      if (/from public\.payment_instances where id=\$1 for update/i.test(sql)) {
        return { rows: [{ id: PI_ID, status: "partial", paid_amount: "250.00", paid_at: "2026-11-01" }] };
      }
      return { rows: [], rowCount: 1 };
    });
    await markInstanceUnpaid(poolUnpaid, PI_ID, ACTOR);
    expect(
      execUnpaid.some((e) => /update public\.payment_instances set status='unpaid', paid_at=null, paid_amount=null/i.test(e.sql)),
    ).toBe(true);

    const { pool: poolCancel, executed: execCancel } = makeMockPool((sql) => {
      if (/from public\.payment_instances where id=\$1 for update/i.test(sql)) {
        return {
          rows: [
            {
              id: PI_ID,
              status: "partial",
              cancelled_at: null,
              cancel_reason: null,
              paid_at: "2026-11-01",
              paid_amount: "250.00",
            },
          ],
        };
      }
      if (/update public\.payment_instances/i.test(sql)) {
        return { rows: [{ cancelled_at_iso: "2026-11-12T10:00:00.000000Z" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    await cancelInstance(poolCancel, PI_ID, "Mükerrer tahakkuk iptali", ACTOR);
    expect(
      execCancel.some((e) => /paid_at=null, paid_amount=null/i.test(e.sql)),
    ).toBe(true);
  });

  it("F-57: 'unknown' çek sınıflandırılabilir ('in_portfolio' / 'issued_to_vendor') ve iptal edilebilir", async () => {
    const { pool, executed } = makeMockPool((sql) => {
      if (/from public\.checks where id = \$1 for update/i.test(sql)) {
        return { rows: [{ id: CHK_ID, status: "unknown", direction: "unknown", amount: "12000.00" }] };
      }
      if (/from public\.checks where id=\$1 for update/i.test(sql)) {
        return { rows: [{ id: CHK_ID, status: "unknown" }] };
      }
      return { rows: [], rowCount: 1 };
    });

    await classifyUnknownCheck(pool, CHK_ID, "issued_to_vendor", ACTOR);
    expect(
      executed.some(
        (e) =>
          /update public\.checks set status = \$2, direction = \$3, signed_amount = \$4::numeric/i.test(e.sql) &&
          e.params[1] === "issued_to_vendor" &&
          e.params[2] === "outflow" &&
          e.params[3] === -12000,
      ),
    ).toBe(true);

    await cancelCheck(pool, CHK_ID, "Geçersiz içe aktarım çeki", ACTOR);
    expect(
      executed.some((e) => /update public\.checks set status='cancelled'/i.test(e.sql)),
    ).toBe(true);
  });

  it("F-57: 'broken' ödeme sözü 'kept' yapıldığında açık action_items görevini de kapatır", async () => {
    const { pool, executed } = makeMockPool((sql) => {
      if (/from public\.promise_to_pay where id=\$1 for update/i.test(sql)) {
        return {
          rows: [
            {
              id: PROMISE_ID,
              status: "broken",
              party_id: ACTOR,
              promised_amount: "50000.00",
              promised_date: "2026-11-01",
            },
          ],
        };
      }
      return { rows: [], rowCount: 1 };
    });

    await resolvePromise(
      pool,
      { promiseId: PROMISE_ID, status: "kept", note: "Gecikmeli havale ulaştı" },
      ACTOR,
    );

    expect(
      executed.some(
        (e) =>
          /update public\.action_items set status = \$2 where related_entity_table = 'promise_to_pay'/i.test(e.sql) &&
          e.params[1] === "done",
      ),
    ).toBe(true);
  });

  it("F-67: feature-registry #22 /cashflow/13-week'e işaret eder ve #23..#30 fazları kayıtlıdır", () => {
    const f22 = FEATURE_REGISTRY.find((f) => f.id === "22");
    expect(f22?.canonicalRoute).toBe("/cashflow/13-week");
    expect(FEATURE_REGISTRY.length).toBeGreaterThanOrEqual(30);
  });
});
