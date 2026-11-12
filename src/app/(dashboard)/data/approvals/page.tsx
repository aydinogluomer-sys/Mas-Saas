import { getCurrentUser } from "@/lib/auth";
import { requireRouteAccess } from "@/lib/authz/route-guard";
import { getPool } from "@/lib/db";
import {
  loadActiveApproverCount,
  loadApprovalCounts,
  loadApprovalGovernanceSettings,
  loadApprovalQueue,
  loadApprovalRules,
  type ApprovalRow,
} from "@/lib/approvals/engine";
import { formatMoney } from "@/lib/money-format";
import { Badge, type Tone } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { EmptyState, KeyStat, PageHeader, TableShell } from "@/components/ui/shell";
import {
  decideApprovalAction,
  resubmitApprovalAction,
  toggleApprovalRuleAction,
  updateApprovalGovernanceAction,
  upsertApprovalRuleAction,
} from "./actions";

export const dynamic = "force-dynamic";

const STATUS_TONE: Record<string, Tone> = {
  pending: "amber",
  reworked: "amber",
  approved: "green",
  rejected: "neutral",
};
const STATUS_LABEL: Record<string, string> = {
  pending: "bekliyor",
  reworked: "revizyonda",
  approved: "onaylandı",
  rejected: "reddedildi",
};
const KIND_LABEL: Record<string, string> = {
  data_review: "veri incelemesi",
  amount_threshold: "tutar eşiği",
  amount_gte: "tutar eşiği",
  always: "her zaman",
  new_iban: "yeni IBAN",
  new_counterparty: "yeni cari",
  invoice: "fatura",
  payment: "ödeme",
  payment_run: "ödeme paketi",
  budget: "bütçe",
  other: "diğer",
};
const SUBJECT_LABEL: Record<string, string> = {
  mapping_reviews: "eşleme incelemesi",
  external_assumptions: "dış varsayım",
  invoices: "fatura",
  payment_instances: "ödeme",
  ibans: "IBAN",
  parties: "cari",
  bank_transactions: "banka hareketi",
  payment_runs: "ödeme paketi",
  budgets: "bütçe",
  budget_lines: "bütçe satırı",
  forecast_lines: "tahmin satırı",
  payments: "ödeme şablonu",
};

