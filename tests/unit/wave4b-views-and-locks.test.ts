import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  PERIOD_LOCKED_USER_MESSAGE,
  isHandledActionError,
  isPeriodLockTriggerError,
  isPgPeriodLockedError,
  toUserActionErrorMessage,
  translatePeriodLockError,
} from "@/lib/cashflow/period-lock";
import { DomainError } from "@/lib/domain-error";

const ROOT = process.cwd();
const readSrc = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

describe("Wave 4B — F-35 dönem kilidi hata çevirisi birim testleri", () => {
  it("isPgPeriodLockedError P0001 period_locked ve sarmalanmış period_locked mesajlarını tanır", () => {
    const pgErr = Object.assign(new Error("period_locked: 2026-08 ayı kilitlidir"), {
      code: "P0001",
    });
    const wrappedErr = new Error("DB hatası -> period_locked: 2026-08 dönemi kilitli");
    const otherRaise = Object.assign(new Error("custom_business_rule_failed"), {
      code: "P0001",
    });
    const uniqueViolation = Object.assign(new Error("duplicate key value"), {
      code: "23505",
    });

    expect(isPgPeriodLockedError(pgErr)).toBe(true);
    expect(isPgPeriodLockedError(wrappedErr)).toBe(true);
    expect(isPgPeriodLockedError(otherRaise)).toBe(false);
    expect(isPgPeriodLockedError(uniqueViolation)).toBe(false);
    expect(isPgPeriodLockedError(null)).toBe(false);
    expect(isPgPeriodLockedError("period_locked")).toBe(false);
  });

  it("translatePeriodLockError tüm PostgreSQL dönem kilidi tetikleyicilerini DomainError'a çevirir", () => {
    const pgLocked = Object.assign(new Error("period_locked: 2026-09 kapalı"), { code: "P0001" });
    expect(() => translatePeriodLockError(pgLocked)).toThrowError(
      new DomainError("CONFLICT", PERIOD_LOCKED_USER_MESSAGE),
    );

    const pgManager = Object.assign(new Error("period_lock_requires_manager: operator"), {
      code: "42501",
    });
    expect(isPeriodLockTriggerError(pgManager)).toBe(true);
    expect(() => translatePeriodLockError(pgManager)).toThrowError(
      new DomainError(
        "FORBIDDEN",
        "Dönem kilitleme ve kilit açma yetkisi yalnız Finans Yöneticisi veya Yöneticiye aittir.",
      ),
    );

    const pgReason = Object.assign(new Error("period_reopen_reason_required"), {
      code: "23514",
    });
    expect(isPeriodLockTriggerError(pgReason)).toBe(true);
    expect(() => translatePeriodLockError(pgReason)).toThrowError(
      new DomainError(
        "VALIDATION",
        "Dönem kilidini açmak için en az 10 karakterlik gerekçe zorunludur.",
      ),
    );

    const pgTarget = Object.assign(new Error("period_reopen_target_invalid"), {
      code: "23514",
    });
    expect(isPeriodLockTriggerError(pgTarget)).toBe(true);
    expect(() => translatePeriodLockError(pgTarget)).toThrowError(
      new DomainError("VALIDATION", "Kilitli dönem yalnız incelendi (reviewed) durumuna açılabilir."),
    );

    const existingDomain = new DomainError("NOT_FOUND", "Kayıt yok.");
    expect(() => translatePeriodLockError(existingDomain)).toThrow(existingDomain);

    const rawNetwork = new Error("ECONNRESET");
    expect(isPeriodLockTriggerError(rawNetwork)).toBe(false);
    expect(() => translatePeriodLockError(rawNetwork)).toThrow(rawNetwork);
  });

  it("toUserActionErrorMessage ve isHandledActionError dönem kilidi, DomainError, ZodError ve NEXT_REDIRECT ayrımını korur", () => {
    const pgLocked = Object.assign(new Error("period_locked: 2026-07"), { code: "P0001" });
    expect(isHandledActionError(pgLocked)).toBe(true);
    expect(toUserActionErrorMessage(pgLocked, "Yedek hata")).toBe(PERIOD_LOCKED_USER_MESSAGE);

    const domainErr = new DomainError("VALIDATION", "Tutar sıfırdan büyük olmalı.");
    expect(isHandledActionError(domainErr)).toBe(true);
    expect(toUserActionErrorMessage(domainErr, "Yedek hata")).toBe("Tutar sıfırdan büyük olmalı.");

    const parsed = z.object({ amount: z.number().positive("Pozitif olmalı") }).safeParse({ amount: -5 });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(isHandledActionError(parsed.error)).toBe(true);
      expect(toUserActionErrorMessage(parsed.error, "Yedek hata")).toContain("Pozitif olmalı");
    }

    const nextRedirectErr = Object.assign(new Error("NEXT_REDIRECT"), {
      digest: "NEXT_REDIRECT;replace;/cashflow;307;",
    });
    expect(isHandledActionError(nextRedirectErr)).toBe(false);
    expect(isPgPeriodLockedError(nextRedirectErr)).toBe(false);
    expect(toUserActionErrorMessage(nextRedirectErr, "İşlem başarısız.")).toBe("İşlem başarısız.");
  });
});

