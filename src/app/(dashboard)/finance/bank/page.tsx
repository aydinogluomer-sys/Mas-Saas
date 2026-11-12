// Faz 20 & Faz 48 (D2) — Banka Merkezi.
//
// Three things an operator actually does, in the order they do them: check where each account
// stands (and lock matched rows into reconciled status), upload a statement, then work the
// unmatched queue where accepting a match atomically settles the target financial obligation.

import { getPool, withReadConnection } from "@/lib/db";
import {
  countUnmatchedQueue, loadBankableAccounts, loadCandidatesBatch, loadMatchConflicts,
  loadReconciliationSummary, loadUnmatchedQueue,
} from "@/lib/bank/engine";
import { formatMoney } from "@/lib/money-format";
import { Badge, type Tone } from "@/components/ui/badge";
import { PaginationBar, parsePageParam } from "@/components/ui/pagination-bar";
import { Panel, fmtTL } from "@/components/ui/panel";
import { PageHeader } from "@/components/ui/shell";
import {
  acceptMatchAction, ignoreTransactionAction, importStatementAction,
  reconcileAccountAction, rejectCandidateAction, runMatcherAction, saveBankAccountAction,
} from "./actions";
import { requireRouteAccess } from "@/lib/authz/route-guard";

export const dynamic = "force-dynamic";

const CATEGORY_TONE: Record<string, Tone> = {
  bank_fee: "amber", tax: "amber", interest_paid: "amber", loan_payment: "violet",
  check_settlement: "violet", salary: "blue", card_payment: "blue",
  incoming_payment: "green", interest_earned: "green",
  own_transfer: "neutral", outgoing_payment: "neutral", unknown: "neutral",
};

const TARGET_TABLE_TR: Record<string, string> = {
  invoices: "Fatura",
  payment_instances: "Ödeme",
  checks: "Çek",
  loan_installments: "Taksit",
};

