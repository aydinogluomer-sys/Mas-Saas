import Link from "@/components/ui/app-link";
import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { PageHeader } from "@/components/ui/shell";
import {
  CheckBordroWorkbench,
  type BordroCandidateCheck,
} from "@/components/finance/check-bordro-workbench";
import { ChecksTable, type CheckRow } from "@/components/finance/checks-table";
import { requireSession } from "@/lib/auth";
import { can } from "@/lib/authz/matrix";
import { requireRouteAccess } from "@/lib/authz/route-guard";
import { getPool } from "@/lib/db";
import {
  CHECK_BORDRO_TYPE_LABELS_TR,
  istanbulTodayISO,
  loadCheckBordroTargets,
  loadCheckPortfolioSummary,
  loadRecentCheckBordros,
  type CheckPortfolioSummaryRow,
} from "@/lib/financing/check-bordro";
import { countChecks, loadChecks } from "@/lib/financing/engine";
import { formatMoney } from "@/lib/money-format";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 500;

function formatBordroDetail(r: Awaited<ReturnType<typeof loadChecks>>[number]): string | null {
  if (r.status === "endorsed_to_vendor") {
    const parts = [r.endorsedTo ? `Ciro: ${r.endorsedTo}` : "Ciro edildi"];
    if (r.settledInvoiceNo) parts.push(`Fatura: ${r.settledInvoiceNo}`);
    return parts.join(" · ");
  }
  if (r.status === "in_bank_collection" && r.collectionBank) {
    return `Tahsil bankası: ${r.collectionBank}`;
  }
  if (r.status === "in_bank_collateral" && r.collateralFacility) {
    return `Teminat limiti: ${r.collateralFacility}`;
  }
  if (r.status === "issued_to_vendor" && r.settledInvoiceNo) {
    return `Kapattığı fatura: ${r.settledInvoiceNo}`;
  }
  if (r.status === "bounced" && r.endorsedTo) {
    return `Rücu (eski ciro): ${r.endorsedTo}`;
  }
  return null;
}

function summarizeBucket(
  rows: CheckPortfolioSummaryRow[],
  amountField: keyof CheckPortfolioSummaryRow,
  countField: keyof CheckPortfolioSummaryRow,
): { tryAmount: number; totalCount: number; fxBadges: string[] } {
  let tryAmount = 0;
  let totalCount = 0;
  const fxBadges: string[] = [];
  for (const row of rows) {
    const amt = Number(row[amountField] ?? 0);
    const cnt = Number(row[countField] ?? 0);
    totalCount += cnt;
    if (row.currency === "TRY") {
      tryAmount += amt;
    } else if (amt > 0 || cnt > 0) {
      fxBadges.push(`${formatMoney(amt, row.currency)} (${cnt})`);
    }
  }
  return { tryAmount, totalCount, fxBadges };
}

