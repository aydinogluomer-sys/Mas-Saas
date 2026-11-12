// @vitest-environment jsdom
import { existsSync } from "node:fs";
import path from "node:path";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  getPool: vi.fn(),
  withReadConnection: vi.fn(),
}));

const prefetch = vi.fn();
const push = vi.fn();
const router = { prefetch, push };
const searchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  usePathname: () => "/finance",
  useSearchParams: () => searchParams,
  useRouter: () => router,
}));

vi.mock("@/app/(dashboard)/payments/actions", () => ({
  archivePaymentAction: vi.fn(async () => {}),
}));

import nextConfig from "../../next.config";
import { formatForeignCurrencyBadges, formatMoney, normalizeCurrencyLabel } from "@/lib/money-format";
import { remainingOpenAmount } from "@/lib/radar/rules";
import { computeKnownOutflow } from "@/lib/home/overview-snapshot";
import { loadCanonicalKpis } from "@/lib/metrics/canonical-kpis";
import { tabsFor } from "@/lib/authz/matrix";
import { NavigationFeedbackProvider } from "@/components/ui/navigation-feedback";
import { AppSidebar, type NavItem } from "@/components/ui/nav";
import { ModuleFrame, type ModuleTab } from "@/components/ui/module-tabs";
import { CommandPaletteTrigger } from "@/components/search/command-palette-trigger";
import { PaymentFormFields } from "@/components/radar/payment-form";

const SAMPLE_NAV: NavItem[] = [
  { href: "/", label: "Genel Bakış", description: "Bugünkü nakit ve öncelikler", icon: "overview" },
  { href: "/payments", label: "Ödemeler", description: "Ödeme listesi ve durumlar", icon: "payments" },
  { href: "/finance", label: "Finansman", description: "Banka, fatura, çek ve kredi", icon: "finance" },
];

const FINANCE_TABS: ModuleTab[] = [
  { href: "/finance", label: "Özet", group: "Hazine & Banka" },
  { href: "/finance/treasury", label: "Hazine", group: "Hazine & Banka" },
  { href: "/finance/bank", label: "Banka", group: "Hazine & Banka" },
  { href: "/finance/fx", label: "Kur riski", group: "Hazine & Banka" },
  { href: "/finance/calendar", label: "Finansal takvim", group: "Hazine & Banka" },
  { href: "/finance/invoices", label: "Faturalar", group: "Alacak & Tahsilat" },
  { href: "/finance/receivables", label: "Alacak/Borç", group: "Alacak & Tahsilat" },
  { href: "/finance/collections", label: "Tahsilat riski", group: "Alacak & Tahsilat" },
  { href: "/finance/promises", label: "Ödeme sözleri", group: "Alacak & Tahsilat" },
  { href: "/finance/counterparties", label: "Karşı taraflar", group: "Alacak & Tahsilat" },
  { href: "/finance/checks", label: "Çekler", group: "Borç, Çek & Kredi" },
  { href: "/finance/loans", label: "Krediler", group: "Borç, Çek & Kredi" },
  { href: "/finance/facilities", label: "Kredi limitleri", group: "Borç, Çek & Kredi" },
  { href: "/finance/maturities", label: "Vade takvimi", group: "Borç, Çek & Kredi" },
  { href: "/finance/exposure", label: "Maruziyet", group: "Borç, Çek & Kredi" },
  { href: "/finance/profitability", label: "Kârlılık", group: "Defter & Kârlılık" },
  { href: "/finance/archive", label: "Arşiv", group: "Defter & Kârlılık" },
];

const SYSTEM_TABS: ModuleTab[] = [
  { href: "/system", label: "Durum" },
  { href: "/system/backup", label: "Yedekleme" },
  { href: "/system/audit", label: "Denetim kayıtları" },
  { href: "/system/controls", label: "Kontrol merkezi" },
  { href: "/system/jobs", label: "Arka plan işleri" },
  { href: "/system/archive", label: "Arşiv Merkezi" },
  { href: "/system/security", label: "Erişim ve güvenlik" },
  { href: "/system/diagnostics", label: "Tanılama" },
  { href: "/system/features", label: "Özellik haritası" },
];

