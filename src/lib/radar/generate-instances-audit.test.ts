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

class FakeDb {
  readonly audits: AuditCall[] = [];
  readonly insertedKeys: string[] = [];
  readonly monthsAttempted: string[] = [];
  private readonly existing: Set<string>;

  constructor(
    private readonly payments: Array<{ id: string; due_day: number }>,
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

    if (s.startsWith("begin") || s.startsWith("commit") || s.startsWith("rollback")) {
      return { rows: [], rowCount: 0 };
    }
    if (s.includes("select current_user")) {
      return { rows: [{ current_user: MAINTENANCE_ROLE }], rowCount: 1 };
    }
    if (s.includes("from public.payments")) {
      const rows = this.payments.map((p) => ({
        id: p.id,
        due_day: p.due_day,
        default_amount: "1000",
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
      return { rows: [], rowCount: 1 };
    }
    if (s.includes("insert into public.audit_logs")) {
      this.audits.push({
        action: String(params![1]),
        after: JSON.parse(String(params![5])) as AuditCall["after"],
      });
      return { rows: [{ id: `audit-${this.audits.length}` }], rowCount: 1 };
    }
    if (s.includes("from public.settings")) return { rows: [], rowCount: 0 };
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
});