describe("Wave 4B — F-35, F-37, F-38, F-41, F-43, F-44 bağlantı sözleşmesi doğrulamaları", () => {
  it("F-35: 6 hedef server action dosyası da dönem kilidi hata çevirisini bağlar", () => {
    const actionFiles = [
      "src/app/(dashboard)/cashflow/actions.ts",
      "src/app/(dashboard)/cashflow/13-week/actions.ts",
      "src/app/(dashboard)/cashflow/budget/actions.ts",
      "src/app/(dashboard)/finance/actions.ts",
      "src/app/(dashboard)/finance/invoices/actions.ts",
      "src/app/(dashboard)/finance/ledger/actions.ts",
    ];
    for (const rel of actionFiles) {
      const src = readSrc(rel);
      expect(src, `${rel} isPgPeriodLockedError içermeli`).toContain("isPgPeriodLockedError");
      expect(src, `${rel} toUserActionErrorMessage içermeli`).toContain("toUserActionErrorMessage");
    }
  });

  it("F-37 & F-44: alacaklar ve karşı taraflar sayfaları proposeAllocation, loadCurrentAccountLedger, invoice_party_summary ve collection_allocations bağlar", () => {
    const recPage = readSrc("src/app/(dashboard)/finance/receivables/page.tsx");
    const recActions = readSrc("src/app/(dashboard)/finance/receivables/actions.ts");
    const cpPage = readSrc("src/app/(dashboard)/finance/counterparties/page.tsx");

    expect(recPage).toContain("proposeAllocation");
    expect(recActions).toContain("proposeAllocation");
    expect(recPage).toContain("public.invoice_party_summary");
    expect(recPage).toContain("public.collection_allocations");
    expect(cpPage).toContain("loadCurrentAccountLedger");
  });

  it("F-38: bütçe ve kontroller ekranları recordActual, setLineVersion ve budget_variance_summary bağlar", () => {
    const budgetEngine = readSrc("src/lib/budget/engine.ts");
    const budgetActions = readSrc("src/app/(dashboard)/cashflow/budget/actions.ts");
    const budgetPage = readSrc("src/app/(dashboard)/cashflow/budget/page.tsx");
    const controlsPage = readSrc("src/app/(dashboard)/cashflow/controls/page.tsx");

    expect(budgetEngine).toContain("public.budget_variance_summary");
    expect(budgetActions).toContain("recordActual");
    expect(budgetActions).toContain("setLineVersion");
    expect(budgetPage).toContain("recordActualAction");
    expect(budgetPage).toContain("setLineVersionAction");
    expect(budgetPage).toContain("loadBudgetVarianceSummary");
    expect(controlsPage).toContain("loadBudgetVarianceSummary");
  });

  it("F-41 & F-44: ödeme detayı, fatura merkezi ve sistem kontrolleri kanıt belgeleri ile BEC/fazla ödeme görünümlerini bağlar", () => {
    const paymentDetail = readSrc("src/app/(dashboard)/payments/[paymentId]/edit/page.tsx");
    const invoicesPage = readSrc("src/app/(dashboard)/finance/invoices/page.tsx");
    const systemControls = readSrc("src/app/(dashboard)/system/controls/page.tsx");

    expect(paymentDetail).toContain("documentsForEntity");
    expect(paymentDetail).toContain("/data/documents");
    expect(invoicesPage).toContain("documentsForEntity");
    expect(invoicesPage).toContain("public.invoice_overpaid");
    expect(systemControls).toContain("public.iban_shared_across_parties");
    expect(systemControls).toContain("public.invoice_overpaid");
  });

  it("F-43: CFO SQL görünümleri 13-week, finance ve maturities sayfalarına bağlanmıştır", () => {
    const rolling13w = readSrc("src/app/(dashboard)/cashflow/13-week/page.tsx");
    const financeSummary = readSrc("src/app/(dashboard)/finance/page.tsx");
    const maturities = readSrc("src/app/(dashboard)/finance/maturities/page.tsx");

    expect(rolling13w).toContain("public.forecast_13w_variance_v");
    expect(financeSummary).toContain("public.working_capital_monthly_v");
    expect(maturities).toContain("public.debt_maturity_ladder_by_currency");
  });
});
