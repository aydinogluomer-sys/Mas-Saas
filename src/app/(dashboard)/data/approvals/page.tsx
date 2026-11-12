import { getPool } from "@/lib/db";
import {
  loadApprovalCounts, loadApprovalQueue, loadApprovalRules, type ApprovalRow,
} from "@/lib/approvals/engine";
import { formatMoney } from "@/lib/money-format";
import { Badge, type Tone } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { EmptyState, KeyStat, PageHeader, TableShell } from "@/components/ui/shell";
import { decideApprovalAction, resubmitApprovalAction } from "./actions";
import { requireRouteAccess } from "@/lib/authz/route-guard";

export const dynamic = "force-dynamic";

const STATUS_TONE: Record<string, Tone> = {
  pending: "amber", reworked: "amber", approved: "green", rejected: "neutral",
};
const STATUS_LABEL: Record<string, string> = {
  pending: "bekliyor", reworked: "revizyonda", approved: "onaylandı", rejected: "reddedildi",
};
const KIND_LABEL: Record<string, string> = {
  data_review: "veri incelemesi", amount_threshold: "tutar eşiği", new_iban: "yeni IBAN",
  new_counterparty: "yeni cari", invoice: "fatura", payment: "ödeme", payment_run: "ödeme paketi", budget: "bütçe", other: "diğer",
};
const SUBJECT_LABEL: Record<string, string> = {
  mapping_reviews: "eşleme incelemesi", external_assumptions: "dış varsayım",
  invoices: "fatura", payment_instances: "ödeme", ibans: "IBAN",
  parties: "cari", bank_transactions: "banka hareketi",
  payment_runs: "ödeme paketi", budgets: "bütçe", budget_lines: "bütçe satırı", forecast_lines: "tahmin satırı", payments: "ödeme şablonu",
};