beforeEach(() => {
  window.history.replaceState({}, "", "/finance");
  prefetch.mockClear();
  push.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("Faz 47 (D1) — Döviz-Duyarlı formatMoney & Kalan Tutar Sözleşmesi", () => {
  it("formatMoney BLANK ≠ ZERO ve para birimi kurallarına tam uyar (asla yabancı paraya TL basmaz)", () => {
    expect(formatMoney(null, "TRY")).toBe("—");
    expect(formatMoney(undefined, "USD")).toBe("—");
    expect(formatMoney("", "EUR")).toBe("—");
    expect(formatMoney(12345.67, "TRY")).toBe("12.345,67 TL");
    expect(formatMoney("12345.67", "TL")).toBe("12.345,67 TL");
    expect(formatMoney(12345.67, "USD")).toBe("12.345,67 USD");
    expect(formatMoney(12345.67, "EUR")).toBe("12.345,67 EUR");
    expect(formatMoney(12345.67, null)).toBe("12.345,67 (PB?)");
    expect(formatMoney(12345.67, "   ")).toBe("12.345,67 (PB?)");
    expect(normalizeCurrencyLabel("gbp")).toBe("GBP");
    expect(
      formatForeignCurrencyBadges([
        { currency: "USD", total: 2500, count: 2 },
        { currency: "EUR", total: null, count: 1 },
      ]),
    ).toBe("+ 2.500,00 USD (2) · 1 EUR (belirsiz)");
  });

  it("remainingOpenAmount ve computeKnownOutflow partial ödemelerde yalnız kalan tutarı sayar", () => {
    expect(remainingOpenAmount(100_000, 40_000, "partial")).toBe(60_000);
    expect(remainingOpenAmount(null, 0, "unpaid")).toBeNull();
    expect(remainingOpenAmount(100_000, 100_000, "paid")).toBe(0);
    expect(remainingOpenAmount(100_000, 0, "cancelled")).toBe(0);

    const outflow = computeKnownOutflow([
      { amount: 100_000, paidAmount: 40_000, status: "partial", currency: "TRY" },
      { amount: null, paidAmount: 0, status: "unpaid", currency: "TRY" },
      { amount: 5_000, paidAmount: 0, status: "unpaid", currency: "USD" },
    ]);
    expect(outflow.total).toBe(60_000);
    expect(outflow.count).toBe(3);
    expect(outflow.missing).toBe(1);
    expect(outflow.foreign).toBe(1);
  });

  it("loadCanonicalKpis TRY ve yabancı para kovalarını ayırır, FIN-03 belirsiz açılış bakiyesinde null döner", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("from public.treasury_position_summary")) {
        return {
          rows: [
            { currency: "TRY", account_count: 2, unknown_opening_count: 1, available_now: null },
            { currency: "USD", account_count: 1, unknown_opening_count: 0, available_now: "15000.50" },
          ],
        };
      }
      if (sql.includes("from public.receivables_open")) {
        return {
          rows: [
            { currency: "TRY", total_open: "240000.00", item_count: 4, overdue_count: 1, overdue_open: "50000.00" },
            { currency: "EUR", total_open: "12000.00", item_count: 2, overdue_count: 0, overdue_open: "0" },
          ],
        };
      }
      if (sql.includes("from public.payables_open")) {
        return {
          rows: [
            { currency: "TRY", total_open: "85000.00", item_count: 3, overdue_count: 0, overdue_open: "0" },
          ],
        };
      }
      return {
        rows: [
          { currency: "TRY", open_count: 2, missing_count: 0, remaining_sum: "60000.00" },
        ],
      };
    });

    const snapshot = await loadCanonicalKpis({ query } as never, "2026-11-01");
    expect(snapshot.treasuryCash.availableNowTry).toBeNull();
    expect(snapshot.treasuryCash.unknownOpeningCountTry).toBe(1);
    expect(snapshot.treasuryCash.foreignBuckets[0]?.availableNow).toBe(15000.5);
    expect(snapshot.openReceivables.tryTotal).toBe(240000);
    expect(snapshot.openReceivables.foreignBuckets).toEqual([{ currency: "EUR", total: 12000, count: 2 }]);
    expect(snapshot.outflow7d.tryRemainingTotal).toBe(60000);
  });
});

