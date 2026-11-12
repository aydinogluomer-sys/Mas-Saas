import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { EmptyState, KeyStat, TableShell } from "@/components/ui/shell";
import { getRequestUser } from "@/lib/auth";
import { can } from "@/lib/authz/matrix";
import { requireRouteAccess } from "@/lib/authz/route-guard";
import { getPool } from "@/lib/db";
import { formatMoney } from "@/lib/money";
import { isMissingSchemaError, loadManagementAccounts } from "@/lib/ledger/accounts";
import { loadManagementLedgerOverview } from "@/lib/ledger/posting-engine";
import {
  approveDraftEntryAction,
  createManagementSubAccountAction,
  postManualAdjustmentAction,
  reverseEntryAction,
  syncManagementLedgerAction,
} from "./actions";

export const dynamic = "force-dynamic";

export default async function ManagementLedgerPage({
  searchParams,
}: {
  searchParams?: Promise<{ result?: string; error?: string }>;
}) {
  const denied = await requireRouteAccess("/finance/ledger");
  if (denied) return denied;
  const session = await getRequestUser();
  const sp = (await searchParams) ?? {};
  const pool = getPool();

  const canPost = session ? can(session.role, "management_journal_entries", "insert") : false;
  const canApprove = session ? can(session.role, "management_journal_entries", "update") : false;
  const canReverse = session ? can(session.role, "management_journal_entries", "delete") : false;
  const canAddAccount = session ? can(session.role, "management_accounts", "insert") : false;

  const [overview, accounts, recentEntriesRes] = await Promise.all([
    loadManagementLedgerOverview(pool),
    loadManagementAccounts(pool),
    pool
      .query<{
        id: string;
        entry_no: string;
        entry_date: string;
        source_type: string;
        status: string;
        needs_tax_split_review: boolean;
        description: string;
        reversal_of_entry_id: string | null;
        reversed_by_entry_id: string | null;
        debit_total_try: string | null;
        credit_total_try: string | null;
        line_count: number;
      }>(
        `select
           je.id::text,
           je.entry_no::text,
           to_char(je.entry_date, 'YYYY-MM-DD') as entry_date,
           je.source_type,
           je.status,
           je.needs_tax_split_review,
           je.description,
           je.reversal_of_entry_id::text,
           je.reversed_by_entry_id::text,
           sum(jl.debit_try)::numeric(16,2)::text as debit_total_try,
           sum(jl.credit_try)::numeric(16,2)::text as credit_total_try,
           count(jl.id)::int as line_count
         from public.management_journal_entries je
         left join public.management_journal_lines jl on jl.entry_id = je.id
         group by je.id
         order by je.entry_date desc, je.entry_no desc
         limit 50`,
      )
      .catch((err: unknown) => {
        if (isMissingSchemaError(err)) return { rows: [], rowCount: 0 };
        throw err;
      }),
  ]);

  const { incomeStatement: isSum } = overview;
  const trialDiff = Number((overview.totalDebitTry - overview.totalCreditTry).toFixed(2));
  const bsDiff = Number((overview.totalAssetsTry - overview.totalLiabilitiesAndEquityTry).toFixed(2));

  return (
    <div className="space-y-6">
      {sp.error ? (
        <div className="rounded border border-red-800/70 bg-red-950/40 px-4 py-2.5 text-xs text-red-200">
          {sp.error}
        </div>
      ) : null}
      {sp.result ? (
        <div className="rounded border border-emerald-800/70 bg-emerald-950/40 px-4 py-2.5 text-xs text-emerald-200">
          İşlem tamamlandı: {sp.result}
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <KeyStat
          label="Yönetim EBITDA"
          value={`${formatMoney(isSum.managementEbitdaTry)} TRY`}
          sub={`EBIT ${formatMoney(isSum.ebitTry)} + Amortisman ${formatMoney(isSum.daAddbackTry)}`}
          tone={isSum.managementEbitdaTry >= 0 ? "pos" : "neg"}
        />
        <KeyStat
          label="Net Satışlar (600-610)"
          value={`${formatMoney(isSum.netSalesTry)} TRY`}
          sub={`Brüt Kâr: ${formatMoney(isSum.grossProfitTry)} TRY`}
          tone="info"
        />
        <KeyStat
          label="Dönem Net Kârı / (Zararı)"
          value={`${formatMoney(isSum.netIncomeTry)} TRY`}
          sub={`Finansman Gideri (780): ${formatMoney(isSum.financingExpenseTry)} TRY`}
          tone={isSum.netIncomeTry >= 0 ? "pos" : "warn"}
        />
        <KeyStat
          label="Mizan Borç = Alacak"
          value={`${formatMoney(overview.totalDebitTry)} TRY`}
          sub={trialDiff === 0 ? "Kuruş farkı: 0,00 TRY (Dengeli)" : `Fark: ${formatMoney(trialDiff)} TRY`}
          tone={trialDiff === 0 ? "pos" : "neg"}
        />
        <KeyStat
          label="Bilanço Aktif = Pasif"
          value={`${formatMoney(overview.totalAssetsTry)} TRY`}
          sub={bsDiff === 0 ? "Aktif = Yabancı Kaynak + Özkaynak (0,00)" : `Fark: ${formatMoney(bsDiff)} TRY`}
          tone={bsDiff === 0 ? "pos" : "neg"}
        />
      </div>

      {/* Üst Eylem Çubuğu: Otomatik Fiş Senkronizasyonu ve Alt Hesap Açma */}
      <Panel
        title="ÇİFT TARAFLI YÖNETİM DEFTERİ KONTROL MERKEZİ (TDHP)"
        subtitle="Fatura, banka tahsilat/ödeme, çek bordrosu ve kredi taksitlerinden idempotent çift taraflı yevmiye fişi üretir; DEFERRABLE veritabanı kısıtıyla borç ≠ alacak fişleri reddedilir."
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          {canPost ? (
            <form action={syncManagementLedgerAction}>
              <button
                type="submit"
                className="rounded bg-sky-700 px-3 py-1.5 text-xs font-medium text-white"
              >
                Operasyonel Kayıtlardan Yönetim Defterini Senkronla (Idempotent)
              </button>
            </form>
          ) : null}

          {canAddAccount ? (
            <form action={createManagementSubAccountAction} className="flex flex-wrap items-center gap-2 text-xs">
              <input
                name="code"
                required
                placeholder="Alt Hesap Kodu (ör. 120.01)"
                className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1"
              />
              <input
                name="name"
                required
                placeholder="Hesap Adı (ör. Yurtiçi Alıcılar - A Grubu)"
                className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1"
              />
              <button
                type="submit"
                className="rounded border border-neutral-700 bg-neutral-800 px-2.5 py-1 font-medium text-neutral-100"
              >
                TDHP Alt Hesap Aç
              </button>
            </form>
          ) : null}
        </div>
      </Panel>

      {/* ① YÖNETİM MİZANI */}
      <Panel
        title="① YÖNETİM MİZANI (TDHP HESAP PLANI VE BAKİYELER)"
        subtitle="Kesinleşmiş (posted/reversed) yevmiye fişlerinden canlı üretilir; döviz kuru eksik (provisional_fx) fişler kur gelene kadar mizan toplamını kirletmez."
      >
        {overview.trialBalance.length === 0 ? (
          <EmptyState>
            Henüz yönetim mizanı kaydı yok — hesap planı ve fişler oluştuğunda TDHP mizanı burada listelenir.
          </EmptyState>
        ) : (
          <TableShell>
            <thead>
              <tr>
                <th>Hesap Kodu</th>
                <th>Hesap Adı</th>
                <th>Sınıf</th>
                <th>EBITDA Kovası</th>
                <th className="text-right">Fiş Sayısı</th>
                <th className="text-right">Borç Toplamı (TRY)</th>
                <th className="text-right">Alacak Toplamı (TRY)</th>
                <th className="text-right">Borç Bakiyesi (TRY)</th>
                <th className="text-right">Alacak Bakiyesi (TRY)</th>
              </tr>
            </thead>
            <tbody>
              {overview.trialBalance.map((row) => (
                <tr key={row.accountCode}>
                  <td className="font-mono text-xs font-semibold">{row.accountCode}</td>
                  <td>{row.accountName}</td>
                  <td className="font-mono text-xs text-neutral-400">{row.accountClass}</td>
                  <td>
                    <Badge tone="neutral">{row.ebitdaBucket}</Badge>
                  </td>
                  <td className="text-right font-mono text-xs">{row.entryCount}</td>
                  <td className="text-right font-mono text-xs">{formatMoney(row.debitTotalTry)}</td>
                  <td className="text-right font-mono text-xs">{formatMoney(row.creditTotalTry)}</td>
                  <td className="text-right font-mono text-xs font-medium text-sky-300">
                    {formatMoney(row.debitBalanceTry)}
                  </td>
                  <td className="text-right font-mono text-xs font-medium text-amber-300">
                    {formatMoney(row.creditBalanceTry)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-neutral-700 font-semibold">
                <td colSpan={5}>GENEL MİZAN TOPLAMI</td>
                <td className="text-right font-mono">{formatMoney(overview.totalDebitTry)}</td>
                <td className="text-right font-mono">{formatMoney(overview.totalCreditTry)}</td>
                <td className="text-right font-mono text-sky-300">
                  {formatMoney(overview.totalDebitBalanceTry)}
                </td>
                <td className="text-right font-mono text-amber-300">
                  {formatMoney(overview.totalCreditBalanceTry)}
                </td>
              </tr>
            </tfoot>
          </TableShell>
        )}
      </Panel>

      {/* ② GELİR TABLOSU & YÖNETİM EBITDA ŞELALESİ ve ③ YÖNETİM BİLANÇOSU */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          title="② GELİR TABLOSU VE YÖNETİM EBITDA ŞELALESİ"
          subtitle="Net Satışlar → Brüt Kâr → Faaliyet Giderleri → EBIT + Amortisman (770.99) = Yönetim EBITDA → Finansman (780) → Vergi Öncesi Kâr."
        >
          <TableShell>
            <thead>
              <tr>
                <th>Gelir Tablosu / EBITDA Kalemi</th>
                <th className="text-right">Tutar (TRY)</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Brüt Satışlar (`600`–`602`)</td>
                <td className="text-right font-mono">{formatMoney(isSum.grossSalesTry)}</td>
              </tr>
              <tr>
                <td>Satış İndirimleri ve İadeler (`610`–`611`) (-)</td>
                <td className="text-right font-mono text-red-300">
                  -{formatMoney(isSum.salesDiscountsTry)}
                </td>
              </tr>
              <tr className="font-semibold">
                <td>NET SATIŞLAR</td>
                <td className="text-right font-mono">{formatMoney(isSum.netSalesTry)}</td>
              </tr>
              <tr>
                <td>Satışların Maliyeti (`620`–`622`, `730`) (-)</td>
                <td className="text-right font-mono text-red-300">-{formatMoney(isSum.cogsTry)}</td>
              </tr>
              <tr className="font-semibold">
                <td>BRÜT KÂR / (ZARAR)</td>
                <td className="text-right font-mono">{formatMoney(isSum.grossProfitTry)}</td>
              </tr>
              <tr>
                <td>Nakit Faaliyet Giderleri (`630`–`632`, `770` D&amp;A hariç) (-)</td>
                <td className="text-right font-mono text-red-300">
                  -{formatMoney(isSum.opexCashTry)}
                </td>
              </tr>
              <tr>
                <td>Amortisman ve İtfa Payları (`770.99` D&amp;A) (-)</td>
                <td className="text-right font-mono text-amber-300">
                  -{formatMoney(isSum.daAddbackTry)}
                </td>
              </tr>
              <tr className="font-semibold">
                <td>FAALİYET KÂRI (EBIT)</td>
                <td className="text-right font-mono">{formatMoney(isSum.ebitTry)}</td>
              </tr>
              <tr className="bg-emerald-950/30 font-bold text-emerald-300">
                <td>YÖNETİM EBITDA (EBIT + Amortisman Geri Eklemesi)</td>
                <td className="text-right font-mono">{formatMoney(isSum.managementEbitdaTry)}</td>
              </tr>
              <tr>
                <td>Diğer Olağan Gelir ve Kârlar / Giderler Net (`642`–`656`)</td>
                <td className="text-right font-mono">{formatMoney(isSum.otherNetIncomeTry)}</td>
              </tr>
              <tr>
                <td>Finansman Giderleri (`660`, `780` Faiz + BSMV/KKDF + Komisyon) (-)</td>
                <td className="text-right font-mono text-red-300">
                  -{formatMoney(isSum.financingExpenseTry)}
                </td>
              </tr>
              <tr className="font-semibold">
                <td>VERGİ ÖNCESİ YÖNETİM KÂRI / (ZARARI) (`690`)</td>
                <td className="text-right font-mono">{formatMoney(isSum.ebtTry)}</td>
              </tr>
              <tr>
                <td>Dönem Vergi Karşılığı (`691`) (-)</td>
                <td className="text-right font-mono text-red-300">
                  -{formatMoney(isSum.taxExpenseTry)}
                </td>
              </tr>
              <tr className="border-t border-neutral-700 font-bold">
                <td>DÖNEM NET KÂRI / (ZARARI) (`590` / `591`)</td>
                <td className="text-right font-mono">{formatMoney(isSum.netIncomeTry)}</td>
              </tr>
            </tbody>
          </TableShell>
        </Panel>

        <Panel
          title="③ YÖNETİM BİLANÇOSU (AKTİF = YABANCI KAYNAK + ÖZKAYNAK)"
          subtitle="Cari dönem net kâr/zararı otomatik olarak 590/591 özkaynak satırına yansıtılır; Aktif = Pasif kuruşu kuruşuna korunur."
        >
          {overview.balanceSheet.length === 0 ? (
            <EmptyState>Henüz yönetim bilançosu kaydı yok.</EmptyState>
          ) : (
            <TableShell>
              <thead>
                <tr>
                  <th>Kod</th>
                  <th>Bilanço Kalemi</th>
                  <th>Grup</th>
                  <th className="text-right">Tutar (TRY)</th>
                </tr>
              </thead>
              <tbody>
                {overview.balanceSheet.map((item) => (
                  <tr key={`${item.section}:${item.accountCode}`}>
                    <td className="font-mono text-xs">{item.accountCode}</td>
                    <td>{item.accountName}</td>
                    <td>
                      <Badge
                        tone={
                          item.section === "asset"
                            ? "blue"
                            : item.section === "liability"
                              ? "amber"
                              : "green"
                        }
                      >
                        {item.section === "asset"
                          ? "Aktif (Varlık)"
                          : item.section === "liability"
                            ? "Yabancı Kaynak"
                            : "Özkaynak"}
                      </Badge>
                    </td>
                    <td className="text-right font-mono text-xs">{formatMoney(item.amountTry)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-neutral-700 font-semibold">
                  <td colSpan={3}>AKTİF (VARLIKLAR) TOPLAMI</td>
                  <td className="text-right font-mono text-sky-300">
                    {formatMoney(overview.totalAssetsTry)}
                  </td>
                </tr>
                <tr className="font-semibold">
                  <td colSpan={3}>PASİF (YABANCI KAYNAK + ÖZKAYNAK) TOPLAMI</td>
                  <td className="text-right font-mono text-emerald-300">
                    {formatMoney(overview.totalLiabilitiesAndEquityTry)}
                  </td>
                </tr>
              </tfoot>
            </TableShell>
          )}
        </Panel>
      </div>

      {/* ④ YEVMİYE FİŞLERİ VE MANUEL TAHAKKUK / TERS KAYIT ÇEKMECESİ */}
      <Panel
        title="④ YEVMİYE FİŞLERİ, MANUEL DÖNEM SONU TAHAKKUKU VE TERS KAYIT (STORNO)"
        subtitle="Kesinleşmiş (posted) fişler veritabanı tetikleyicisiyle değiştirilemez ve silinemez; yalnız ters kayıt (reversal) açılarak düzeltilebilir."
      >
        {canPost ? (
          <form
            action={postManualAdjustmentAction}
            className="mb-4 grid grid-cols-2 gap-2 rounded border border-neutral-800 bg-neutral-950/60 p-3 text-xs sm:grid-cols-7"
          >
            <input
              type="date"
              name="entryDate"
              required
              defaultValue={new Date().toISOString().slice(0, 10)}
              className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5"
            />
            <select
              name="debitAccountCode"
              required
              defaultValue="770.99"
              className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5"
            >
              {accounts.length === 0 ? (
                <option value="770.99">Borç: 770.99 — Amortisman Giderleri</option>
              ) : (
                accounts.map((a) => (
                  <option key={`d:${a.code}`} value={a.code}>
                    Borç: {a.code} — {a.name}
                  </option>
                ))
              )}
            </select>
            <select
              name="creditAccountCode"
              required
              defaultValue="257"
              className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5"
            >
              {accounts.length === 0 ? (
                <option value="257">Alacak: 257 — Birikmiş Amortismanlar</option>
              ) : (
                accounts.map((a) => (
                  <option key={`c:${a.code}`} value={a.code}>
                    Alacak: {a.code} — {a.name}
                  </option>
                ))
              )}
            </select>
            <input
              type="number"
              step="0.01"
              min="0.01"
              name="amount"
              required
              placeholder="Tutar (ör. 25000)"
              className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5"
            />
            <select
              name="currency"
              defaultValue="TRY"
              className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5"
            >
              <option value="TRY">TRY</option>
              <option value="USD">USD</option>
              <option value="EUR">EUR</option>
              <option value="GBP">GBP</option>
            </select>
            <input
              name="description"
              required
              placeholder="Açıklama (ör. Aylık Amortisman Tahakkuku)"
              className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5"
            />
            <button
              type="submit"
              className="rounded bg-emerald-700 px-3 py-1.5 font-medium text-white"
            >
              Tahakkuk Fişi Kaydet
            </button>
          </form>
        ) : null}

        {recentEntriesRes.rows.length > 0 ? (
          <TableShell>
            <thead>
              <tr>
                <th>Fiş No</th>
                <th>Tarih</th>
                <th>Kaynak</th>
                <th>Açıklama</th>
                <th>Durum</th>
                <th className="text-right">Borç (TRY)</th>
                <th className="text-right">Alacak (TRY)</th>
                <th>İşlem</th>
              </tr>
            </thead>
            <tbody>
              {recentEntriesRes.rows.map((je) => (
                <tr key={je.id}>
                  <td className="font-mono text-xs">#{je.entry_no}</td>
                  <td className="font-mono text-xs">{je.entry_date}</td>
                  <td className="font-mono text-xs">{je.source_type}</td>
                  <td className="text-xs">
                    {je.description}
                    {je.needs_tax_split_review ? (
                      <span className="ml-2 rounded bg-amber-950/60 px-1.5 py-0.5 text-[10px] text-amber-300">
                        KDV Ayrımı İnceleme Bekliyor
                      </span>
                    ) : null}
                  </td>
                  <td>
                    <Badge
                      tone={
                        je.status === "posted"
                          ? "green"
                          : je.status === "provisional_fx"
                            ? "amber"
                            : je.status === "reversed"
                              ? "neutral"
                              : "blue"
                      }
                    >
                      {je.status}
                    </Badge>
                  </td>
                  <td className="text-right font-mono text-xs">
                    {je.debit_total_try ? formatMoney(je.debit_total_try) : "Kur Bekliyor"}
                  </td>
                  <td className="text-right font-mono text-xs">
                    {je.credit_total_try ? formatMoney(je.credit_total_try) : "Kur Bekliyor"}
                  </td>
                  <td>
                    <div className="flex items-center gap-1.5">
                      {je.status === "draft" && canApprove ? (
                        <form action={approveDraftEntryAction}>
                          <input type="hidden" name="entryId" value={je.id} />
                          <button
                            type="submit"
                            className="rounded bg-emerald-700 px-2 py-1 text-[11px] text-white"
                          >
                            Onayla (Post)
                          </button>
                        </form>
                      ) : null}
                      {je.status === "posted" && canReverse ? (
                        <form action={reverseEntryAction} className="flex items-center gap-1">
                          <input type="hidden" name="entryId" value={je.id} />
                          <input
                            name="reason"
                            defaultValue="Yönetim ters kaydı (storno)"
                            className="w-32 rounded border border-neutral-800 bg-neutral-900 px-1.5 py-0.5 text-[11px]"
                          />
                          <button
                            type="submit"
                            className="rounded border border-red-800/70 bg-red-950/50 px-2 py-0.5 text-[11px] text-red-200"
                          >
                            Ters Kayıt (Storno)
                          </button>
                        </form>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </TableShell>
        ) : (
          <EmptyState>
            Henüz yönetim yevmiye fişi yok — yukarıdan operasyonel senkronizasyonu çalıştırabilir veya manuel tahakkuk fişi girebilirsiniz.
          </EmptyState>
        )}
      </Panel>
    </div>
  );
}