export default async function ApprovalsPage({
  searchParams,
}: { searchParams: Promise<{ error?: string; result?: string }> }) {
  const denied = await requireRouteAccess("/data/approvals");
  if (denied) return denied;
  const sp = await searchParams;
  const pool = getPool();
  const [counts, queue, rules] = await Promise.all([
    loadApprovalCounts(pool), loadApprovalQueue(pool), loadApprovalRules(pool),
  ]);
  const open = queue.filter((r) => r.status === "pending" || r.status === "reworked");
  const decided = queue.filter((r) => r.status === "approved" || r.status === "rejected").slice(0, 40);

  return (
    <>
      <PageHeader
        title="Onay Kuyruğu"
        subtitle="Maker-checker: talep eden ile onaylayan aynı kişi olamaz"
        meta={<Badge tone={counts.pending > 0 ? "amber" : "green"} dot>{counts.pending} bekleyen</Badge>}
      />

      {sp.error ? (
        <div className="rounded border border-amber-700/50 bg-amber-950/30 px-3 py-2 text-sm text-amber-200">
          {sp.error}
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <KeyStat label="Bekleyen" value={counts.pending} tone={counts.pending > 0 ? "warn" : "pos"} />
        <KeyStat label="Revizyonda" value={counts.reworked} tone={counts.reworked > 0 ? "warn" : "neutral"} />
        <KeyStat label="Onaylanan" value={counts.approved} tone="pos" />
        <KeyStat label="Reddedilen" value={counts.rejected} tone="neutral" />
      </div>

      <Panel title="AÇIK ONAYLAR">
        {open.length === 0 ? (
          <EmptyState>Bekleyen onay yok.</EmptyState>
        ) : (
          <TableShell>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-neutral-500">
                  <th className="py-1">Konu</th><th>Tür</th><th>Kural</th>
                  <th className="text-right">Tutar</th><th>Talep</th><th>Durum</th><th>Karar</th>
                </tr>
              </thead>
              <tbody>
                {open.map((r) => (
                  <tr key={r.id} className="border-t border-neutral-800 align-top">
                    <Cells row={r} />
                    <td className="py-2">
                      {r.status === "reworked" ? (
                        <form action={resubmitApprovalAction} className="flex gap-1">
                          <input type="hidden" name="approvalId" value={r.id} />
                          <input name="note" placeholder="not" className="w-24 rounded border border-neutral-700 bg-neutral-900 px-1 text-xs" />
                          <button className="rounded bg-neutral-700 px-2 py-1 text-xs">Yeniden gönder</button>
                        </form>
                      ) : (
                        <form action={decideApprovalAction} className="flex flex-wrap items-center gap-1">
                          <input type="hidden" name="approvalId" value={r.id} />
                          <input name="note" placeholder="karar notu" className="w-28 rounded border border-neutral-700 bg-neutral-900 px-1 text-xs" />
                          <button name="decision" value="approved" className="rounded bg-emerald-800 px-2 py-1 text-xs">Onayla</button>
                          <button name="decision" value="rejected" className="rounded bg-neutral-700 px-2 py-1 text-xs">Reddet</button>
                          <button name="decision" value="reworked" className="rounded bg-amber-800 px-2 py-1 text-xs">Revizyon</button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        )}
      </Panel>

      <Panel title="KARARA BAĞLANANLAR" subtitle="son 40 kayıt">
        {decided.length === 0 ? (
          <EmptyState>Henüz karara bağlanmış onay yok.</EmptyState>
        ) : (
          <TableShell>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-neutral-500">
                  <th className="py-1">Konu</th><th>Tür</th><th>Kural</th>
                  <th className="text-right">Tutar</th><th>Talep</th><th>Durum</th><th>Karar veren</th>
                </tr>
              </thead>
              <tbody>
                {decided.map((r) => (
                  <tr key={r.id} className="border-t border-neutral-800">
                    <Cells row={r} />
                    <td className="py-2 text-xs text-neutral-400">
                      {r.decidedByName ?? "— (eski kayıt)"}
                      {r.decidedAt ? <span className="block text-neutral-600">{r.decidedAt}</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        )}
      </Panel>

      <Panel title="ONAY KURALLARI" subtitle="hangi durumlar ikinci göz ister">
        <TableShell>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase text-neutral-500">
                <th className="py-1">Kural</th><th>Tetikleyici</th>
                <th className="text-right">Eşik</th><th>Kapsam</th><th>Durum</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id} className="border-t border-neutral-800">
                  <td className="py-2">{r.description}<span className="block text-xs text-neutral-600">{r.code}</span></td>
                  <td className="text-xs">{KIND_LABEL[r.triggerKind] ?? r.triggerKind}</td>
                  <td className="text-right font-mono tabular-nums">{r.thresholdAmount == null ? "—" : formatMoney(r.thresholdAmount, r.currency ?? "TRY")}</td>
                  <td className="text-xs text-neutral-400">
                    {r.appliesTo.length === 0 ? "tümü" : r.appliesTo.map((t) => SUBJECT_LABEL[t] ?? t).join(", ")}
                  </td>
                  <td><Badge tone={r.isActive ? "green" : "neutral"}>{r.isActive ? "aktif" : "pasif"}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableShell>
      </Panel>
    </>
  );
}

function Cells({ row }: { row: ApprovalRow }) {
  return (
    <>
      <td className="py-2">
        {row.subjectLabel ?? "—"}
        <span className="block text-xs text-neutral-600">
          {SUBJECT_LABEL[row.subjectTable] ?? row.subjectTable}
          {row.roundNo > 1 ? ` · ${row.roundNo}. tur` : ""}
          {row.subjectStatus ? ` · ${row.subjectStatus}` : ""}
        </span>
      </td>
      <td className="text-xs">{KIND_LABEL[row.requestKind] ?? row.requestKind}</td>
      <td className="text-xs text-neutral-500">{row.ruleCode ?? "—"}</td>
      <td className="text-right font-mono tabular-nums">{row.amount == null ? "—" : formatMoney(row.amount, row.currency ?? "TRY")}</td>
      <td className="text-xs text-neutral-400">
        {row.requestedByName ?? "—"}<span className="block text-neutral-600">{row.requestedAt}</span>
      </td>
      <td><Badge tone={STATUS_TONE[row.status] ?? "neutral"}>{STATUS_LABEL[row.status] ?? row.status}</Badge></td>
    </>
  );
}
