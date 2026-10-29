/**
 * "/hareket" — the newest movements, proven WITHOUT mocking the reader.
 *
 * assistant.test.ts mocks @/lib/receivables/engine, which is exactly why it could not see this
 * defect: the reader loaded a party's OLDEST 200 movements (`order by movement_date limit 200`)
 * and the assistant printed their tail under "son N hareket". With two mocked rows that looks
 * right; with 250 real ones the owner was shown rows ~191-200 of the party's history as its
 * latest, and every newer invoice and collection was silently cut off.
 *
 * Here the real assistant calls the real reader against a fake pool that EXECUTES whatever
 * `order by … limit $n` the SQL says — it does not know which order is the right one. So the
 * assertions below only pass if the SQL itself asks for the newest rows, in the requested number.
 */
import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { answerTelegramQuestion } from "./assistant";

interface LedgerFixtureRow {
  party_id: string;
  movement_date: string;
  movement_type: string;
  reference: string;
  direction: "sales" | "purchase";
  debit_amount: string;
  credit_amount: string;
  invoice_id: string;
  currency: string;
}

/** 250 movements, one per day from 2025-01-01: more than the old 200-row window. */
function ledgerFixture(): LedgerFixtureRow[] {
  return Array.from({ length: 250 }, (_, i) => {
    const day = new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10);
    return {
      party_id: "party-1",
      movement_date: day,
      movement_type: "fatura (satış)",
      reference: `F-${String(i + 1).padStart(3, "0")}`,
      direction: "sales",
      debit_amount: "1000.00",
      credit_amount: "0.00",
      invoice_id: `inv-${i + 1}`,
      currency: "TRY",
    };
  });
}

/**
 * Applies the query's own ORDER BY (any number of `l.<column> [desc]` terms) and its LIMIT
 * parameter to the fixture. Nothing here prefers newest or oldest; the SQL decides.
 */
function executeOrderAndLimit(sql: string, params: unknown[], rows: LedgerFixtureRow[]): LedgerFixtureRow[] {
  const m = /order by\s+([^]+?)\s+limit\s+\$(\d+)/i.exec(sql);
  if (!m) throw new Error(`ledger sorgusunda order by … limit yok: ${sql}`);
  const terms = m[1].split(",").map((t) => {
    const [col, dir] = t.trim().split(/\s+/);
    return { key: col.replace(/^l\./, "") as keyof LedgerFixtureRow, desc: dir?.toLowerCase() === "desc" };
  });
  const limit = Number(params[Number(m[2]) - 1]);
  return [...rows]
    .sort((a, b) => {
      for (const { key, desc } of terms) {
        const cmp = String(a[key]).localeCompare(String(b[key]));
        if (cmp !== 0) return desc ? -cmp : cmp;
      }
      return 0;
    })
    .slice(0, limit);
}

function fakePool(ledger: LedgerFixtureRow[]) {
  const ledgerCalls: { sql: string; params: unknown[] }[] = [];
  const pool = {
    async query(sql: string, params: unknown[] = []) {
      if (sql.includes("from public.current_account_summary")) {
        return {
          rows: [{
            party_id: "party-1", party_name: "Akon Endüstri", party_type: "customer",
            receivable_open: "250000.00", payable_open: "0.00", receivable_count: 250, payable_count: 0,
            overdue_count: 0, earliest_due_date: null, sales_total_all_time: "250000.00",
            purchase_total_all_time: "0.00", last_invoice_date: "2025-09-07", foreign_currency_count: 0,
          }],
        };
      }
      if (sql.includes("from public.current_account_ledger")) {
        ledgerCalls.push({ sql, params });
        return { rows: executeOrderAndLimit(sql, params, ledger.filter((r) => r.party_id === params[0])) };
      }
      throw new Error(`beklenmeyen sorgu: ${sql}`);
    },
  };
  return { pool: pool as unknown as Pool, ledgerCalls };
}

const referencesIn = (answer: string): string[] => answer.match(/F-\d{3}/g) ?? [];

describe("Telegram asistanı — /hareket gerçekten SON hareketleri verir (okuyucu mock'lanmadan)", () => {
  it("250 hareketli bir caride varsayılan 10: en yeni 10, en yeniden eskiye", async () => {
    const { pool } = fakePool(ledgerFixture());

    const result = await answerTelegramQuestion(pool, "/hareket Akon", "2025-09-08");

    expect(result.kind).toBe("current_account_ledger");
    expect(result.answer).toContain("Akon Endüstri — son 10 hareket");
    // Movements #250 … #241. The old code answered with #200 … #191.
    expect(referencesIn(result.answer)).toEqual(
      Array.from({ length: 10 }, (_, i) => `F-${String(250 - i).padStart(3, "0")}`),
    );
    expect(result.answer).not.toContain("F-200");
  });

  it("'son 3' istenince en yeni 3 — sayı da sırayla birlikte SQL'de", async () => {
    const { pool, ledgerCalls } = fakePool(ledgerFixture());

    const result = await answerTelegramQuestion(pool, "Akon firmasının son 3 hareketi", "2025-09-08");

    expect(referencesIn(result.answer)).toEqual(["F-250", "F-249", "F-248"]);
    expect(result.answer).toContain("son 3 hareket");
    // One query, limited to what was asked — no 200-row window trimmed in JavaScript.
    expect(ledgerCalls).toHaveLength(1);
    expect(ledgerCalls[0].params).toEqual(["party-1", 3]);
  });

  it("hareketi istenenden az olan caride hepsini yeniden eskiye verir", async () => {
    const { pool } = fakePool(ledgerFixture().slice(0, 4));

    const result = await answerTelegramQuestion(pool, "/hareket Akon", "2025-09-08");

    expect(result.answer).toContain("son 4 hareket");
    expect(referencesIn(result.answer)).toEqual(["F-004", "F-003", "F-002", "F-001"]);
  });
});