export default async function ApprovalsPage({
  searchParams,
}: { searchParams: Promise<{ error?: string; result?: string }> }) {
  const denied = await requireRouteAccess("/data/approvals");
  if (denied) return denied;
  const sp = await searchParams;
  const pool = getPool();
  const [counts, queue, rules, governance, activeApproverCount, currentUser] = await Promise.all([
    loadApprovalCounts(pool),
    loadApprovalQueue(pool),
    loadApprovalRules(pool),
    loadApprovalGovernanceSettings(pool),
    loadActiveApproverCount(pool),
    getCurrentUser(),
  ]);
  const isAdmin = currentUser?.role === "admin";
  const open = queue.filter((r) => r.status === "pending" || r.status === "reworked");
  const decided = queue.filter((r) => r.status === "approved" || r.status === "rejected").slice(0, 40);

  return (
    <>
      <PageHeader
        title="Onay Kuyruğu & 4-Göz Yönetişimi"
        subtitle="Çoklu onaycıda sıkı 4-göz (maker <> checker); tek aktif onaycıda kontrollü gerekçeli admin öz-onayı (A1)"
        meta={
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={activeApproverCount >= 2 ? "green" : "amber"} dot>
              {activeApproverCount >= 2
                ? `${activeApproverCount} aktif onaycı (sıkı 4-göz)`
                : `${activeApproverCount} aktif onaycı (tek operatör modu)`}
            </Badge>
            <Badge tone={counts.pending > 0 ? "amber" : "green"} dot>
              {`${counts.pending} bekleyen`}
            </Badge>
          </div>
        }
      />

      {sp.error ? (
        <div
          className="mb-3 rounded border px-3 py-2 text-sm"
          style={{
            background: "var(--surface-2)",
            borderColor: "var(--warn)",
            color: "var(--text-1)",
          }}
        >
          {sp.error}
        </div>
      ) : null}

      {sp.result ? (
        <div
          className="mb-3 rounded border px-3 py-2 text-sm"
          style={{
            background: "var(--surface-2)",
            borderColor: "var(--pos)",
            color: "var(--text-1)",
          }}
        >
          {sp.result}
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <KeyStat label="Bekleyen" value={counts.pending} tone={counts.pending > 0 ? "warn" : "pos"} />
        <KeyStat label="Revizyonda" value={counts.reworked} tone={counts.reworked > 0 ? "warn" : "neutral"} />
        <KeyStat label="Onaylanan" value={counts.approved} tone="pos" />
        <KeyStat label="Reddedilen" value={counts.rejected} tone="neutral" />
      </div>

      <Panel
        title="Tek Aktif Onaycıda Admin Öz-Onay Politikası"
        subtitle="Sistemde 2 veya daha fazla aktif onaycı (admin / finans yöneticisi) bulunduğunda veritabanı ve motor seviyesinde sıkı maker <> checker kuralı her zaman zorunludur"
        right={
          <Badge tone={governance.allowSingleOperatorSelfApproval ? "amber" : "green"}>
            {governance.allowSingleOperatorSelfApproval
              ? `Tek onaycıda açık (min ${governance.minJustificationLength} krk)`
              : "Kapalı (her zaman 2. göz)"}
          </Badge>
        }
      >
        <div className="flex flex-wrap items-center justify-between gap-3 text-xs" style={{ color: "var(--text-1)" }}>
          <div style={{ color: "var(--text-2)" }}>
            Aktif onaycı sayısı: <b>{activeApproverCount}</b>. Tek operatörlü kurulumda yalnız <code>admin</code>{" "}
            rolü en az <b>{governance.minJustificationLength}</b> karakterlik denetim gerekçesi yazarak kendi talebini
            onaylayabilir; işlem <code>self_approved_override = true</code> olarak <code>audit_logs</code> kaydına
            işlenir.
          </div>
          {isAdmin ? (
            <form action={updateApprovalGovernanceAction} className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  name="allowSingleOperatorSelfApproval"
                  defaultChecked={governance.allowSingleOperatorSelfApproval}
                />
                <span>Tek aktif onaycıda admin öz-onayına izin ver</span>
              </label>
              <label className="flex items-center gap-1">
                <span style={{ color: "var(--text-2)" }}>Min. gerekçe:</span>
                <input
                  name="minJustificationLength"
                  type="number"
                  min={10}
                  max={500}
                  defaultValue={governance.minJustificationLength}
                  className="field-control w-16 px-1.5 py-1 font-mono text-xs"
                />
              </label>
              <button type="submit" className="button-primary px-3 py-1 text-xs">
                Politikayı kaydet
              </button>
            </form>
          ) : null}
        </div>
      </Panel>

      <Panel title="AÇIK ONAYLAR">
        {open.length === 0 ? (
          <EmptyState>Bekleyen onay yok.</EmptyState>
        ) : (
          <TableShell>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase" style={{ color: "var(--text-2)" }}>
                  <th className="py-1">Konu</th>
                  <th>Tür</th>
                  <th>Kural</th>
                  <th className="text-right">Tutar</th>
                  <th>Talep</th>
                  <th>Durum</th>
                  <th>Karar / Öz-Onay Gerekçesi</th>
                </tr>
              </thead>
              <tbody>
                {open.map((r) => {
                  const isOwnRequest = Boolean(currentUser?.id && r.requestedBy === currentUser.id);
                  return (
                    <tr
                      key={r.id}
                      className="border-t align-top"
                      style={{ borderColor: "var(--line)", color: "var(--text-1)" }}
                    >
                      <Cells row={r} />
                      <td className="py-2">
                        {r.status === "reworked" ? (
                          <form action={resubmitApprovalAction} className="flex flex-wrap items-center gap-1">
                            <input type="hidden" name="approvalId" value={r.id} />
                            <input
                              name="note"
                              placeholder="revizyon notu"
                              className="field-control w-32 px-1.5 py-1 text-xs"
                            />
                            <button type="submit" className="button-ghost px-2 py-1 text-xs">
                              Yeniden gönder
                            </button>
                          </form>
                        ) : (
                          <form action={decideApprovalAction} className="flex flex-wrap items-center gap-1">
                            <input type="hidden" name="approvalId" value={r.id} />
                            <input
                              name="justification"
                              placeholder={
                                isOwnRequest
                                  ? `öz-onay gerekçesi (min ${governance.minJustificationLength} krk)`
                                  : "karar / gerekçe notu"
                              }
                              minLength={isOwnRequest ? governance.minJustificationLength : undefined}
                              required={isOwnRequest}
                              className="field-control w-48 px-1.5 py-1 text-xs"
                            />
                            <button
                              type="submit"
                              name="decision"
                              value="approved"
                              className="button-primary px-2 py-1 text-xs"
                            >
                              {isOwnRequest ? "Öz-Onayla" : "Onayla"}
                            </button>
                            <button
                              type="submit"
                              name="decision"
                              value="rejected"
                              className="button-ghost px-2 py-1 text-xs"
                            >
                              Reddet
                            </button>
                            <button
                              type="submit"
                              name="decision"
                              value="reworked"
                              className="button-ghost px-2 py-1 text-xs"
                            >
                              Revizyon
                            </button>
                          </form>
                        )}
                      </td>
                    </tr>
                  );
                })}
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
                <tr className="text-left text-xs uppercase" style={{ color: "var(--text-2)" }}>
                  <th className="py-1">Konu</th>
                  <th>Tür</th>
                  <th>Kural</th>
                  <th className="text-right">Tutar</th>
                  <th>Talep</th>
                  <th>Durum</th>
                  <th>Karar veren</th>
                </tr>
              </thead>
              <tbody>
                {decided.map((r) => (
                  <tr
                    key={r.id}
                    className="border-t"
                    style={{ borderColor: "var(--line)", color: "var(--text-1)" }}
                  >
                    <Cells row={r} />
                    <td className="py-2 text-xs" style={{ color: "var(--text-2)" }}>
                      <div>
                        {r.decidedByName ?? "— (eski kayıt)"}
                        {r.selfApprovedOverride ? (
                          <span className="ml-1.5">
                            <Badge tone="amber">öz-onay istisnası</Badge>
                          </span>
                        ) : null}
                      </div>
                      {r.decidedAt ? <span className="block">{r.decidedAt}</span> : null}
                      {r.selfApprovalJustification ? (
                        <span className="block italic">{r.selfApprovalJustification}</span>
                      ) : r.decisionNote ? (
                        <span className="block">{r.decisionNote}</span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        )}
      </Panel>

      <Panel
        title="ONAY KURALLARI"
        subtitle="Hangi işlemlerin onay kuyruğuna düşeceğini ve tutar eşiklerini belirler (yalnız admin düzenler)"
      >
        <div className="space-y-3">
          {isAdmin ? (
            <form
              action={upsertApprovalRuleAction}
              className="grid grid-cols-1 gap-2 rounded border p-3 text-xs md:grid-cols-6"
              style={{
                background: "var(--surface-2)",
                borderColor: "var(--line)",
                color: "var(--text-1)",
              }}
            >
              <input
                name="code"
                required
                placeholder="kural_kodu (ör. amount_over_250k)"
                className="field-control px-2 py-1.5 font-mono text-xs"
              />
              <input
                name="description"
                required
                placeholder="Kural açıklaması"
                className="field-control px-2 py-1.5 text-xs md:col-span-2"
              />
              <select name="triggerKind" defaultValue="amount_threshold" className="field-control px-2 py-1.5 text-xs">
                <option value="amount_threshold">Tutar eşiği (amount_threshold)</option>
                <option value="new_iban">Yeni IBAN (new_iban)</option>
                <option value="new_counterparty">Yeni cari (new_counterparty)</option>
                <option value="invoice">Fatura (invoice)</option>
                <option value="payment">Ödeme (payment)</option>
                <option value="payment_run">Ödeme paketi (payment_run)</option>
                <option value="budget">Bütçe (budget)</option>
              </select>
              <input
                name="thresholdAmount"
                type="number"
                step="0.01"
                min="0"
                placeholder="Eşik tutarı (TRY)"
                className="field-control px-2 py-1.5 font-mono text-xs"
              />
              <div className="flex items-center gap-1.5">
                <input
                  name="appliesTo"
                  defaultValue="invoices,payment_instances"
                  placeholder="Tablolar (virgülle)"
                  className="field-control min-w-0 flex-1 px-2 py-1.5 font-mono text-[11px]"
                />
                <button type="submit" className="button-primary shrink-0 px-3 py-1.5 text-xs">
                  Kural ekle
                </button>
              </div>
            </form>
          ) : null}

          <TableShell>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase" style={{ color: "var(--text-2)" }}>
                  <th className="py-1">Kural</th>
                  <th>Tetikleyici</th>
                  <th className="text-right">Eşik</th>
                  <th>Kapsam</th>
                  <th>Durum</th>
                  {isAdmin ? <th>Düzenle / Aç-Kapat</th> : null}
                </tr>
              </thead>
              <tbody>
                {rules.map((r) => (
                  <tr
                    key={r.id}
                    className="border-t align-middle"
                    style={{ borderColor: "var(--line)", color: "var(--text-1)" }}
                  >
                    <td className="py-2">
                      {r.description}
                      <span className="block font-mono text-xs" style={{ color: "var(--text-2)" }}>
                        {r.code}
                      </span>
                    </td>
                    <td className="text-xs">{KIND_LABEL[r.triggerKind] ?? r.triggerKind}</td>
                    <td className="text-right font-mono tabular-nums">
                      {r.thresholdAmount == null ? "—" : formatMoney(r.thresholdAmount, r.currency ?? "TRY")}
                    </td>
                    <td className="text-xs" style={{ color: "var(--text-2)" }}>
                      {r.appliesTo.length === 0
                        ? "tümü"
                        : r.appliesTo.map((t) => SUBJECT_LABEL[t] ?? t).join(", ")}
                    </td>
                    <td>
                      <Badge tone={r.isActive ? "green" : "neutral"}>{r.isActive ? "aktif" : "pasif"}</Badge>
                    </td>
                    {isAdmin ? (
                      <td className="py-2">
                        <div className="flex flex-wrap items-center gap-1.5">
                          {r.triggerKind === "amount_threshold" ? (
                            <form action={upsertApprovalRuleAction} className="inline-flex items-center gap-1">
                              <input type="hidden" name="ruleId" value={r.id} />
                              <input type="hidden" name="code" value={r.code} />
                              <input type="hidden" name="description" value={r.description} />
                              <input type="hidden" name="triggerKind" value={r.triggerKind} />
                              <input type="hidden" name="currency" value={r.currency ?? "TRY"} />
                              <input type="hidden" name="appliesTo" value={r.appliesTo.join(",")} />
                              <input type="hidden" name="hasIsActiveField" value="1" />
                              {r.isActive ? <input type="hidden" name="isActive" value="on" /> : null}
                              <input
                                name="thresholdAmount"
                                type="number"
                                step="0.01"
                                min="0"
                                defaultValue={r.thresholdAmount ?? 0}
                                className="field-control w-28 px-1.5 py-0.5 font-mono text-[11px]"
                              />
                              <button type="submit" className="button-ghost px-2 py-0.5 text-[11px]">
                                Eşiği kaydet
                              </button>
                            </form>
                          ) : null}
                          <form action={toggleApprovalRuleAction} className="inline">
                            <input type="hidden" name="ruleId" value={r.id} />
                            <input type="hidden" name="nextActive" value={r.isActive ? "false" : "true"} />
                            <button type="submit" className="button-ghost px-2 py-0.5 text-[11px]">
                              {r.isActive ? "Pasife al" : "Aktifleştir"}
                            </button>
                          </form>
                        </div>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        </div>
      </Panel>
    </>
  );
}

function Cells({ row }: { row: ApprovalRow }) {
  return (
    <>
      <td className="py-2">
        {row.subjectLabel ?? "—"}
        <span className="block text-xs" style={{ color: "var(--text-2)" }}>
          {SUBJECT_LABEL[row.subjectTable] ?? row.subjectTable}
          {row.roundNo > 1 ? ` · ${row.roundNo}. tur` : ""}
          {row.subjectStatus ? ` · ${row.subjectStatus}` : ""}
        </span>
      </td>
      <td className="text-xs">{KIND_LABEL[row.requestKind] ?? row.requestKind}</td>
      <td className="font-mono text-xs" style={{ color: "var(--text-2)" }}>
        {row.ruleCode ?? "—"}
      </td>
      <td className="text-right font-mono tabular-nums">
        {row.amount == null ? "—" : formatMoney(row.amount, row.currency ?? "TRY")}
      </td>
      <td className="text-xs" style={{ color: "var(--text-2)" }}>
        {row.requestedByName ?? "—"}
        <span className="block">{row.requestedAt}</span>
      </td>
      <td>
        <Badge tone={STATUS_TONE[row.status] ?? "neutral"}>{STATUS_LABEL[row.status] ?? row.status}</Badge>
      </td>
    </>
  );
}
