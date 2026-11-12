// Faz 20 & Faz 48 (D2) + Wave 5A (F-45 FIN-03 500.99 Açılış Defteri & F-48 ±90g / Manuel Eşleştirme) — Banka Merkezi.

import { getPool, withReadConnection } from "@/lib/db";
import {
  countUnmatchedQueue,
  loadBankableAccounts,
  loadCandidatesBatch,
  loadMatchConflicts,
  loadOpenManualMatchTargets,
  loadRecentResolvedBankTransactions,
  loadReconciliationSummary,
  loadUnmatchedQueue,
} from "@/lib/bank/engine";
import { istanbulDateISO } from "@/lib/reports/rules";
import { formatMoney } from "@/lib/money-format";
import { loadEditableCashAndBankAccounts } from "@/lib/treasury/engine";
import { Badge, type Tone } from "@/components/ui/badge";
import { PaginationBar, parsePageParam } from "@/components/ui/pagination-bar";
import { Panel, fmtTL } from "@/components/ui/panel";
import { PageHeader } from "@/components/ui/shell";
import { SubmitButton } from "@/components/ui/submit-button";
import {
  acceptMatchAction,
  ignoreTransactionAction,
  importStatementAction,
  manualMatchAction,
  reconcileAccountAction,
  rejectCandidateAction,
  runMatcherAction,
  saveBankAccountAction,
  unignoreTransactionAction,
  unmatchTransactionAction,
  upsertBankOrCashAccountAction,
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

const ACCOUNT_TYPE_TR: Record<string, string> = {
  cash: "Kasa (100)",
  bank_account: "Banka (102)",
  pos_settlement: "POS Bloke (102)",
  credit_line: "KMH / Kredi Limiti (102)",
};

export default async function BankPage({
  searchParams,
}: { searchParams: Promise<{ error?: string; result?: string; page?: string }> }) {
  const denied = await requireRouteAccess("/finance/bank");
  if (denied) return denied;
  const sp = await searchParams;
  const today = istanbulDateISO();
  const { page, limit, offset } = parsePageParam(sp.page, 50);
  const {
    summary,
    queue,
    queueTotal,
    accounts,
    conflicts,
    candidateMap,
    editableAccounts,
    manualTargets,
    resolvedRows,
  } = await withReadConnection(getPool(), async (db) => {
    const [
      summaryRows,
      queueRows,
      queueCount,
      accountRows,
      conflictRows,
      editableRows,
      manualTargetRows,
      recentResolved,
    ] = await Promise.all([
      loadReconciliationSummary(db),
      loadUnmatchedQueue(db, limit, offset),
      countUnmatchedQueue(db),
      loadBankableAccounts(db),
      loadMatchConflicts(db),
      loadEditableCashAndBankAccounts(db),
      loadOpenManualMatchTargets(db, 200),
      loadRecentResolvedBankTransactions(db, 25),
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
      editableAccounts: editableRows,
      manualTargets: manualTargetRows,
      resolvedRows: recentResolved,
    };
  });

  const withProfile = accounts.filter((a) => a.has_bank_profile);
  const totalUnmatched = summary.reduce((n, s) => n + s.unmatchedCount + s.suggestedCount, 0);
  const unknownOpeningCount = editableAccounts.filter((a) => a.isActive && a.openingBalance === null).length;

  return (
    <>
      <PageHeader
        title="Banka Merkezi"
        subtitle="Ekstre içe aktarma, ±90 gün kural-tabanlı sınıflandırma, 500.99 açılış defteri ve atomik kapanışlı mutabakat"
        meta={
          <div className="flex flex-wrap items-center gap-2">
            {unknownOpeningCount > 0 && (
              <Badge tone="amber" dot>
                {unknownOpeningCount} hesapta açılış bakiyesi eksik (FIN-03)
              </Badge>
            )}
            <Badge tone={conflicts.length > 0 ? "red" : totalUnmatched > 0 ? "amber" : "green"} dot>
              {conflicts.length > 0 ? `${conflicts.length} çakışma` : `${totalUnmatched} bekleyen hareket`}
            </Badge>
          </div>
        }
      />

      {sp.error && <div className="mb-3 rounded border border-neg/40 bg-neg/10 p-2 text-sm text-neg">{sp.error}</div>}
      {sp.result && <div className="mb-3 rounded border border-pos/40 bg-pos/10 p-2 text-sm text-pos">{sp.result}</div>}

      <Panel title={`HESAP MUTABAKAT DURUMU — ${summary.length} banka hesabı`}>
        {summary.length === 0 ? (
          <p className="py-2 text-sm text-tone-3">
            Henüz banka hesabı tanımlı değil. Aşağıdan yeni banka/kasa hesabı oluşturun veya mevcut kasa hesabına IBAN ekleyin.
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
                          <button className="button-ghost px-2 py-0.5 text-xs">
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

      <div className="mt-4">
        <Panel
          title="KASA / BANKA HESABI & AÇILIŞ BAKİYESİ YÖNETİMİ (FIN-03 · 500.99 Yönetim Defteri)"
        >
          <p className="mb-3 text-xs" style={{ color: "var(--text-2)" }}>
            Yeni banka veya kasa hesabı açın ya da mevcut hesapların açılış bakiyesini / IBAN bilgisini güncelleyin.
            Sıfırdan farklı açılış bakiyeleri aynı DB işleminde otomatik olarak <code>100</code>/<code>102</code> ile{" "}
            <code>500.99 Açılış Bilançosu Denkleştirme</code> hesabına fişlenir; güncellemelerde önceki fiş ters kayıtla kapatılır.
          </p>

          <form
            action={upsertBankOrCashAccountAction}
            className="grid grid-cols-1 gap-2 rounded-lg border p-3 text-xs md:grid-cols-4 lg:grid-cols-8"
            style={{ borderColor: "var(--line)", background: "var(--surface-2)" }}
          >
            <label className="flex flex-col gap-1 lg:col-span-2">
              <span style={{ color: "var(--text-2)" }}>Hesap adı</span>
              <input
                name="name"
                required
                placeholder="Örn. Garanti BBVA Ticari TL"
                className="field-control text-xs"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span style={{ color: "var(--text-2)" }}>Tür</span>
              <select name="kind" defaultValue="bank" className="field-control text-xs">
                <option value="bank">Banka (102)</option>
                <option value="cash">Kasa (100)</option>
                <option value="pos">POS Bloke (102)</option>
                <option value="credit_line">KMH / Kredi (102)</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span style={{ color: "var(--text-2)" }}>Döviz</span>
              <select name="currency" defaultValue="TRY" className="field-control text-xs">
                <option value="TRY">TRY</option>
                <option value="USD">USD</option>
                <option value="EUR">EUR</option>
                <option value="GBP">GBP</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span style={{ color: "var(--text-2)" }}>Açılış bakiyesi</span>
              <input
                name="openingBalance"
                type="number"
                step="0.01"
                placeholder="0.00"
                className="field-control font-mono text-xs"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span style={{ color: "var(--text-2)" }}>Açılış tarihi</span>
              <input
                name="openingBalanceDate"
                type="date"
                defaultValue={today}
                className="field-control font-mono text-xs"
              />
            </label>
            <label className="flex flex-col gap-1 lg:col-span-2">
              <span style={{ color: "var(--text-2)" }}>IBAN (Banka için MOD-97 doğrulanır)</span>
              <input
                name="iban"
                placeholder="TR00 0000 0000 0000 0000 0000 00"
                className="field-control font-mono text-xs"
              />
            </label>
            <label className="flex flex-col gap-1 lg:col-span-2">
              <span style={{ color: "var(--text-2)" }}>Banka adı</span>
              <input
                name="bankName"
                placeholder="Örn. Garanti BBVA"
                className="field-control text-xs"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span style={{ color: "var(--text-2)" }}>Şube kodu</span>
              <input name="branchCode" placeholder="Şube" className="field-control text-xs" />
            </label>
            <label className="flex flex-col gap-1">
              <span style={{ color: "var(--text-2)" }}>KMH limiti</span>
              <input
                name="overdraftLimit"
                type="number"
                step="0.01"
                min="0"
                placeholder="0.00"
                className="field-control font-mono text-xs"
              />
            </label>
            <div className="flex items-end lg:col-span-4">
              <SubmitButton pendingText="Kaydediliyor…" className="button-primary text-xs">
                Yeni Hesap & Açılış Bakiyesi Oluştur
              </SubmitButton>
            </div>
          </form>

          {editableAccounts.length > 0 && (
            <div className="mt-3 space-y-2">
              <div className="text-[11px] font-medium uppercase tracking-wide" style={{ color: "var(--text-2)" }}>
                Mevcut Hesapların Açılış Bakiyesi & IBAN Güncellemesi ({editableAccounts.length})
              </div>
              {editableAccounts.map((acc) => (
                <form
                  key={acc.id}
                  action={upsertBankOrCashAccountAction}
                  className="grid grid-cols-1 items-end gap-2 rounded-lg border p-2.5 text-xs md:grid-cols-6 lg:grid-cols-10"
                  style={{ borderColor: "var(--line)", background: "var(--surface-1)" }}
                >
                  <input type="hidden" name="cashAccountId" value={acc.id} />
                  <input type="hidden" name="hasIsActiveField" value="1" />
                  <label className="flex flex-col gap-1 lg:col-span-2">
                    <span style={{ color: "var(--text-2)" }}>
                      {ACCOUNT_TYPE_TR[acc.accountType] ?? acc.accountType} · {acc.currency}
                    </span>
                    <input
                      name="name"
                      defaultValue={acc.name}
                      required
                      className="field-control text-xs"
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span style={{ color: "var(--text-2)" }}>Açılış bakiyesi ({acc.currency})</span>
                    <input
                      name="openingBalance"
                      type="number"
                      step="0.01"
                      defaultValue={acc.openingBalance ?? ""}
                      placeholder="Girilmedi (FIN-03)"
                      className="field-control font-mono text-xs"
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span style={{ color: "var(--text-2)" }}>Açılış tarihi</span>
                    <input
                      name="openingBalanceDate"
                      type="date"
                      defaultValue={acc.openingBalanceDate ?? today}
                      className="field-control font-mono text-xs"
                    />
                  </label>
                  <label className="flex flex-col gap-1 lg:col-span-2">
                    <span style={{ color: "var(--text-2)" }}>IBAN</span>
                    <input
                      name="iban"
                      defaultValue={acc.ibanNormalized ?? acc.iban ?? ""}
                      placeholder={acc.accountType === "cash" ? "Kasa hesabı" : "TR..."}
                      className="field-control font-mono text-xs"
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span style={{ color: "var(--text-2)" }}>Banka</span>
                    <input
                      name="bankName"
                      defaultValue={acc.bankName ?? ""}
                      placeholder="Banka adı"
                      className="field-control text-xs"
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span style={{ color: "var(--text-2)" }}>KMH limiti</span>
                    <input
                      name="overdraftLimit"
                      type="number"
                      step="0.01"
                      min="0"
                      defaultValue={acc.overdraftLimit ?? ""}
                      placeholder="0.00"
                      className="field-control font-mono text-xs"
                    />
                  </label>
                  <label className="flex items-center gap-1.5 pb-1.5">
                    <input type="checkbox" name="isActive" defaultChecked={acc.isActive} />
                    <span style={{ color: "var(--text-1)" }}>Aktif</span>
                  </label>
                  <div className="flex items-center justify-end gap-2">
                    {acc.openingJournalEntryId && (
                      <span title={`500.99 Fiş ID: ${acc.openingJournalEntryId}`}>
                        <Badge tone="green">500.99 ✓</Badge>
                      </span>
                    )}
                    <button type="submit" className="button-ghost px-2.5 py-1 text-xs">
                      Kaydet
                    </button>
                  </div>
                </form>
              ))}
            </div>
          )}
        </Panel>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Panel title="EKSTRE YÜKLE">
          <p className="mb-2 text-xs text-tone-3">
            CSV veya XLSX. Aynı dönem tekrar yüklenirse satırlar çoğalmaz — yinelenenler
            birleştirilir ve sayısı bildirilir.
          </p>
          <form action={importStatementAction} className="grid gap-2 text-sm">
            <select name="bankAccountId" required className="field-control text-xs">
              <option value="">Hesap seçin…</option>
              {withProfile.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            <input type="file" name="statement" accept=".csv,.txt,.tsv,.xlsx" required className="text-xs" />
            <button className="button-ghost px-2 py-1 text-xs">İçe aktar</button>
          </form>
          <form action={runMatcherAction} className="mt-3 border-t border-line-faint pt-3">
            <button className="button-primary w-full px-2 py-1 text-xs">
              Eşleştiriciyi çalıştır (±90 gün)
            </button>
            <p className="mt-1 text-[11px] text-tone-3">
              ±90 gün penceresinde kademeli güven puanıyla öneri üretir; 10 gün içi en yüksek puanı alır.
            </p>
          </form>
        </Panel>

        <Panel title="MEVCUT KASAYA BANKA PROFİLİ EKLE">
          <p className="mb-2 text-xs text-tone-3">
            Mevcut kasa kaydının IBAN, şube ve KMH limit profilini doğrudan güncelleyin.
          </p>
          <form action={saveBankAccountAction} className="grid gap-2 text-sm">
            <select name="cashAccountId" required className="field-control text-xs">
              <option value="">Kasa hesabı…</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.account_type}){a.has_bank_profile ? " ✓" : ""}
                </option>
              ))}
            </select>
            <input name="iban" placeholder="IBAN" className="field-control font-mono text-xs" />
            <input name="bankName" placeholder="Banka" className="field-control text-xs" />
            <input name="branchCode" placeholder="Şube kodu" className="field-control text-xs" />
            <input name="overdraftLimit" type="number" step="0.01" min="0" placeholder="KMH limiti (TL)" className="field-control text-xs" />
            <button className="button-ghost px-2 py-1 text-xs">Profili kaydet</button>
          </form>
        </Panel>

        <Panel title="SINIFLANDIRMA & ATOMİK KAPANIŞ">
          <p className="text-xs text-tone-3">
            Sınıflandırma <b>deterministik kurallardır</b>, model değil: her satırın yanında hangi
            kuralın çalıştığı yazar. Bir kural yanlışsa düzeltilir — yeniden eğitilmez.
          </p>
          <p className="mt-2 text-xs text-tone-3">
            Otomatik eşleştirici <b>±90 gün</b> vade penceresini tarar; yakın vadeli (≤10 gün) hareketler
            daha yüksek güven puanı alır, 30–90 gün gecikmeli tahsilat/ödemeler de kaçırılmaz.
          </p>
          <p className="mt-2 text-xs text-tone-3">
            Öneri gelmeyen satırları her hareketin altındaki <b>Manuel Eşleştir & Kapat</b> seçicisiyle
            açık fatura, ödeme kalemi, çek veya kredi taksitiyle tek tıkta atomik olarak kapatabilirsiniz.
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
              const compatibleTargets = manualTargets.filter(
                (m) => m.currency === t.currency && m.direction === t.direction,
              );
              return (
                <div key={t.id} className="border-b border-line-faint py-2.5 text-sm">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="flex flex-wrap items-baseline gap-2">
                      <span className="font-mono text-xs text-tone-3">{t.txnDate}</span>
                      <span className="text-xs" style={{ color: "var(--text-2)" }}>
                        [{t.accountName} · {t.currency}]
                      </span>
                      <b>{t.description || "(açıklama yok)"}</b>
                      {t.counterparty && <span className="text-xs text-info">↔ {t.counterparty}</span>}
                      <Badge tone={CATEGORY_TONE[t.category] ?? "neutral"}>{t.category}</Badge>
                      {t.categoryRule && (
                        <span className="font-mono text-[10px] text-tone-3">kural: {t.categoryRule}</span>
                      )}
                    </span>
                    <span className={`font-mono tabular-nums ${t.direction === "outflow" ? "text-neg" : "text-pos"}`}>
                      {formatMoney(t.amount, t.currency)}
                    </span>
                  </div>

                  {cands.length > 0 ? (
                    <div className="mt-1.5 flex flex-wrap items-center gap-2">
                      {cands.map((c) => (
                        <span
                          key={c.id}
                          className="flex flex-wrap items-center gap-1.5 rounded border px-2 py-1 text-xs"
                          style={{ borderColor: "var(--line)", background: "var(--surface-2)" }}
                        >
                          <Badge tone="neutral">{TARGET_TABLE_TR[c.targetTable] ?? c.targetTable}</Badge>
                          {c.referenceLabel && <b className="font-mono">{c.referenceLabel}</b>}
                          {c.counterpartyName && <span className="text-info">{c.counterpartyName}</span>}
                          {c.openAmount != null && (
                            <span className="font-mono tabular-nums">
                              {formatMoney(c.openAmount, c.currency ?? t.currency)}
                            </span>
                          )}
                          {c.dueDate && <span className="font-mono text-[10px] text-tone-3">vade: {c.dueDate}</span>}
                          <b>%{Math.round(c.confidence * 100)}</b>
                          <span className="text-[10px] text-tone-3">({c.reasons.join(",")})</span>
                          <form action={acceptMatchAction} className="inline">
                            <input type="hidden" name="transactionId" value={t.id} />
                            <input type="hidden" name="targetTable" value={c.targetTable} />
                            <input type="hidden" name="targetId" value={c.targetId} />
                            <button className="ml-1 font-medium text-pos hover:underline">kabul</button>
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
                    <div className="mt-1 text-[11px] text-tone-3">Otomatik eşleşme önerisi yok.</div>
                  )}

                  <div className="mt-2 flex flex-wrap items-center gap-3">
                    <form action={manualMatchAction} className="flex flex-wrap items-center gap-1.5 text-xs">
                      <input type="hidden" name="transactionId" value={t.id} />
                      <select
                        name="targetKey"
                        required
                        defaultValue=""
                        className="field-control max-w-md text-xs"
                        disabled={compatibleTargets.length === 0}
                      >
                        <option value="">
                          {compatibleTargets.length === 0
                            ? `Açık ${t.currency} ${t.direction === "inflow" ? "tahsilat" : "ödeme"} hedefi yok`
                            : "Manuel eşleştirilecek açık hedefi seçin…"}
                        </option>
                        {compatibleTargets.map((m) => (
                          <option key={m.targetKey} value={m.targetKey}>
                            [{TARGET_TABLE_TR[m.targetTable] ?? m.targetTable}] {m.referenceLabel}
                            {m.counterpartyName ? ` · ${m.counterpartyName}` : ""}
                            {m.openAmount != null ? ` · ${formatMoney(m.openAmount, m.currency)}` : ""}
                            {m.dueDate ? ` · vade ${m.dueDate}` : ""}
                          </option>
                        ))}
                      </select>
                      <button
                        type="submit"
                        disabled={compatibleTargets.length === 0}
                        className="button-ghost px-2.5 py-1 text-xs disabled:opacity-50"
                      >
                        Manuel Eşleştir & Kapat
                      </button>
                    </form>

                    <form action={ignoreTransactionAction} className="flex items-center gap-1.5">
                      <input type="hidden" name="transactionId" value={t.id} />
                      <input
                        name="reason"
                        required
                        minLength={3}
                        placeholder="Yok sayma gerekçesi (zorunlu)"
                        className="field-control w-56 text-xs"
                      />
                      <button className="text-xs text-tone-3 hover:underline">yok say</button>
                    </form>
                  </div>
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

      <div className="mt-4">
        <Panel title={`SON EŞLEŞTİRİLEN / YOK SAYILAN HAREKETLER (GERİ ALMA) — ${resolvedRows.length}`}>
          <p className="mb-2 text-xs text-tone-3">
            Yanlış eşleştirilen veya sehven yok sayılan banka hareketlerini buradan tek tıkta geri alabilirsiniz;
            eşleştirme geri alındığında bağlı fatura tahsisatı, ödeme kalemi, çek/kredi kapanışı ve yönetim defteri fişi atomik olarak storno edilir.
          </p>
          {resolvedRows.length === 0 ? (
            <p className="py-2 text-sm text-tone-3">Henüz eşleştirilmiş veya yok sayılmış hareket bulunmuyor.</p>
          ) : (
            <div className="divide-y divide-line-faint">
              {resolvedRows.map((r) => (
                <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-tone-3">{r.txnDate}</span>
                    <span style={{ color: "var(--text-2)" }}>
                      [{r.accountName} · {r.currency}]
                    </span>
                    <b>{r.description || "(açıklama yok)"}</b>
                    {r.counterparty && <span className="text-info">↔ {r.counterparty}</span>}
                    <Badge
                      tone={
                        r.status === "reconciled"
                          ? "green"
                          : r.status === "matched"
                            ? "blue"
                            : "amber"
                      }
                    >
                      {r.status === "reconciled"
                        ? "mutabık"
                        : r.status === "matched"
                          ? `eşleşti (${TARGET_TABLE_TR[r.matchedEntityTable ?? ""] ?? r.matchedEntityTable ?? "hedef"})`
                          : `yok sayıldı${r.ignoredReason ? `: ${r.ignoredReason}` : ""}`}
                    </Badge>
                    <span className={`font-mono tabular-nums ${r.direction === "outflow" ? "text-neg" : "text-pos"}`}>
                      {formatMoney(r.amount, r.currency)}
                    </span>
                  </div>

                  {r.status === "ignored" ? (
                    <form action={unignoreTransactionAction} className="inline">
                      <input type="hidden" name="transactionId" value={r.id} />
                      <SubmitButton pendingText="Kaldırılıyor…" className="button-ghost px-2.5 py-1 text-xs">
                        Yok Saymayı Kaldır
                      </SubmitButton>
                    </form>
                  ) : (
                    <form action={unmatchTransactionAction} className="flex flex-wrap items-center gap-1.5">
                      <input type="hidden" name="transactionId" value={r.id} />
                      <input
                        name="reason"
                        required
                        minLength={3}
                        placeholder="Geri alma gerekçesi"
                        className="field-control w-48 text-xs"
                      />
                      <SubmitButton pendingText="Geri alınıyor…" className="button-ghost px-2.5 py-1 text-xs">
                        Eşleştirmeyi Geri Al
                      </SubmitButton>
                    </form>
                  )}
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