export default async function BankPage({
  searchParams,
}: { searchParams: Promise<{ error?: string; result?: string; page?: string }> }) {
  const denied = await requireRouteAccess("/finance/bank");
  if (denied) return denied;
  const sp = await searchParams;
  const { page, limit, offset } = parsePageParam(sp.page, 50);
  const { summary, queue, queueTotal, accounts, conflicts, candidateMap } = await withReadConnection(getPool(), async (db) => {
    const [summaryRows, queueRows, queueCount, accountRows, conflictRows] = await Promise.all([
      loadReconciliationSummary(db),
      loadUnmatchedQueue(db, limit, offset),
      countUnmatchedQueue(db),
      loadBankableAccounts(db),
      loadMatchConflicts(db),
    ]);
    const suggestedIds = queueRows.filter((q) => q.openCandidateCount > 0).map((q) => q.id);
    const candidates = await loadCandidatesBatch(db, suggestedIds);
    return {
      summary: summaryRows,
      queue: queueRows,
      queueTotal: queueCount,
      accounts: accountRows,
      conflicts: conflictRows,
      candidateMap: candidates,
    };
  });

  const withProfile = accounts.filter((a) => a.has_bank_profile);
  const totalUnmatched = summary.reduce((n, s) => n + s.unmatchedCount + s.suggestedCount, 0);

  return (
    <>
      <PageHeader
        title="Banka Merkezi"
        subtitle="Ekstre içe aktarma, kural-tabanlı sınıflandırma ve atomik kapanışlı mutabakat eşleştirmesi"
        meta={
          <Badge tone={conflicts.length > 0 ? "red" : totalUnmatched > 0 ? "amber" : "green"} dot>
            {conflicts.length > 0 ? `${conflicts.length} çakışma` : `${totalUnmatched} bekleyen hareket`}
          </Badge>
        }
      />

      {sp.error && <div className="mb-3 rounded border border-neg/40 bg-neg/10 p-2 text-sm text-neg">{sp.error}</div>}
      {sp.result && <div className="mb-3 rounded border border-pos/40 bg-pos/10 p-2 text-sm text-pos">{sp.result}</div>}

      <Panel title={`HESAP MUTABAKAT DURUMU — ${summary.length} banka hesabı`}>
        {summary.length === 0 ? (
          <p className="py-2 text-sm text-tone-3">
            Henüz banka hesabı tanımlı değil. Aşağıdan bir kasa hesabına IBAN/şube bilgisi ekleyin.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-tone-3">
                  <th>Hesap</th><th>IBAN</th>
                  <th className="text-right">Hareket</th>
                  <th className="text-right">Bekleyen</th>
                  <th className="text-right">Eşleşen</th>
                  <th className="text-right">Mutabık</th>
                  <th className="text-right">Giriş</th>
                  <th className="text-right">Çıkış</th>
                  <th className="text-right">Net</th>
                  <th>Son ekstre</th>
                  <th className="text-right">İşlem</th>
                </tr>
              </thead>
              <tbody>
                {summary.map((s) => (
                  <tr key={s.bankAccountId} className="border-t border-line-faint">
                    <td className="py-2">{s.accountName}</td>
                    <td className="font-mono text-[11px] text-tone-3">{s.iban || "—"}</td>
                    <td className="text-right tabular-nums">{s.transactionCount}</td>
                    <td className="text-right tabular-nums">
                      {s.unmatchedCount + s.suggestedCount > 0 ? (
                        <span className="text-warn">{s.unmatchedCount + s.suggestedCount}</span>
                      ) : "—"}
                    </td>
                    <td className="text-right tabular-nums">{s.matchedCount}</td>
                    <td className="text-right tabular-nums text-pos">{s.reconciledCount}</td>
                    <td className="text-right font-mono tabular-nums text-pos">{fmtTL(s.inflowTotal)}</td>
                    <td className="text-right font-mono tabular-nums text-neg">{fmtTL(s.outflowTotal)}</td>
                    <td className="text-right font-mono tabular-nums">{fmtTL(s.netTotal)}</td>
                    <td className="text-tone-3">{s.lastStatementDate ?? "—"}</td>
                    <td className="text-right">
                      {s.matchedCount > 0 ? (
                        <form action={reconcileAccountAction} className="inline">
                          <input type="hidden" name="bankAccountId" value={s.bankAccountId} />
                          <button className="rounded border border-line-faint px-2 py-0.5 text-xs hover:bg-white/5">
                            Mutabakata al
                          </button>
                        </form>
                      ) : (
                        <span className="text-xs text-tone-3">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {conflicts.length > 0 && (
        <Panel title={`EŞLEŞME ÇAKIŞMASI — ${conflicts.length}`}>
          <p className="mb-2 text-xs text-tone-3">
            Birden fazla banka hareketi aynı mali kaydı iddia ediyor. Engellenmez, bildirilir —
            karar insana aittir.
          </p>
          {conflicts.map((c) => (
            <div key={`${c.targetTable}-${c.targetId}`} className="border-b border-line-faint py-1 text-sm">
              <span className="font-mono text-xs">{c.targetTable}</span> · {c.claimCount} hareket ·{" "}
              <b>{fmtTL(c.claimedTotal)}</b>
            </div>
          ))}
        </Panel>
      )}

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Panel title="EKSTRE YÜKLE">
          <p className="mb-2 text-xs text-tone-3">
            CSV veya XLSX. Aynı dönem tekrar yüklenirse satırlar çoğalmaz — yinelenenler
            birleştirilir ve sayısı bildirilir.
          </p>
          <form action={importStatementAction} className="grid gap-2 text-sm">
            <select name="bankAccountId" required className="rounded border border-line-faint bg-transparent px-2 py-1">
              <option value="">Hesap seçin…</option>
              {withProfile.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            <input type="file" name="statement" accept=".csv,.txt,.tsv,.xlsx" required className="text-xs" />
            <button className="rounded border border-line-faint px-2 py-1 hover:bg-white/5">İçe aktar</button>
          </form>
          <form action={runMatcherAction} className="mt-3 border-t border-line-faint pt-3">
            <button className="w-full rounded border border-line-faint px-2 py-1 text-sm hover:bg-white/5">
              Eşleştiriciyi çalıştır
            </button>
            <p className="mt-1 text-[11px] text-tone-3">
              Yalnız öneri üretir. Hiçbir eşleşmeyi kendiliğinden kabul etmez.
            </p>
          </form>
        </Panel>

        <Panel title="BANKA HESABI TANIMLA">
          <p className="mb-2 text-xs text-tone-3">
            Banka bilgisi ayrı bir tabloda tutulur; kasa hesabının kendisi değişmez.
          </p>
          <form action={saveBankAccountAction} className="grid gap-2 text-sm">
            <select name="cashAccountId" required className="rounded border border-line-faint bg-transparent px-2 py-1">
              <option value="">Kasa hesabı…</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.account_type}){a.has_bank_profile ? " ✓" : ""}
                </option>
              ))}
            </select>
            <input name="iban" placeholder="IBAN" className="rounded border border-line-faint bg-transparent px-2 py-1 font-mono text-xs" />
            <input name="bankName" placeholder="Banka" className="rounded border border-line-faint bg-transparent px-2 py-1" />
            <input name="branchCode" placeholder="Şube kodu" className="rounded border border-line-faint bg-transparent px-2 py-1" />
            <input name="overdraftLimit" type="number" step="0.01" min="0" placeholder="KMH limiti (TL)" className="rounded border border-line-faint bg-transparent px-2 py-1" />
            <button className="rounded border border-line-faint px-2 py-1 hover:bg-white/5">Kaydet</button>
          </form>
        </Panel>

        <Panel title="SINIFLANDIRMA & ATOMİK KAPANIŞ">
          <p className="text-xs text-tone-3">
            Sınıflandırma <b>deterministik kurallardır</b>, model değil: her satırın yanında hangi
            kuralın çalıştığı yazar. Bir kural yanlışsa düzeltilir — yeniden eğitilmez.
          </p>
          <p className="mt-2 text-xs text-tone-3">
            Eşleştirme için <b>iki bağımsız sinyal</b> gerekir (tutar + tarih/isim). Tek başına
            tutar tutması öneri üretmez; yuvarlak rakamlarda rastlantı çok olur.
          </p>
          <p className="mt-2 text-xs text-tone-3">
            Bir öneriyi <b>kabul etmek</b>, aynı PostgreSQL transaction içinde faturayı tahsis eder,
            ödemeyi/taksiti/çeki kapatır ve bağlı ödeme paketini (<code>payment_runs</code>) günceller.
          </p>
        </Panel>
      </div>

      <div className="mt-4">
        <Panel title={`BEKLEYEN HAREKETLER — ${queueTotal}`}>
          {queue.length === 0 ? (
            <p className="py-2 text-sm text-tone-3">Bekleyen banka hareketi yok.</p>
          ) : (
            queue.map((t) => {
              const cands = (candidateMap.get(t.id) ?? []).filter((c) => !c.rejected);
              return (
                <div key={t.id} className="border-b border-line-faint py-2 text-sm">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="flex flex-wrap items-baseline gap-2">
                      <span className="font-mono text-xs text-tone-3">{t.txnDate}</span>
                      <b>{t.description || "(açıklama yok)"}</b>
                      {t.counterparty && <span className="text-xs text-info">↔ {t.counterparty}</span>}
                      <Badge tone={CATEGORY_TONE[t.category] ?? "neutral"}>{t.category}</Badge>
                      {t.categoryRule && (
                        <span className="font-mono text-[10px] text-tone-3">kural: {t.categoryRule}</span>
                      )}
                    </span>
                    <span className={`font-mono tabular-nums ${t.direction === "outflow" ? "text-neg" : "text-pos"}`}>
                      {fmtTL(t.amount)}
                    </span>
                  </div>

                  {cands.length > 0 ? (
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      {cands.map((c) => (
                        <span key={c.id} className="flex flex-wrap items-center gap-1.5 rounded border border-line-faint px-2 py-1 text-xs">
                          <Badge tone="neutral">{TARGET_TABLE_TR[c.targetTable] ?? c.targetTable}</Badge>
                          {c.referenceLabel && <b className="font-mono">{c.referenceLabel}</b>}
                          {c.counterpartyName && <span className="text-info">{c.counterpartyName}</span>}
                          {c.openAmount != null && (
                            <span className="font-mono tabular-nums">
                              {formatMoney(c.openAmount, c.currency ?? "TRY")}
                            </span>
                          )}
                          {c.dueDate && <span className="font-mono text-[10px] text-tone-3">vade: {c.dueDate}</span>}
                          <b>%{Math.round(c.confidence * 100)}</b>
                          <span className="text-[10px] text-tone-3">({c.reasons.join(",")})</span>
                          <form action={acceptMatchAction} className="inline">
                            <input type="hidden" name="transactionId" value={t.id} />
                            <input type="hidden" name="targetTable" value={c.targetTable} />
                            <input type="hidden" name="targetId" value={c.targetId} />
                            <button className="ml-1 text-pos hover:underline">kabul</button>
                          </form>
                          <form action={rejectCandidateAction} className="inline">
                            <input type="hidden" name="transactionId" value={t.id} />
                            <input type="hidden" name="targetTable" value={c.targetTable} />
                            <input type="hidden" name="targetId" value={c.targetId} />
                            <button className="ml-1 text-neg hover:underline">reddet</button>
                          </form>
                        </span>
                      ))}
                    </div>
                  ) : (
                    <span className="text-[11px] text-tone-3">Önerilen eşleşme yok.</span>
                  )}

                  <form action={ignoreTransactionAction} className="mt-1 flex items-center gap-2">
                    <input type="hidden" name="transactionId" value={t.id} />
                    <input
                      name="reason" required minLength={3} placeholder="Yok sayma gerekçesi (zorunlu)"
                      className="w-64 rounded border border-line-faint bg-transparent px-1 py-0.5 text-xs"
                    />
                    <button className="text-xs text-tone-3 hover:underline">yok say</button>
                  </form>
                </div>
              );
            })
          )}
          <PaginationBar
            basePath="/finance/bank"
            page={page}
            pageSize={limit}
            totalCount={queueTotal}
          />
        </Panel>
      </div>
    </>
  );
}
