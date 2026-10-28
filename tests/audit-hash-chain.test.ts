import { describe, it, expect } from "vitest";
import {
  buildHashChain,
  verifyAuditChain,
  canonicalStringify,
  type RawAuditEntry,
} from "@/lib/audit/hash-chain";

describe("Faz 5: Değiştirilemez Kriptografik Denetim İzi (Hash Chain Audit)", () => {
  const sampleEntries: RawAuditEntry[] = [
    {
      id: "log-1",
      actor: "user-1",
      action: "create_payment",
      entityTable: "payments",
      entityId: "pay-100",
      before: null,
      after: { amount: 150000, recipient: "Atlas Dağıtım" },
      createdAt: "2026-10-17T10:00:00.000Z",
    },
    {
      id: "log-2",
      actor: "user-2",
      action: "approve_payment",
      entityTable: "approvals",
      entityId: "app-200",
      before: { status: "pending" },
      after: { status: "approved" },
      createdAt: "2026-10-17T10:15:00.000Z",
    },
    {
      id: "log-3",
      actor: "user-3",
      action: "reconcile_bank_transaction",
      entityTable: "bank_transactions",
      entityId: "txn-300",
      before: null,
      after: { matchedInvoiceId: "inv-500" },
      createdAt: "2026-10-17T11:00:00.000Z",
    },
  ];

  it("canonicalStringify anahtar sırasından bağımsız olarak deterministik çıktı üretir", () => {
    const a = { b: 2, a: 1, c: { y: 20, x: 10 } };
    const b = { a: 1, c: { x: 10, y: 20 }, b: 2 };
    expect(canonicalStringify(a)).toBe(canonicalStringify(b));
  });

  it("temiz denetim zincirini kusursuz olarak doğrular", () => {
    const chain = buildHashChain(sampleEntries);
    expect(chain).toHaveLength(3);
    expect(chain[0].previousHash).toMatch(/^0{64}$/);
    expect(chain[1].previousHash).toBe(chain[0].currentHash);
    expect(chain[2].previousHash).toBe(chain[1].currentHash);

    const verification = verifyAuditChain(chain);
    expect(verification.isValid).toBe(true);
    expect(verification.verifiedCount).toBe(3);
    expect(verification.tamperedSequenceNo).toBeNull();
    expect(verification.verdictMessage).toContain("KUSURSUZ DENETİM İZİ");
  });

  it("veritabanında bir satır sonradan tahrif edilmişse (tampering) anında tespit eder", () => {
    const chain = buildHashChain(sampleEntries);

    // Saldırgan 1. satırdaki ödeme tutarını 150.000'den 500.000'e değiştiriyor
    (chain[0].after as any).amount = 500000;

    const verification = verifyAuditChain(chain);
    expect(verification.isValid).toBe(false);
    expect(verification.tamperedSequenceNo).toBe(1);
    expect(verification.tamperedEntryId).toBe("log-1");
    expect(verification.verdictMessage).toContain("TAHRİFAT (TAMPERING) TESPİT EDİLDİ");
  });

  it("araya sahte satır eklendiğinde veya satır silindiğinde zincir kopukluğunu tespit eder", () => {
    const chain = buildHashChain(sampleEntries);

    // 2. satır silinmiş olsun (log-1'den sonra doğrudan log-3 geliyor)
    const brokenChain = [chain[0], chain[2]];

    const verification = verifyAuditChain(brokenChain);
    expect(verification.isValid).toBe(false);
    expect(verification.tamperedSequenceNo).toBe(3); // log-3 satır 2'de ama sequenceNo 3
    expect(verification.verdictMessage).toContain("KOPUKLUK TESPİT EDİLDİ");
  });
});
