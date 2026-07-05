// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  ChecksPreview,
  MonthlyCashflowPreviewView,
  PaymentMatrixPreview,
} from "./previews";

describe("PaymentMatrixPreview", () => {
  it("renders candidates with flag badges; unlabeled amount marked", () => {
    render(
      <PaymentMatrixPreview
        candidates={[
          { rowIndex: 3, name: "MAS ELEKTRİK", dueDay: 3, amountCandidate: null, amountSource: null, flags: [] },
          { rowIndex: 16, name: "MAS TELEFON TİJEN", dueDay: 22, amountCandidate: -60000, amountSource: "ag", flags: ["negative_amount"] },
          { rowIndex: 25, name: null, dueDay: null, amountCandidate: 120000, amountSource: "ag", flags: ["unlabeled_amount"] },
        ]}
        issues={[{ rowIndex: 25, issue_type: "unlabeled_amount", severity: "high", message: "Etiketsiz tutar" }]}
      />,
    );
    expect(screen.getByText("MAS ELEKTRİK")).toBeDefined();
    expect(screen.getByText("3. gün")).toBeDefined();
    expect(screen.getAllByText("negative_amount").length).toBe(1);
    expect(screen.getByText("ETİKETSİZ")).toBeDefined();
    expect(screen.getByText("temiz")).toBeDefined(); // clean row badge
  });
});

describe("MonthlyCashflowPreviewView", () => {
  it("shows identity badge and groups; negative bank balance rendered without anomaly badge", () => {
    render(
      <MonthlyCashflowPreviewView
        data={{
          monthStart: "2026-05-01",
          opening: 0, income: 1500000, expense: 1400000, delta: 100000, closing: 100000,
          identityHolds: true,
          lines: [
            { rowIndex: 3, line_type: "customer_income", direction: "inflow", label: "akon", amount: 800000 },
            { rowIndex: 4, line_type: "bank_balance", direction: "balance", label: "HESAP halk", amount: -135000 },
          ],
          issues: [],
        }}
      />,
    );
    expect(screen.getByText(/kasa = devir \+ gelir − gider/)).toBeDefined();
    expect(screen.getByText("akon")).toBeDefined();
    expect(screen.getByText("HESAP halk")).toBeDefined();
    expect(screen.queryByText("negative_amount")).toBeNull();
  });
});

describe("ChecksPreview", () => {
  it("direction badges and duplicate flags render", () => {
    render(
      <ChecksPreview
        candidates={[
          { rowIndex: 3, maturityDate: "2026-07-31", serial: null, payee: "AKR", payer: null, bank: "DENIZ", signedAmount: -45000, direction: "outflow", flags: ["duplicate_check"] },
          { rowIndex: 5, maturityDate: "2026-09-19", serial: null, payee: "MAS", payer: null, bank: "VINOV", signedAmount: 75000, direction: "inflow", flags: [] },
        ]}
        issues={[]}
      />,
    );
    expect(screen.getByText("outflow")).toBeDefined();
    expect(screen.getByText("inflow")).toBeDefined();
    expect(screen.getByText("duplicate_check")).toBeDefined();
  });
});
