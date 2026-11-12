// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import React, { Suspense } from "react";
import { renderToPipeableStream } from "react-dom/server";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PanelSkeleton } from "@/components/ui/panel-skeleton";

describe("Faz 6 — Sayfa içi bölümlerde <Suspense> ile aşamalı akış (lazy streaming)", () => {
  it("PanelSkeleton erişilebilir aria-busy ve panel başlığı ile iskelet satırlarını üretir", () => {
    const { container } = render(
      <PanelSkeleton title="RİSKLİ GÜNLER — 30 GÜN UFKU" subtitle="yükleniyor" rows={4} />,
    );
    const skeleton = screen.getByTestId("panel-skeleton");
    expect(skeleton.getAttribute("aria-busy")).toBe("true");
    expect(skeleton.textContent).toContain("RİSKLİ GÜNLER — 30 GÜN UFKU");
    expect(container.querySelectorAll(".animate-pulse")).toHaveLength(4);
  });

  it("ilk HTML parçası yavaş alt sorgu bitmeden önce ana KPI'ları ve PanelSkeleton'ı tarayıcıya akıtır", async () => {
    let releaseSlowSection!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseSlowSection = resolve;
    });

    let resolved = false;
    function SlowSecondaryPanel() {
      if (!resolved) {
        throw gate.then(() => {
          resolved = true;
        });
      }
      return <div data-testid="streamed-panel">Aksiyon listesi hazır</div>;
    }

    const chunks: string[] = [];
    const out = new PassThrough();
    out.on("data", (buf: Buffer) => {
      chunks.push(buf.toString("utf8"));
    });

    const allDone = new Promise<void>((resolve, reject) => {
      const { pipe } = renderToPipeableStream(
        <div>
          <header data-testid="instant-kpi">20 saniyede cevap: 15.000 TL</header>
          <Suspense fallback={<PanelSkeleton title="Bugün yapılacaklar" rows={3} />}>
            <SlowSecondaryPanel />
          </Suspense>
        </div>,
        {
          onShellReady() {
            pipe(out);
          },
          onAllReady() {
            resolve();
          },
          onError(err) {
            reject(err);
          },
        },
      );
    });

    // Shell flush olduğunda yavaş sorgu hâlâ bekliyor olmalı:
    await new Promise((r) => setTimeout(r, 20));
    const initialHtml = chunks.join("");
    expect(initialHtml).toContain("20 saniyede cevap: 15.000 TL");
    expect(initialHtml).toContain('data-testid="panel-skeleton"');
    expect(initialHtml).not.toContain("Aksiyon listesi hazır");

    // Yavaş bölüm tamamlandığında ikinci parça stream üzerinden tamamlanır:
    releaseSlowSection();
    await allDone;
    const fullHtml = chunks.join("");
    expect(fullHtml).toContain("Aksiyon listesi hazır");
  });

  it("Ana Ekran, Ödemeler Özeti ve Fatura Merkezi ikincil bölümleri <Suspense> + PanelSkeleton ile sarar", () => {
    const homeSrc = readFileSync(join(process.cwd(), "src/app/(dashboard)/page.tsx"), "utf8");
    const paymentsSrc = readFileSync(
      join(process.cwd(), "src/app/(dashboard)/payments/page.tsx"),
      "utf8",
    );
    const invoicesSrc = readFileSync(
      join(process.cwd(), "src/app/(dashboard)/finance/invoices/page.tsx"),
      "utf8",
    );

    expect(homeSrc).toContain("<Suspense");
    expect(homeSrc).toContain("PanelSkeleton");
    expect(homeSrc).toContain("<OverviewSecondarySection");

    expect(paymentsSrc).toContain("<Suspense");
    expect(paymentsSrc).toContain("PanelSkeleton");
    expect(paymentsSrc).toContain("<PaymentsDashboardContent");
    expect(paymentsSrc).not.toContain("monthInstances(");

    expect(invoicesSrc).toContain("<Suspense");
    expect(invoicesSrc).toContain("PanelSkeleton");
    expect(invoicesSrc).toContain("<InvoicesQualityPanels");
    expect(invoicesSrc).toContain("<InvoicesBottomSection");
  });
});