describe("Faz 47 (D1) — Tekil Ctrl+K Komut Paleti, Kardeş Ödeme Formları ve 12 Eski Klasör Temizliği", () => {
  it("Ctrl+K ve kenar çubuğu 'Hızlı erişim' düğmesi çift modal açmadan tek kanonik CommandPalette açar", async () => {
    render(
      <NavigationFeedbackProvider>
        <AppSidebar items={SAMPLE_NAV} gate={false} logoutAction={async () => {}} />
        <CommandPaletteTrigger items={SAMPLE_NAV} />
      </NavigationFeedbackProvider>,
    );

    expect(screen.queryAllByRole("dialog")).toHaveLength(0);
    expect(document.querySelector(".command-overlay")).toBeNull();

    await act(async () => {
      fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    });

    const dialog = await screen.findByRole("dialog", { name: "Evrensel arama" });
    expect(dialog).toBeTruthy();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(document.querySelector(".command-overlay")).toBeNull();

    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(screen.queryAllByRole("dialog")).toHaveLength(0);

    const sidebarQuickButton = screen.getByRole("button", { name: /Hızlı erişim/i });
    await act(async () => {
      fireEvent.click(sidebarQuickButton);
    });

    const reopened = await screen.findByRole("dialog", { name: "Evrensel arama" });
    expect(reopened).toBeTruthy();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });

  it("PaymentFormFields düzenleme ve arşivleme formlarını kardeş <form> olarak ayırır; archive_reason Kaydet'i kilitlemez", () => {
    const saveAction = vi.fn(async () => {});
    const { unmount } = render(
      <PaymentFormFields
        action={saveAction}
        values={{ id: "pay-123", name: "MAS Kira" }}
        cats={[]}
        providers={[]}
        owners={[]}
        accounts={[]}
      />,
    );

    const editForm = screen.getByTestId("payment-edit-form");
    const archiveForm = screen.getByTestId("payment-archive-form");

    expect(editForm.tagName).toBe("FORM");
    expect(archiveForm.tagName).toBe("FORM");
    expect(editForm.contains(archiveForm)).toBe(false);
    expect(archiveForm.contains(editForm)).toBe(false);
    expect(editForm.querySelector('[name="archive_reason"]')).toBeNull();

    const archiveReasonInput = archiveForm.querySelector('input[name="archive_reason"]') as HTMLInputElement | null;
    expect(archiveReasonInput).not.toBeNull();
    expect(archiveReasonInput?.required).toBe(true);

    unmount();

    render(
      <PaymentFormFields
        action={saveAction}
        values={{ name: "Yeni Ödeme" }}
        cats={[]}
        providers={[]}
        owners={[]}
        accounts={[]}
      />,
    );
    expect(screen.getByTestId("payment-edit-form")).toBeTruthy();
    expect(screen.queryByTestId("payment-archive-form")).toBeNull();
  });

  it("12 eski gölge rota klasörü kaldırılmıştır ve next.config.ts 308 yönlendirmeleri korunmaktadır", async () => {
    const dashboardRoot = path.join(process.cwd(), "src", "app", "(dashboard)");
    const removedFolders = [
      "overview",
      "admin",
      "ask",
      "assumptions",
      "calendar",
      "data-quality",
      "financing",
      "imports",
      "phases",
      "radar",
      "reminders",
      "reports",
    ];

    for (const folder of removedFolders) {
      expect(existsSync(path.join(dashboardRoot, folder)), `${folder} gölge klasörü silinmiş olmalı`).toBe(false);
    }

    const redirects = await nextConfig.redirects!();
    const map = new Map(redirects.map((r) => [r.source, r]));

    expect(map.get("/overview")?.destination).toBe("/");
    expect(map.get("/overview")?.permanent).toBe(true);
    expect(map.get("/ask")?.destination).toBe("/insights/ask");
    expect(map.get("/reports")?.destination).toBe("/insights/reports");
    expect(map.get("/reminders")?.destination).toBe("/insights/reminders");
    expect(map.get("/assumptions")?.destination).toBe("/data/assumptions");
    expect(map.get("/data-quality")?.destination).toBe("/data/quality");
    expect(map.get("/imports")?.destination).toBe("/data/imports");
    expect(map.get("/financing")?.destination).toBe("/finance");
    expect(map.get("/radar")?.destination).toBe("/payments");
    expect(map.get("/calendar")?.destination).toBe("/payments/calendar");
    expect(map.get("/admin")?.destination).toBe("/system");
    expect(map.get("/phases")?.destination).toBe("/system/features");
  });

  it("/finance 17 sekmesi 4 görünür grup altında sarılır ve /system/diagnostics sekmesi yalnız admin rolüne açılır", () => {
    render(
      <NavigationFeedbackProvider>
        <ModuleFrame
          title="Finansman"
          description="Hazine ve finansman merkezi"
          tabs={tabsFor("finance_operator", FINANCE_TABS)}
        >
          <div>İçerik</div>
        </ModuleFrame>
      </NavigationFeedbackProvider>,
    );

    const nav = screen.getByRole("navigation", { name: "Finansman bölümleri" });
    expect(nav.className).toContain("module-tabs-grouped");

    const groups = screen.getAllByRole("group");
    expect(groups.map((g) => g.getAttribute("aria-label"))).toEqual([
      "Hazine & Banka",
      "Alacak & Tahsilat",
      "Borç, Çek & Kredi",
      "Defter & Kârlılık",
    ]);
    expect(nav.querySelectorAll("a")).toHaveLength(17);

    const adminSystemTabs = tabsFor("admin", SYSTEM_TABS);
    const financeSystemTabs = tabsFor("finance_operator", SYSTEM_TABS);
    expect(adminSystemTabs.some((t) => t.href === "/system/diagnostics")).toBe(true);
    expect(financeSystemTabs.some((t) => t.href === "/system/diagnostics")).toBe(false);
  });
});