export default async function ChecksPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; flash?: string; error?: string }>;
}) {
  const denied = await requireRouteAccess("/finance/checks");
  if (denied) return denied;
  const session = await requireSession();
  const sp = await searchParams;
  const requestedPage = Number(sp.page ?? "1");
  const page = Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const canOperateBordro = can(session.role, "check_bordros", "insert");
  const canCreateCheck = can(session.role, "checks", "insert");

  const pool = getPool();
  const [rows, total, portfolioSummary, recentBordros, bordroTargets] = await Promise.all([
    loadChecks(pool, { limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
    countChecks(pool),
    loadCheckPortfolioSummary(pool),
    loadRecentCheckBordros(pool, 15),
    canOperateBordro
      ? loadCheckBordroTargets(pool)
      : Promise.resolve({ openPurchaseInvoices: [], bankAccounts: [], creditFacilities: [] }),
  ]);

  const portfolioCard = summarizeBucket(portfolioSummary, "portfolioAmount", "portfolioCount");
  const collectionCard = summarizeBucket(
    portfolioSummary,
    "inCollectionAmount",
    "inCollectionCount",
  );
  const collateralCard = summarizeBucket(
    portfolioSummary,
    "inCollateralAmount",
    "inCollateralCount",
  );
  const collateralLtvTry = portfolioSummary
    .filter((r) => r.currency === "TRY")
    .reduce((acc, r) => acc + r.collateralBorrowingValue, 0);
  const recourseCard = summarizeBucket(
    portfolioSummary,
    "contingentRecourseAmount",
    "endorsedRecourseCount",
  );
  const bouncedRecourseCard = summarizeBucket(
    portfolioSummary,
    "bouncedRecourseAmount",
    "bouncedRecourseCount",
  );
  const ownIssuedCard = summarizeBucket(portfolioSummary, "ownIssuedAmount", "ownIssuedCount");

  const data: CheckRow[] = rows.map((r) => ({
    id: r.id,
    maturityDate: r.maturityDate,
    direction: r.direction,
    instrumentType: r.instrumentType,
    counterparty: r.payee ?? r.payer ?? "—",
    bank: r.bank ?? null,
    serial: r.serial ?? null,
    amount: r.amount,
    currency: r.currency ?? "TRY",
    status: r.status,
    bordroDetail: formatBordroDetail(r),
    lastBordroNo: r.lastBordroNo,
  }));

  const bordroCandidates: BordroCandidateCheck[] = rows
    .filter((r) => !["cleared", "cancelled", "returned"].includes(r.status))
    .map((r) => ({
      id: r.id,
      maturityDate: r.maturityDate,
      direction: r.direction,
      instrumentType: r.instrumentType ?? "check",
      counterparty: r.payee ?? r.payer ?? "—",
      serial: r.serial ?? null,
      amount: r.amount,
      currency: r.currency ?? "TRY",
      status: r.status,
    }));

  return (
    <>
      <PageHeader
        title="Çek & Senet Bordrosu"
        subtitle="Portföy, tedarikçiye ciro, banka tahsil, kredi teminat LTV ve karşılıksız rücu riski defteri"
        action={
          canCreateCheck ? (
            <Link href="/finance/checks/new" className="button-accent px-3 py-2">
              Yeni çek / senet
            </Link>
          ) : undefined
        }
      />

      {sp.error ? (
        <div
          role="alert"
          className="mb-4 rounded border border-neg/40 bg-neg/10 px-3 py-2 text-xs text-neg"
        >
          {sp.error}
        </div>
      ) : null}

      {sp.flash ? (
        <div
          role="status"
          className="mb-4 rounded border border-pos/40 bg-pos/10 px-3 py-2 text-xs text-pos"
        >
          {sp.flash === "archived" ? "Kayıt arşive taşındı." : sp.flash}
        </div>
      ) : null}

      {/* 5 Bordro Özeti Kartı (TRY ana toplam + döviz alt rozetleri; kurları çarpmadan asla toplamaz) */}
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <div className="rounded-lg border border-edge bg-surface-1 p-3">
          <div className="text-[11px] font-medium text-tone-3">Portföydeki Çekler</div>
          <div className="mt-1 font-mono text-base font-semibold tabular-nums">
            {formatMoney(portfolioCard.tryAmount, "TRY")}
          </div>
          <div className="mt-1 text-[11px] text-tone-3">{portfolioCard.totalCount} evrak kasada</div>
          {portfolioCard.fxBadges.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {portfolioCard.fxBadges.map((b) => (
                <Badge key={b} tone="blue">
                  {b}
                </Badge>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-lg border border-edge bg-surface-1 p-3">
          <div className="text-[11px] font-medium text-tone-3">Tahsildeki Çekler</div>
          <div className="mt-1 font-mono text-base font-semibold tabular-nums">
            {formatMoney(collectionCard.tryAmount, "TRY")}
          </div>
          <div className="mt-1 text-[11px] text-tone-3">
            {collectionCard.totalCount} evrak bankada tahsilde
          </div>
          {collectionCard.fxBadges.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {collectionCard.fxBadges.map((b) => (
                <Badge key={b} tone="blue">
                  {b}
                </Badge>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-lg border border-edge bg-surface-1 p-3">
          <div className="text-[11px] font-medium text-tone-3">Teminattaki Çekler</div>
          <div className="mt-1 font-mono text-base font-semibold tabular-nums">
            {formatMoney(collateralCard.tryAmount, "TRY")}
          </div>
          <div className="mt-1 text-[11px] text-tone-3">
            {collateralCard.totalCount} evrak · LTV: {formatMoney(collateralLtvTry, "TRY")}
          </div>
          {collateralCard.fxBadges.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {collateralCard.fxBadges.map((b) => (
                <Badge key={b} tone="blue">
                  {b}
                </Badge>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-lg border border-edge bg-surface-1 p-3">
          <div className="text-[11px] font-medium text-tone-3">Ciro Edilen Çek & Rücu Riski</div>
          <div className="mt-1 font-mono text-base font-semibold tabular-nums text-warn">
            {formatMoney(recourseCard.tryAmount, "TRY")}
          </div>
          <div className="mt-1 text-[11px] text-tone-3">
            {recourseCard.totalCount} vadeli ciro (bilanço dışı rücu)
          </div>
          {bouncedRecourseCard.totalCount > 0 && (
            <div className="mt-1">
              <Badge tone="red">
                Karşılıksız rücu: {formatMoney(bouncedRecourseCard.tryAmount, "TRY")} (
                {bouncedRecourseCard.totalCount})
              </Badge>
            </div>
          )}
          {recourseCard.fxBadges.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {recourseCard.fxBadges.map((b) => (
                <Badge key={b} tone="amber">
                  {b}
                </Badge>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-lg border border-edge bg-surface-1 p-3">
          <div className="text-[11px] font-medium text-tone-3">Keşide Borç Çeklerimiz</div>
          <div className="mt-1 font-mono text-base font-semibold tabular-nums">
            {formatMoney(ownIssuedCard.tryAmount, "TRY")}
          </div>
          <div className="mt-1 text-[11px] text-tone-3">
            {ownIssuedCard.totalCount} açık borç çeki/senedi
          </div>
          {ownIssuedCard.fxBadges.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {ownIssuedCard.fxBadges.map((b) => (
                <Badge key={b} tone="amber">
                  {b}
                </Badge>
              ))}
            </div>
          )}
        </div>
      </div>

      {canOperateBordro && (
        <div className="mb-4">
          <Panel title="Bordro İşlemi (Ciro / Tahsile Ver / Teminata Ver / Tahsil-Ödeme Kapat / Karşılıksız)">
            <CheckBordroWorkbench
              candidates={bordroCandidates}
              targets={bordroTargets}
              defaultBordroDate={istanbulTodayISO()}
            />
          </Panel>
        </div>
      )}

      <Panel
        title={`${total} çek/senet · ${total === 0 ? 0 : Math.min((page - 1) * PAGE_SIZE + 1, total)}–${Math.min(page * PAGE_SIZE, total)}`}
      >
        <ChecksTable rows={data} />
        <div className="mt-3 flex items-center justify-between text-xs">
          {page > 1 ? (
            <Link href={`/finance/checks?page=${page - 1}`} className="button-ghost px-3 py-2">
              Önceki 500
            </Link>
          ) : (
            <span />
          )}
          <span className="text-tone-3">
            Sayfa {page} / {Math.max(1, Math.ceil(total / PAGE_SIZE))}
          </span>
          {page * PAGE_SIZE < total ? (
            <Link href={`/finance/checks?page=${page + 1}`} className="button-ghost px-3 py-2">
              Sonraki 500
            </Link>
          ) : (
            <span />
          )}
        </div>
      </Panel>

      <div className="mt-4">
        <Panel title="Son Çek/Senet Bordro Kayıtları">
          {recentBordros.length === 0 ? (
            <p className="text-xs text-tone-3">Henüz bordro işlemi kaydedilmedi.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-edge text-[11px] text-tone-3">
                  <tr>
                    <th className="px-2 py-1.5">Bordro No</th>
                    <th className="px-2 py-1.5">Tarih</th>
                    <th className="px-2 py-1.5">Bordro Türü</th>
                    <th className="px-2 py-1.5">Hedef (Cari / Banka / Limit)</th>
                    <th className="px-2 py-1.5 text-right">Evrak</th>
                    <th className="px-2 py-1.5 text-right">Toplam</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-edge">
                  {recentBordros.map((b) => (
                    <tr key={b.id}>
                      <td className="px-2 py-1.5 font-mono font-medium">{b.bordroNo}</td>
                      <td className="px-2 py-1.5 font-mono">{b.bordroDate}</td>
                      <td className="px-2 py-1.5">
                        {CHECK_BORDRO_TYPE_LABELS_TR[b.bordroType] ?? b.bordroType}
                      </td>
                      <td className="px-2 py-1.5">{b.targetLabel ?? b.notes ?? "—"}</td>
                      <td className="px-2 py-1.5 text-right font-mono">{b.checkCount}</td>
                      <td className="px-2 py-1.5 text-right font-mono tabular-nums">
                        {formatMoney(b.totalAmount, b.currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
