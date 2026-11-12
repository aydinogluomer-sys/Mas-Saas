import { getRequestUser } from "@/lib/auth";
import { can } from "@/lib/authz/matrix";
import { requireRouteAccess } from "@/lib/authz/route-guard";
import { ReconciliationTable, type ReconRow } from "@/components/data/reconciliation-table";
import { Badge } from "@/components/ui/badge";
import { Panel, fmtTL } from "@/components/ui/panel";
import { EmptyState, KeyStat, PageHeader, TableShell } from "@/components/ui/shell";
import { loadDataQualityCenter } from "@/lib/data-quality/engine";
import { getPool } from "@/lib/db";
import {
  RECONCILIATION_SCOPES,
  RECONCILIATION_SCOPE_LABEL,
  listReconciliationSignoffs,
} from "@/lib/reconciliation/signoffs";
import {
  createReconciliationTaskAction,
  signOffReconciliationAction,
} from "./actions";

export const dynamic = "force-dynamic";

export default async function ReconciliationPage({
  searchParams,
}: {
  searchParams?: Promise<{ error?: string; result?: string }>;
}) {
  const denied = await requireRouteAccess("/data/reconciliation");
  if (denied) return denied;
  const sp = (await searchParams) ?? {};
  const session = await getRequestUser();
  const canSign = session ? can(session.role, "reconciliation_signoffs", "insert") : false;
  const canTask = session ? can(session.role, "action_items", "insert") : false;

  const pool = getPool();
  const [d, signoffs, treasuryRecon] = await Promise.all([
    loadDataQualityCenter(pool),
    listReconciliationSignoffs(pool, 30),
    pool.query(
      `select to_char(month_start, 'YYYY-MM') as month_ym,
              cashflow_closing,
              treasury_closing,
              difference,
              reconciliation_status
         from public.treasury_cashflow_reconciliation
        order by month_start desc
        limit 24`,
    ),
  ]);

  const rows: ReconRow[] = d.cashflowReconciliation.map((r) => ({
    month: r.month_start.slice(0, 7),
    app_opening: r.app_opening,
    source_opening: r.source_opening,
    app_closing: r.app_closing,
    source_closing: r.source_closing,
  }));

  const divergentMonths = treasuryRecon.rows.filter((r) => r.reconciliation_status === "divergent");
  const currentYm = new Date().toISOString().slice(0, 7);

  return (
    <>
      <PageHeader
        title="Mutabakat ve Dönem İmzalama"
        subtitle="Banka/kasa, cari ve çalışma kitabı farklarından görev üretimi ve değiştirilemez (append-only) dönem imzası"
        meta={
          <Badge tone={divergentMonths.length > 0 ? "amber" : "green"} dot>
            {divergentMonths.length > 0 ? `${divergentMonths.length} ay fark içeriyor` : "fark yok"}
          </Badge>
        }
      />

      {sp.error ? (
        <div className="rounded border border-red-800 bg-red-950/60 px-3 py-2 text-xs text-red-200">{sp.error}</div>
      ) : null}
      {sp.result ? (
        <div className="rounded border border-emerald-800 bg-emerald-950/50 px-3 py-2 text-xs text-emerald-200">
          İşlem tamamlandı: {sp.result}
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <KeyStat
          label="Hazine ↔ Nakit Akışı Farklı Ay"
          value={divergentMonths.length}
          tone={divergentMonths.length > 0 ? "warn" : "pos"}
        />
        <KeyStat label="Kayıtlı Dönem İmzası" value={signoffs.length} tone="info" />
        <KeyStat
          label="Excel Sürüm Karşılaştırması"
          value={d.workbookDiff.ready ? "Hazır" : "Bekliyor"}
          tone="neutral"
        />
      </div>

      {(canSign || canTask) ? (
        <Panel
          title="DÖNEM MUTABAKAT İMZALAMA VE GÖREV ÜRETİMİ"
          subtitle="imzalanan mutabakat kayıtları kanıt (evidence) sınıfındadır; sonradan değiştirilemez veya silinemez"
        >
          <div className="grid gap-3 lg:grid-cols-2">
            {canSign ? (
              <form
                action={signOffReconciliationAction}
                className="grid grid-cols-2 gap-2 rounded border border-neutral-800 bg-neutral-950/50 p-3 text-xs"
              >
                <div className="col-span-2 font-medium text-neutral-200">Dönem Mutabakatını İmzala</div>
                <input
                  name="periodMonth"
                  type="month"
                  defaultValue={currentYm}
                  required
                  className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5"
                />
                <select name="scope" className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5">
                  {RECONCILIATION_SCOPES.map((s) => (
                    <option key={s} value={s}>{RECONCILIATION_SCOPE_LABEL[s]}</option>
                  ))}
                </select>
                <select name="status" className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5">
                  <option value="signed_clean">Temiz imzalandı (0 fark)</option>
                  <option value="signed_with_exceptions">İstisnalı imzalandı (fark gerekçeli)</option>
                </select>
                <input
                  name="openExceptionCount"
                  type="number"
                  min={0}
                  defaultValue={divergentMonths.length}
                  className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5"
                  placeholder="Açık fark adedi"
                />
                <input
                  name="notes"
                  placeholder="Mutabakat notu / istisna gerekçesi"
                  className="col-span-2 rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5"
                />
                <button className="col-span-2 rounded bg-emerald-700 px-3 py-1.5 font-medium text-white">
                  Mutabakatı imzala
                </button>
              </form>
            ) : null}

            {canTask ? (
              <form
                action={createReconciliationTaskAction}
                className="grid grid-cols-2 gap-2 rounded border border-neutral-800 bg-neutral-950/50 p-3 text-xs"
              >
                <input type="hidden" name="returnTo" value="/data/reconciliation" />
                <div className="col-span-2 font-medium text-neutral-200">Mutabakat Farkından Takip Görevi Oluştur</div>
                <input
                  name="title"
                  required
                  placeholder={`Ör. ${currentYm} banka kapanış farkı incelemesi`}
                  className="col-span-2 rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5"
                />
                <select name="severity" className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5">
                  <option value="high">Yüksek öncelik</option>
                  <option value="critical">Kritik</option>
                  <option value="medium">Normal</option>
                </select>
                <input
                  name="note"
                  placeholder="Fark tutarı / açıklama"
                  className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5"
                />
                <button className="col-span-2 rounded bg-sky-700 px-3 py-1.5 font-medium text-white">
                  Aksiyon görevi aç
                </button>
              </form>
            ) : null}
          </div>
        </Panel>
      ) : null}

      {treasuryRecon.rows.length > 0 ? (
        <Panel title="HAZİNE (BANKA) ↔ NAKİT AKIŞI AYLIK MUTABAKATI" subtitle="fark içeren aylardan tek tıkla görev üretin">
          <TableShell>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-neutral-500">
                  <th className="py-1">Dönem</th>
                  <th className="text-right">Nakit Akışı Kapanış</th>
                  <th className="text-right">Banka Hazine Kapanış</th>
                  <th className="text-right">Fark</th>
                  <th>Durum</th>
                  <th className="text-right">Görev</th>
                </tr>
              </thead>
              <tbody>
                {treasuryRecon.rows.map((r) => (
                  <tr key={r.month_ym} className="border-t border-neutral-800">
                    <td className="py-1.5 font-mono text-xs">{r.month_ym}</td>
                    <td className="text-right tabular-nums">
                      {r.cashflow_closing == null ? "—" : fmtTL(Number(r.cashflow_closing))}
                    </td>
                    <td className="text-right tabular-nums">
                      {r.treasury_closing == null ? "—" : fmtTL(Number(r.treasury_closing))}
                    </td>
                    <td className="text-right tabular-nums">
                      {r.difference == null ? "—" : fmtTL(Number(r.difference))}
                    </td>
                    <td>
                      <Badge tone={r.reconciliation_status === "aligned" ? "green" : "amber"}>
                        {r.reconciliation_status}
                      </Badge>
                    </td>
                    <td className="text-right">
                      {canTask && r.reconciliation_status !== "aligned" ? (
                        <form action={createReconciliationTaskAction} className="inline">
                          <input type="hidden" name="returnTo" value="/data/reconciliation" />
                          <input
                            type="hidden"
                            name="title"
                            value={`${r.month_ym as string} hazine-nakit mutabakat farkı (${r.reconciliation_status as string})`}
                          />
                          <input type="hidden" name="severity" value="high" />
                          <input
                            type="hidden"
                            name="note"
                            value={`Fark: ${r.difference == null ? "bilinmiyor" : fmtTL(Number(r.difference))}`}
                          />
                          <button className="rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-200 hover:bg-neutral-700">
                            Görev üret
                          </button>
                        </form>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        </Panel>
      ) : null}

      <Panel title="İMZALANMIŞ DÖNEM MUTABAKATLARI">
        {signoffs.length === 0 ? (
          <EmptyState>Henüz imzalanmış dönem mutabakatı yok.</EmptyState>
        ) : (
          <TableShell>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-neutral-500">
                  <th className="py-1">Dönem</th>
                  <th>Kapsam</th>
                  <th>Durum</th>
                  <th className="text-right">Açık Fark</th>
                  <th>Not</th>
                  <th>İmza Zamanı</th>
                </tr>
              </thead>
              <tbody>
                {signoffs.map((s) => (
                  <tr key={s.id} className="border-t border-neutral-800">
                    <td className="py-1.5 font-mono text-xs">{s.periodMonth}</td>
                    <td className="text-xs">{RECONCILIATION_SCOPE_LABEL[s.scope] ?? s.scope}</td>
                    <td>
                      <Badge tone={s.status === "signed_clean" ? "green" : "amber"}>
                        {s.status === "signed_clean" ? "temiz imzalandı" : "istisnalı imzalandı"}
                      </Badge>
                    </td>
                    <td className="text-right tabular-nums">{s.openExceptionCount}</td>
                    <td className="text-xs text-neutral-400">{s.notes ?? "—"}</td>
                    <td className="font-mono text-xs text-neutral-500">{s.signedAt}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        )}
      </Panel>

      <Panel title="Excel sürüm farkı">
        <p className="text-sm">
          Karşılaştırma: {d.workbookDiff.ready ? "hazır" : "en az iki çalışma kitabı gerekli"}
        </p>
        {d.workbookDiff.changedSheets.map((s) => (
          <div key={`${s.sheet_name}-${s.side}`} className="border-t border-line-faint py-2 text-sm">
            {s.sheet_name} · {s.side} · {s.impact}
          </div>
        ))}
      </Panel>

      <Panel title="Nakit akışı mutabakatı" subtitle="En büyük uygulama-kaynak farkı üstte">
        <ReconciliationTable rows={rows} />
      </Panel>
    </>
  );
}
