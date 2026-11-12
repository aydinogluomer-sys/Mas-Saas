import Link from "@/components/ui/app-link";
import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { EmptyState, KeyStat, PageHeader, TableShell } from "@/components/ui/shell";
import { SubmitButton } from "@/components/ui/submit-button";
import { getRequestUser } from "@/lib/auth";
import { can } from "@/lib/authz/matrix";
import { requireRouteAccess } from "@/lib/authz/route-guard";
import { getPool } from "@/lib/db";
import { loadReconciliationRun } from "@/lib/ledger/trial-balance-bridge";
import { formatMoney } from "@/lib/money";
import {
  createReconciliationTaskAction,
  importAndReconcileMizanAction,
  reconcileExistingMizanAction,
} from "./actions";

export const dynamic = "force-dynamic";

export default async function TrialBalanceBridgePage({
  searchParams,
}: {
  searchParams?: Promise<{ runId?: string; result?: string; error?: string }>;
}) {
  const denied = await requireRouteAccess("/data/trial-balance-bridge");
  if (denied) return denied;
  const session = await getRequestUser();
  const sp = (await searchParams) ?? {};
  const pool = getPool();

  const canImport = session ? can(session.role, "statutory_trial_balances", "insert") : false;
  const canCreateTask = session ? can(session.role, "action_items", "insert") : false;
  const canExport = session
    ? can(session.role, "trial_balance_reconciliation_runs", "select")
    : false;

  const [summary, mizanListRes] = await Promise.all([
    loadReconciliationRun(pool, sp.runId ?? null).catch(() => null),
    pool
      .query<{
        id: string;
        as_of_date: string;
        period_label: string;
        source_software: string | null;
        original_filename: string;
        total_debit_try: string;
        total_credit_try: string;
        is_self_balanced: boolean;
        imported_at: string;
      }>(
        `select id::text,
                to_char(as_of_date, 'YYYY-MM-DD') as as_of_date,
                period_label,
                source_software,
                original_filename,
                total_debit_try::text,
                total_credit_try::text,
                is_self_balanced,
                to_char(imported_at at time zone 'Europe/Istanbul', 'YYYY-MM-DD HH24:MI') as imported_at
           from public.statutory_trial_balances
          order by as_of_date desc, imported_at desc
          limit 20`,
      )
      .catch(() => ({ rows: [], rowCount: 0 })),
  ]);

  const b = summary?.ebitdaTo690Bridge;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Yönetim Defteri ↔ SMMM Yasal Mizan Mutabakat Köprüsü (12 Kök Neden)"
        subtitle="Luca, Logo, Mikro, Zirve ve Paraşüt yasal mizanlarını (.xlsx / .csv / .xml) çift sayım korumalı (is_leaf) içeri aktarır; MAS Çift Taraflı Yönetim Defteri ile karşılaştırıp farkları 12 deterministik kök nedene ayırır ve 3 sekmeli Mali Müşavir Mutabakat Paketi (.xlsx) üretir."
        meta={
          summary ? (
            <Badge tone={summary.discrepancyGroupCount === 0 ? "green" : "amber"} dot>
              {summary.periodLabel} · {summary.matchedGroupCount} mutabık /{" "}
              {summary.discrepancyGroupCount} fark grubu
            </Badge>
          ) : (
            <Badge tone="neutral">Henüz mutabakat koşusu yok</Badge>
          )
        }
      />

      {sp.error ? (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-2.5 text-xs text-red-800">
          {sp.error}
        </div>
      ) : null}
      {sp.result ? (
        <div className="rounded border border-emerald-300 bg-emerald-50 px-4 py-2.5 text-xs text-emerald-800">
          İşlem tamamlandı: {sp.result}
        </div>
      ) : null}

      {summary && !summary.isSelfBalanced ? (
        <div className="rounded border border-red-400 bg-red-50 px-4 py-3 text-xs text-red-900">
          <strong>KRİTİK MİZAN ÖZ-DENGE UYARISI:</strong> Yüklenen yasal mizan kendi içinde dengeli
          değil (Borç: {formatMoney(summary.statutoryTotalDebitTry)} TRY ≠ Alacak:{" "}
          {formatMoney(summary.statutoryTotalCreditTry)} TRY). Eksik sayfa veya bozuk mizan kesimi
          olabilir; kayıt reddedilmeden bayraklanmıştır.
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <KeyStat
          label="Yüklenen Yasal Mizan"
          value={mizanListRes.rowCount ?? 0}
          sub={summary ? `Son: ${summary.periodLabel}` : "Bekleniyor"}
          tone="info"
        />
        <KeyStat
          label="MAS Yönetim EBITDA"
          value={summary ? `${formatMoney(summary.managementEbitdaTry)} TRY` : "—"}
          sub="Faaliyet Kârı + Amortisman (770.99)"
          tone={summary && summary.managementEbitdaTry >= 0 ? "pos" : "neutral"}
        />
        <KeyStat
          label="SMMM Yasal 690 Kâr/Zarar"
          value={summary ? `${formatMoney(summary.statutory690EbtTry)} TRY` : "—"}
          sub="Yasal mizan 600–780 neti"
          tone={summary && summary.statutory690EbtTry >= 0 ? "pos" : "warn"}
        />
        <KeyStat
          label="Mutabık TDHP Grubu"
          value={summary ? summary.matchedGroupCount : 0}
          sub="Fark = 0,00 TRY"
          tone="pos"
        />
        <KeyStat
          label="Fark Tespit Edilen Grup"
          value={summary ? summary.discrepancyGroupCount : 0}
          sub="12 kök neden sınıflandırmalı"
          tone={summary && summary.discrepancyGroupCount > 0 ? "warn" : "pos"}
        />
      </div>

      {/* ① Yasal Mizan Yükleme ve Geçmiş Mizanlar */}
      <Panel
        title="① SMMM YASAL MİZAN İÇE AKTARIMI (.XLSX / .CSV / .XML) VE MUTABAKAT PAKETİ"
        subtitle="Ana hesap (120) ve kırılımlı alt hesap (120.01.005) birlikte geldiğinde yalnız yaprak (is_leaf=true) hesaplar toplanır; çift sayım otomatik engellenir."
      >
        <div className="space-y-4">
          {canImport ? (
            <form
              action={importAndReconcileMizanAction}
              className="grid grid-cols-1 gap-3 rounded border border-[var(--line)] bg-[var(--surface-2)] p-3 text-xs text-[var(--text-1)] sm:grid-cols-5"
            >
              <div>
                <label className="mb-1 block text-[11px] font-medium text-[var(--text-2)]">
                  Mizan Tarihi
                </label>
                <input
                  type="date"
                  name="asOfDate"
                  required
                  defaultValue="2026-06-30"
                  className="w-full rounded border border-[var(--line)] bg-[var(--surface-1)] px-2 py-1.5 text-[var(--text-1)]"
                />
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-medium text-[var(--text-2)]">
                  Dönem Etiketi
                </label>
                <input
                  type="text"
                  name="periodLabel"
                  required
                  placeholder="Ör. 2026-06 Haziran Mizanı"
                  defaultValue="2026-06 Dönem Sonu Mizanı"
                  className="w-full rounded border border-[var(--line)] bg-[var(--surface-1)] px-2 py-1.5 text-[var(--text-1)]"
                />
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-medium text-[var(--text-2)]">
                  Kaynak Program
                </label>
                <select
                  name="sourceSoftware"
                  defaultValue="Luca"
                  className="w-full rounded border border-[var(--line)] bg-[var(--surface-1)] px-2 py-1.5 text-[var(--text-1)]"
                >
                  <option value="Luca">Luca Mali Müşavir Paketi</option>
                  <option value="Logo">Logo Tiger / Go</option>
                  <option value="Mikro">Mikro</option>
                  <option value="Zirve">Zirve</option>
                  <option value="Parasut">Paraşüt Mizan</option>
                  <option value="e-Defter XML">GİB e-Defter / Standart XML</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-medium text-[var(--text-2)]">
                  Mizan Dosyası (.xlsx / .csv / .xml)
                </label>
                <input
                  type="file"
                  name="file"
                  accept=".xlsx,.csv,.tsv,.xml,.txt"
                  className="w-full rounded border border-[var(--line)] bg-[var(--surface-1)] px-2 py-1 text-[11px] text-[var(--text-1)]"
                />
              </div>
              <div className="flex items-end">
                <SubmitButton
                  pendingLabel="Yükleniyor…"
                  className="w-full rounded bg-sky-700 px-3 py-1.5 font-medium text-white disabled:opacity-60"
                >
                  Yasal Mizanı Yükle &amp; Köprüyü Çalıştır
                </SubmitButton>
              </div>
              <div className="sm:col-span-5">
                <textarea
                  name="rawMizanText"
                  rows={2}
                  placeholder="İsteğe bağlı: Dosya seçmek yerine CSV (Hesap Kodu;Hesap Adı;Borç;Alacak) veya XML mizan satırlarını doğrudan buraya yapıştırabilirsiniz."
                  className="w-full rounded border border-[var(--line)] bg-[var(--surface-1)] px-2 py-1.5 font-mono text-[11px] text-[var(--text-1)]"
                />
              </div>
            </form>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-2">
            {mizanListRes.rows.length > 0 && canImport ? (
              <form action={reconcileExistingMizanAction} className="flex items-center gap-2 text-xs">
                <select
                  name="trialBalanceId"
                  defaultValue={summary?.statutoryTrialBalanceId ?? mizanListRes.rows[0].id}
                  className="rounded border border-[var(--line)] bg-[var(--surface-1)] px-2.5 py-1.5 text-[var(--text-1)]"
                >
                  {mizanListRes.rows.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.as_of_date} — {m.period_label} ({m.source_software ?? "Mizan"} ·{" "}
                      {m.original_filename})
                    </option>
                  ))}
                </select>
                <SubmitButton
                  pendingLabel="Yenileniyor…"
                  className="rounded border border-[var(--line)] bg-[var(--surface-2)] px-3 py-1.5 font-medium text-[var(--text-1)] disabled:opacity-60"
                >
                  Seçili Mizanla Mutabakatı Yenile
                </SubmitButton>
              </form>
            ) : null}

            {summary && canExport ? (
              <Link
                href={`/api/ledger/reconciliation/${summary.runId}/export`}
                download
                data-no-nav-skeleton="true"
                className="rounded bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white"
              >
                Mali Müşavir Mutabakat Paketi İndir (.xlsx — 3 Sekme)
              </Link>
            ) : null}
          </div>
        </div>
      </Panel>

      {/* ② 12 Kök Nedenli Otomatik Fark Tablosu */}
      <Panel
        title="② 12 KÖK NEDENLİ OTOMATİK YÖNETİM ↔ YASAL MİZAN MUTABAKAT TABLOSU"
        subtitle="Hiçbir yönetim fişi veya yasal mizan satırı otomatik değiştirilmez; farklar Türkiye muhasebe pratiğine özgü 12 deterministik kök nedene ayrılır ve aday kanıt belgeleriyle listelenir."
      >
        {summary ? (
          <TableShell>
            <table className="w-full text-xs">
              <thead>
                <tr>
                  <th>TDHP Grubu</th>
                  <th>Hesap Grubu Adı</th>
                  <th className="text-right">MAS Yönetim Net (TRY)</th>
                  <th className="text-right">SMMM Yasal Net (TRY)</th>
                  <th className="text-right">Fark (MAS - Yasal)</th>
                  <th>Kök Neden Kodu</th>
                  <th>Durum</th>
                  <th>Teşhis &amp; Aday Kanıt Belgeleri</th>
                  <th>Aksiyon</th>
                </tr>
              </thead>
              <tbody>
                {summary.items.map((item) => (
                  <tr key={item.id}>
                    <td className="font-mono text-xs font-semibold">{item.tdhpGroupCode}</td>
                    <td className="text-xs">{item.tdhpGroupName}</td>
                    <td className="text-right font-mono text-xs">
                      {formatMoney(item.managementNetTry)}
                    </td>
                    <td className="text-right font-mono text-xs">
                      {formatMoney(item.statutoryNetTry)}
                    </td>
                    <td
                      className={`text-right font-mono text-xs font-semibold ${
                        Math.abs(item.deltaTry) < 0.005
                          ? "text-emerald-700"
                          : item.deltaTry > 0
                            ? "text-amber-700"
                            : "text-red-700"
                      }`}
                    >
                      {formatMoney(item.deltaTry)}
                    </td>
                    <td className="font-mono text-[11px]">{item.rootCauseCode}</td>
                    <td>
                      <Badge
                        tone={
                          item.severity === "match"
                            ? "green"
                            : item.severity === "critical"
                              ? "red"
                              : item.severity === "warning"
                                ? "amber"
                                : "blue"
                        }
                      >
                        {item.severity}
                      </Badge>
                    </td>
                    <td className="max-w-md space-y-1 text-xs">
                      <div>{item.explanation}</div>
                      {item.candidateEvidence.length > 0 ? (
                        <div className="rounded border border-[var(--line)] bg-[var(--surface-2)] p-1.5 text-[11px] text-[var(--text-2)]">
                          <div className="font-semibold text-[var(--text-1)]">
                            Aday MAS Kanıt Kayıtları ({item.candidateEvidence.length}):
                          </div>
                          <ul className="list-inside list-disc">
                            {item.candidateEvidence.map((ev) => (
                              <li key={`${ev.entityTable}:${ev.entityId}`}>
                                <span className="font-mono">{ev.docDate}</span> ·{" "}
                                <span className="font-mono font-semibold">{ev.docRef}</span> ·{" "}
                                {formatMoney(ev.amountTry)} TRY — {ev.summary}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                    </td>
                    <td>
                      {item.actionItemId ? (
                        <Badge tone="green">Görev Açıldı</Badge>
                      ) : item.severity !== "match" && canCreateTask ? (
                        <form action={createReconciliationTaskAction}>
                          <input type="hidden" name="itemId" value={item.id} />
                          <input type="hidden" name="runId" value={summary.runId} />
                          <SubmitButton
                            pendingLabel="Açılıyor…"
                            className="rounded border border-amber-400 bg-amber-50 px-2 py-1 text-[11px] font-medium text-amber-800 disabled:opacity-60"
                          >
                            Görev Aç
                          </SubmitButton>
                        </form>
                      ) : (
                        <span className="text-[11px] text-[var(--text-3)]">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        ) : (
          <EmptyState>
            Henüz çalıştırılmış bir Yasal Mizan mutabakatı yok — yukarıdan mali müşavirinizin gönderdiği `.xlsx`, `.csv` veya `.xml` mizanı yükleyerek 12 kök nedenli mutabakatı başlatabilirsiniz.
          </EmptyState>
        )}
      </Panel>

      {/* ③ Yönetim EBITDA ↔ Yasal 690 Dönem Kârı Şelale Köprüsü */}
      {summary && b ? (
        <Panel
          title="③ YÖNETİM EBITDA ↔ SMMM YASAL 690 DÖNEM KÂRI ŞELALE KÖPRÜSÜ"
          subtitle="Operasyonel Yönetim EBITDA'sından amortisman (770.99), finansman gideri (780) ve dönemsellik kesim farklarıyla yasal mizan 690 Vergi Öncesi Kâr/Zarar hesabına kuruşu kuruşuna köprü."
        >
          <TableShell>
            <table className="w-full text-xs">
              <thead>
                <tr>
                  <th>Köprü Adımı</th>
                  <th className="text-right">Tutar (TRY)</th>
                </tr>
              </thead>
              <tbody>
                <tr className="bg-emerald-50 font-bold text-emerald-900">
                  <td>1. MAS Yönetim EBITDA (Faaliyet Kârı + Amortisman Geri Eklemesi)</td>
                  <td className="text-right font-mono">{formatMoney(b.managementEbitdaTry)}</td>
                </tr>
                <tr>
                  <td>2. (-) MAS Amortisman ve İtfa Payları (`770.99` / `257`)</td>
                  <td className="text-right font-mono text-amber-700">
                    -{formatMoney(b.lessManagementDepreciationTry)}
                  </td>
                </tr>
                <tr className="font-semibold">
                  <td>3. (=) MAS Faaliyet Kârı (EBIT)</td>
                  <td className="text-right font-mono">{formatMoney(b.managementEbitTry)}</td>
                </tr>
                <tr>
                  <td>4. (-) MAS Finansman Giderleri (`780` Faiz + BSMV + KKDF)</td>
                  <td className="text-right font-mono text-red-700">
                    -{formatMoney(b.lessManagementFinancingTry)}
                  </td>
                </tr>
                <tr>
                  <td>5. (+) MAS Diğer Olağan Gelir ve Kârlar / Giderler Net (`642`–`656`)</td>
                  <td className="text-right font-mono">{formatMoney(b.plusManagementOtherNetTry)}</td>
                </tr>
                <tr className="border-t border-[var(--line)] font-semibold">
                  <td>6. (=) MAS Yönetim Vergi Öncesi Kârı (`690` EBT)</td>
                  <td className="text-right font-mono">{formatMoney(b.management690EbtTry)}</td>
                </tr>
                <tr>
                  <td>7. (+/-) Satış Gelirleri Dönemsellik / Kesim Farkı (`600`–`619`)</td>
                  <td className="text-right font-mono">{formatMoney(b.revenueTimingGapTry)}</td>
                </tr>
                <tr>
                  <td>8. (+/-) Maliyet ve Faaliyet Giderleri Belge / Tahakkuk Farkı (`620`–`770`)</td>
                  <td className="text-right font-mono">{formatMoney(b.expenseTimingGapTry)}</td>
                </tr>
                <tr>
                  <td>9. (+/-) Finansman Gideri Kayıt Farkı (`780`)</td>
                  <td className="text-right font-mono">{formatMoney(b.financingTimingGapTry)}</td>
                </tr>
                <tr>
                  <td>10. (+/-) Diğer Gelir/Gider &amp; Yuvarlama Farkı</td>
                  <td className="text-right font-mono">
                    {formatMoney(b.unexplainedBridgeResidualTry)}
                  </td>
                </tr>
                <tr className="border-t border-[var(--line)] bg-sky-50 font-bold text-sky-900">
                  <td>11. (=) SMMM Yasal Mizan `690` Dönem Kârı / (Zararı)</td>
                  <td className="text-right font-mono">{formatMoney(b.statutory690EbtTry)}</td>
                </tr>
              </tbody>
            </table>
          </TableShell>
        </Panel>
      ) : null}
    </div>
  );
}
