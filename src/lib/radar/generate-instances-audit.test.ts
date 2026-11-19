// P1 — `generate_instances` denetim kaydı yalnız gerçek bir üretim olduğunda yazılmalı.
//
// NEDEN BU TEST VAR. `prepare-runtime`, `ensureWindow(..., 24)` üzerinden ayda bir kez olmak
// üzere 26 kez `generateInstancesForMonthWithClient` çağırır. Pencere zaten doluyken 26
// çağrının hepsi `created = 0` döner; eskiden yine de 26 `generate_instances` satırı yazılırdı.
// P24B Attempt-04'te gerçek veritabanında ölçüldü: tek bir `pnpm start` sonrası
// payment_instances 502 → 502 (INSERT 0, UPDATE 0) iken audit_logs 788 → 814.
//
// GERÇEK VERİTABANI YOK. Bu dosya bilerek sahte bir `pg` client'ı sürer ve `audit()`'in ürettiği
// SQL'i gözlemler — `audit.test.ts` ile aynı seviye. Test edilen şey bir round-trip değil, bir
// KARAR: "denetim satırı yazıldı mı, yazılmadı mı, ve payload'ı doğru mu".
//
// Sahte client bilinmeyen bir SQL görürse fırlatır. Böylece üretim yolu yeni bir sorgu eklerse
// test sessizce yanlış bir şeyi ölçmeye devam etmez, kırmızıya döner.
import { describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { ensureWindow, generateInstancesForMonthWithClient } from "./engine";
import { addMonths } from "./rules";
import { APP_ROLES, DB_ROLE, can } from "@/lib/authz/matrix";

// Rol elle yazılmıyor: engine.ts izin listesini authz matrisinden türetiyor, test de öyle
// yapıyor. Matris değişirse ikisi birlikte değişir.
const MAINTENANCE_ROLE = DB_ROLE[
  APP_ROLES.find((r) => can(r, "payment_instances", "insert") && can(r, "payment_instances", "update"))!
];

const ACTOR = "11111111-1111-1111-1111-111111111111";

interface AuditCall {
  action: string;
  after: { monthStart: string; created: number; total: number };
}

interface FakePaymentSeed {
  id: string;
  due_day: number | null;
  due_date?: string | null;
  created_iso?: string | null;
  default_amount?: string | null;
  currency?: string;
  recurrence_type?: string;
  source_notes?: string | null;
}

interface InsertedInstanceRecord {
  paymentId: string;
  month: string;
  dueDate: string;
  amount: number | null;
  currency: string;
  note: string | null;
}

class FakeDb {
  readonly audits: AuditCall[] = [];
  readonly insertedKeys: string[] = [];
  readonly insertedRows: InsertedInstanceRecord[] = [];
  readonly monthsAttempted: string[] = [];
  private readonly existing: Set<string>;

  constructor(
    private readonly payments: FakePaymentSeed[],
    existing: Array<[string, string]> = [],
  ) {
    this.existing = new Set(existing.map(([p, m]) => `${p}|${m}`));
  }

  /** Bir (ödeme, ay) çiftini "zaten var" olarak işaretler. */
  seed(paymentId: string, month: string): void {
    this.existing.add(`${paymentId}|${month}`);
  }

  query = async (sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> => {
    const s = sql.trim();

    if (
      s.startsWith("begin") ||
      s.startsWith("commit") ||
      s.startsWith("rollback") ||
      s.startsWith("savepoint") ||
      s.startsWith("release savepoint")
    ) {
      return { rows: [], rowCount: 0 };
    }
    if (s.includes("select current_user")) {
      return { rows: [{ current_user: MAINTENANCE_ROLE }], rowCount: 1 };
    }
    if (s.includes("from public.payments")) {
      const rows = this.payments.map((p) => ({
        id: p.id,
        due_day: p.due_day,
        due_date: p.due_date ?? null,
        created_iso: p.created_iso ?? "2026-01-01",
        default_amount: p.default_amount === undefined ? "1000" : p.default_amount,
        currency: p.currency ?? "TRY",
        recurrence_type: p.recurrence_type ?? "monthly",
        source_notes: p.source_notes ?? null,
        amount_confidence: "known",
        direction: "outflow",
      }));
      return { rows, rowCount: rows.length };
    }
    if (s.includes("insert into public.payment_instances")) {
      const paymentId = String(params![0]);
      const month = String(params![1]);
      if (!this.monthsAttempted.includes(month)) this.monthsAttempted.push(month);
      const key = `${paymentId}|${month}`;
      if (this.existing.has(key)) return { rows: [], rowCount: 0 }; // on conflict do nothing
      this.existing.add(key);
      this.insertedKeys.push(key);
      this.insertedRows.push({
        paymentId,
        month,
        dueDate: String(params![2]),
        amount: params![3] == null ? null : Number(params![3]),
        currency: String(params![4]),
        note: params![7] == null ? null : String(params![7]),
      });
      return { rows: [], rowCount: 1 };
    }
    if (s.includes("into public.audit_logs")) {
      this.audits.push({
        action: String(params![1]),
        after: JSON.parse(String(params![5])) as AuditCall["after"],
      });
      return { rows: [{ id: `audit-${this.audits.length}` }], rowCount: 1 };
    }
    if (s.includes("from public.settings")) return { rows: [], rowCount: 0 };
    if (s.includes("from public.cashflow_months")) return { rows: [], rowCount: 0 };
    if (s.includes("from public.accounting_periods")) return { rows: [], rowCount: 0 };
    // Risk tazeleme penceresi: bu testlerde boş, çünkü ölçülen şey risk mantığı değil.
    if (s.includes("from public.payment_instances")) return { rows: [], rowCount: 0 };
    if (s.includes("update public.payment_instances")) return { rows: [], rowCount: 0 };

    throw new Error(`Sahte client beklenmeyen SQL gördü: ${s.slice(0, 120)}`);
  };

  asClient(): PoolClient {
    return { query: this.query, release: () => {} } as unknown as PoolClient;
  }

  asPool(): Pool {
    return { query: this.query, connect: async () => this.asClient() } as unknown as Pool;
  }
}

const PAYMENTS = [
  { id: "p1", due_day: 5 },
  { id: "p2", due_day: 12 },
  { id: "p3", due_day: 20 },
];

describe("generate_instances denetim kaydı", () => {
  it("CASE A — hiçbir şey üretilmediğinde denetim satırı YAZILMAZ", async () => {
    const month = "2027-03-01";
    const db = new FakeDb(PAYMENTS, PAYMENTS.map((p) => [p.id, month] as [string, string]));

    const result = await generateInstancesForMonthWithClient(db.asClient(), month, ACTOR);

    expect(result.created).toBe(0);
    expect(result.skippedExisting).toBe(3);
    expect(db.insertedKeys).toEqual([]); // iş verisi mutasyonu yok
    expect(db.audits).toEqual([]); // ve denetim satırı da yok — P1'in tam konusu
  });

  it("CASE B — gerçek üretim olduğunda denetim kaydı ve payload'ı KORUNUR", async () => {
    const month = "2027-03-01";
    const db = new FakeDb(PAYMENTS);

    const result = await generateInstancesForMonthWithClient(db.asClient(), month, ACTOR);

    expect(result.created).toBe(3);
    expect(db.insertedKeys).toHaveLength(3);
    expect(db.audits).toHaveLength(1);
    expect(db.audits[0].action).toBe("generate_instances");
    expect(db.audits[0].after).toEqual({ monthStart: month, created: 3, total: 3 });
  });

  it("CASE C — pencere tamamen doluyken ensureWindow 26 ayı gezer ama HİÇ denetim yazmaz", async () => {
    const today = "2026-09-15";
    const m0 = "2026-09-01";
    const months = Array.from({ length: 26 }, (_, i) => addMonths(m0, i - 1));
    const existing = months.flatMap((m) => PAYMENTS.map((p) => [p.id, m] as [string, string]));
    const db = new FakeDb(PAYMENTS, existing);

    const results = await ensureWindow(db.asPool(), today, ACTOR, 24);

    expect(results).toHaveLength(26); // ufuk değişmedi
    expect(db.monthsAttempted).toEqual(months); // 26 ayın hepsi gerçekten denendi
    expect(db.insertedKeys).toEqual([]); // iş verisi mutasyonu yok
    expect(db.audits).toEqual([]); // eskiden burada 26 satır vardı
  });

  it("CASE D — yalnız bir ay eksikse SADECE o ay için tek denetim satırı yazılır", async () => {
    const today = "2026-09-15";
    const m0 = "2026-09-01";
    const months = Array.from({ length: 26 }, (_, i) => addMonths(m0, i - 1));
    const missing = months[months.length - 1]; // pencerenin son ayı
    const existing = months
      .filter((m) => m !== missing)
      .flatMap((m) => PAYMENTS.map((p) => [p.id, m] as [string, string]));
    const db = new FakeDb(PAYMENTS, existing);

    await ensureWindow(db.asPool(), today, ACTOR, 24);

    expect(db.insertedKeys).toEqual(PAYMENTS.map((p) => `${p.id}|${missing}`));
    expect(db.audits).toHaveLength(1);
    expect(db.audits[0].after).toEqual({ monthStart: missing, created: 3, total: 3 });
  });

  it("CASE E — M-14 döviz cinsi (USD/EUR) ve haftalık / çeyreklik / yıllık / tek seferlik sıklık matematiğini korur", async () => {
    const seeds: FakePaymentSeed[] = [
      { id: "usd-weekly", due_day: 1, default_amount: "250.50", currency: "USD", recurrence_type: "weekly" },
      { id: "eur-quarterly", due_day: 15, due_date: "2027-01-15", default_amount: "1200", currency: "EUR", recurrence_type: "irregular", source_notes: "freq:quarterly" },
      { id: "usd-yearly", due_day: 10, due_date: "2026-04-10", default_amount: "5000", currency: "USD", recurrence_type: "yearly" },
      { id: "eur-oneoff", due_day: null, due_date: "2027-04-22", default_amount: "850", currency: "EUR", recurrence_type: "one_off" },
    ];
    const db = new FakeDb(seeds);

    // 2027-04-01:
    // - usd-weekly (due_day=1 -> days 1,8,15,22,29 = 5 weeks in 30-day April -> 250.50 * 5 = 1252.5)
    // - eur-quarterly (2027-01 -> 2027-04 is +3 months -> eligible!)
    // - usd-yearly (2026-04 -> 2027-04 is +12 months -> eligible!)
    // - eur-oneoff (due_date 2027-04-22 -> eligible!)
    const apr = await generateInstancesForMonthWithClient(db.asClient(), "2027-04-01", ACTOR);
    expect(apr.created).toBe(4);
    expect(db.insertedRows).toEqual([
      { paymentId: "usd-weekly", month: "2027-04-01", dueDate: "2027-04-01", amount: 1252.5, currency: "USD", note: "weekly_x5" },
      { paymentId: "eur-quarterly", month: "2027-04-01", dueDate: "2027-04-15", amount: 1200, currency: "EUR", note: "quarterly" },
      { paymentId: "usd-yearly", month: "2027-04-01", dueDate: "2027-04-10", amount: 5000, currency: "USD", note: "yearly" },
      { paymentId: "eur-oneoff", month: "2027-04-01", dueDate: "2027-04-22", amount: 850, currency: "EUR", note: null },
    ]);

    // 2027-05-01: only usd-weekly is eligible (days 1,8,15,22,29 = 5 weeks in 31-day May)
    const may = await generateInstancesForMonthWithClient(db.asClient(), "2027-05-01", ACTOR);
    expect(may.created).toBe(1);
    expect(db.insertedRows[4]).toEqual({
      paymentId: "usd-weekly",
      month: "2027-05-01",
      dueDate: "2027-05-01",
      amount: 1252.5,
      currency: "USD",
      note: "weekly_x5",
    });
  });
});
