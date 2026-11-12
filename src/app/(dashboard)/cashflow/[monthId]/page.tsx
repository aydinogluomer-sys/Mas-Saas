import Link from "@/components/ui/app-link";
import { notFound } from "next/navigation";
import { getRequestUser } from "@/lib/auth";
import { canManagePeriodLock } from "@/lib/authz/matrix";
import { evaluatePeriodCloseReadiness } from "@/lib/cashflow/period-lock";
import { getPool } from "@/lib/db";
import { add, decimal, moneyOrNull, sub } from "@/lib/money";
import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { lockCashflowPeriodAction, reopenCashflowPeriodAction } from "../actions";
import { requireRouteAccess } from "@/lib/authz/route-guard";

export const dynamic = "force-dynamic";

const GROUPS: Array<[string, string]> = [
  ["customer_income", "MÜŞTERİ GELİRLERİ"],
  ["vendor_payment", "CARİ ÖDEMELER"],
  ["operational_cost", "İŞLETME GİDERLERİ (personel · genel)"],
  ["tax", "VERGİ / SGK"],
  ["loan_payment", "KREDİ / FİNANSMAN"],
  ["bank_balance", "BANKA / HESAP BAKİYELERİ"],
  ["adjustment", "YAN TAKİP (adjustment)"],
];

export default async function CashflowMonthPage({
  params,
  searchParams,
}: {
  params: Promise<{ monthId: string }>;
  searchParams?: Promise<{ error?: string; notice?: string }>;
}) {
  const denied = await requireRouteAccess("/cashflow/[monthId]");
  if (denied) return denied;
  const { monthId } = await params;
  const sp = (await searchParams) ?? {};
  const [pool, user] = [getPool(), await getRequestUser()];
  const canLock = user != null && canManagePeriodLock(user.role);

  const mRes = await pool.query(
    `select cm.id, to_char(cm.month_start,'YYYY-MM') as ym,
            cm.opening_balance as opening, cm.projected_income as income,
            cm.projected_expense as expense, cm.monthly_delta as delta,
            cm.closing_balance as closing, cm.status, cm.confidence,
            cm.source_workbook_id, cm.source_sheet_id, ss.sheet_name
     from public.cashflow_months cm
     left join public.source_sheets ss on ss.id = cm.source_sheet_id
     where cm.id::text = $1 or to_char(cm.month_start, 'YYYY-MM') = $1`,
    [monthId],
  );
  if (mRes.rowCount === 0) notFound();
  const raw = mRes.rows[0];
  const m = {
    ...raw,
    opening: moneyOrNull(raw.opening),
    income: moneyOrNull(raw.income),
    expense: moneyOrNull(raw.expense),
    delta: moneyOrNull(raw.delta),
    closing: moneyOrNull(raw.closing),
  };

  const [lines, readiness] = await Promise.all([
    pool.query(
      `select cl.id, cl.line_type, cl.direction, cl.label, cl.amount,
              cl.amount_status, p.name as party, ir.row_index
       from public.cashflow_lines cl
       left join public.parties p on p.id = cl.party_id
       left join public.import_rows ir on ir.id = cl.source_row_id
       where cl.cashflow_month_id = $1
       order by cl.line_type, ir.row_index nulls last`,
      [m.id],
    ),
    evaluatePeriodCloseReadiness(pool, m.id),
  ]);

  const lineRows = lines.rows.map((l) => ({ ...l, amount: moneyOrNull(l.amount) }));

  // devir + gelir − gider = kasa, checked within ±1 TL. Faz 17: evaluated in decimal.
  const identity =
    m.opening != null && m.income != null && m.expense != null && m.closing != null
      ? sub(sub(add(m.opening, m.income), m.expense), m.closing).abs().lte(decimal(1))
      : null;

  const head: Array<[string, number | null]> = [
    ["DEVİR", m.opening],
    ["GELİR", m.income],
    ["GİDER", m.expense],
    ["FARK", m.delta],
    ["KASA", m.closing],
  ];
  const fmt = (v: number | null) =>
    v != null ? new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 0 }).format(v) : "—";

  const others = lineRows.filter((l) => !GROUPS.some(([t]) => t === l.line_type));
  const returnTo = `/cashflow/${encodeURIComponent(monthId)}`;

  return (
    <>
      {sp.error ? (
        <div className="mb-3 rounded border border-red-700/60 bg-red-950/30 px-3 py-2 text-xs text-red-200">
          {sp.error}
        </div>
      ) : null}
      {sp.notice ? (
        <div className="mb-3 rounded border border-emerald-700/60 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-200">
          {sp.notice}
        </div>
      ) : null}

      <Panel
        title={`NAKİT AKIŞ — ${m.ym}`}
        right={
          <span className="flex items-center gap-2">
            {m.status === "locked" ? (
              <Badge tone="green">DÖNEM KİLİTLİ 🔒</Badge>
            ) : (
              <Badge tone="neutral">{m.status}</Badge>
            )}
            {identity == null ? (
              <Badge tone="amber">kimlik doğrulanamadı</Badge>
            ) : identity ? (
              <Badge tone="green">kasa = devir + gelir − gider ✓</Badge>
            ) : (
              <Badge tone="red">kimlik UYUŞMUYOR</Badge>
            )}
            <Link href="/cashflow" className="font-mono text-[10px] uppercase text-tone-2 underline underline-offset-2">
              ← nakit akış
            </Link>
          </span>
        }
      >
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          {head.map(([k, v]) => (
            <div key={k} className="border border-line bg-black/40 p-2">
              <div className="font-mono text-[9px] uppercase tracking-wider text-tone-3">{k}</div>
              <div className={`font-mono text-sm tabular-nums ${v != null && v < 0 ? "text-neg" : "text-tone-1"}`}>
                {fmt(v)}
              </div>
            </div>
          ))}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-3 font-mono text-[10px] text-tone-3">
          <span>durum: {m.status} · güven: {m.confidence}</span>
          {m.source_workbook_id && m.source_sheet_id && (
            <Link
              className="underline decoration-line-strong underline-offset-2"
              href={`/data/imports/${m.source_workbook_id}/sheets/${m.source_sheet_id}`}
            >
              kaynak sekme: {m.sheet_name} →
            </Link>
          )}
        </div>
      </Panel>

      <Panel
        title="DÖNEM KAPANIŞ KONTROL LİSTESİ & DÖNEM KİLİDİ"
        subtitle="PostgreSQL BEFORE tetikleyicisi kilitli döneme geçmişe dönük yazma/silmeyi doğrudan reddeder"
        right={
          readiness.status === "locked" ? (
            <Badge tone="green">
              kilitli{readiness.lockFingerprint ? ` · #${readiness.lockFingerprint.slice(0, 10)}` : ""}
            </Badge>
          ) : readiness.blockerCount > 0 ? (
            <Badge tone="red">{readiness.blockerCount} engelleyici</Badge>
          ) : readiness.warningCount > 0 ? (
            <Badge tone="amber">{readiness.warningCount} uyarı · kapatılabilir</Badge>
          ) : (
            <Badge tone="green">kapatmaya hazır</Badge>
          )
        }
      >
        <div className="space-y-2">
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            {readiness.items.map((item) => (
              <div key={item.code} className="flex items-start justify-between gap-3 border border-line bg-black/30 p-2.5 text-xs">
                <div>
                  <div className="font-medium text-tone-1">{item.label}</div>
                  <div className="mt-0.5 text-[11px] text-tone-3">{item.detail}</div>
                </div>
                <Badge
                  tone={
                    item.severity === "blocker" ? "red" : item.severity === "warning" ? "amber" : "green"
                  }
                >
                  {item.severity === "blocker" ? `ENGEL (${item.count})` : item.severity === "warning" ? `UYARI (${item.count})` : "TAMAM"}
                </Badge>
              </div>
            ))}
          </div>

          {readiness.lockedAt ? (
            <div className="font-mono text-[11px] text-tone-3">
              son kilitleme: {readiness.lockedAt}
              {readiness.lockedByName ? ` · ${readiness.lockedByName}` : ""}
              {readiness.lockFingerprint ? ` · parmak izi: ${readiness.lockFingerprint}` : ""}
            </div>
          ) : null}

          {readiness.reopenedAt ? (
            <div className="font-mono text-[11px] text-amber-300/90">
              son kilit açma: {readiness.reopenedAt}
              {readiness.reopenedByName ? ` · ${readiness.reopenedByName}` : ""}
              {readiness.reopenReason ? ` · gerekçe: "${readiness.reopenReason}"` : ""}
            </div>
          ) : null}

          {canLock && readiness.status !== "locked" ? (
            <form action={lockCashflowPeriodAction} className="mt-2 flex flex-wrap items-end gap-2 border-t border-line pt-2.5">
              <input type="hidden" name="monthId" value={m.id} />
              <input type="hidden" name="returnTo" value={returnTo} />
              <label className="flex min-w-60 flex-1 flex-col gap-1">
                <span className="font-mono text-[10px] uppercase tracking-wider text-tone-3">
                  Kapanış notu (isteğe bağlı)
                </span>
                <input
                  type="text"
                  name="notes"
                  maxLength={500}
                  placeholder="Ay sonu mutabakatı tamamlandı"
                  className="field-control px-2 py-1.5 text-xs"
                />
              </label>
              <button
                type="submit"
                disabled={!readiness.readyToLock}
                title={
                  readiness.readyToLock
                    ? "Dönemi veritabanı seviyesinde kilitle"
                    : "Engelleyici maddeler çözülmeden dönem kilitlenemez"
                }
                className="button-ghost px-3 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-50"
              >
                Dönemi kilitle
              </button>
            </form>
          ) : null}

          {canLock && readiness.status === "locked" ? (
            <details className="mt-2 border border-amber-800/50 bg-amber-950/20 p-2.5">
              <summary className="cursor-pointer font-mono text-xs text-amber-200">
                Kilidi yeniden aç
              </summary>
              <form action={reopenCashflowPeriodAction} className="mt-2.5 flex flex-wrap items-end gap-2">
                <input type="hidden" name="monthId" value={m.id} />
                <input type="hidden" name="returnTo" value={returnTo} />
                <label className="flex min-w-70 flex-1 flex-col gap-1">
                  <span className="font-mono text-[10px] uppercase tracking-wider text-amber-200/80">
                    Zorunlu yeniden açma gerekçesi (en az 10 karakter)
                  </span>
                  <input
                    required
                    minLength={10}
                    maxLength={500}
                    type="text"
                    name="reason"
                    placeholder="Örn: Geç gelen tedarikçi faturası düzeltmesi için"
                    className="field-control px-2 py-1.5 text-xs"
                  />
                </label>
                <button type="submit" className="button-ghost px-3 py-1.5 text-xs text-amber-200">
                  Kilidi aç
                </button>
              </form>
            </details>
          ) : null}

          {!canLock ? (
            <div className="border-t border-line pt-2 font-mono text-[11px] text-tone-3">
              Dönem kilitleme ve yeniden açma işlemleri yalnız Finans Yöneticisi veya Yönetici yetkisiyle yapılabilir.
            </div>
          ) : null}
        </div>
      </Panel>

      {GROUPS.map(([type, title]) => {
        const list = lineRows.filter((l) => l.line_type === type);
        if (list.length === 0) return null;
        return (
          <Panel key={type} title={`${title} — ${list.length}`}>
            <table className="w-full text-sm">
              <tbody>
                {list.map((l) => (
                  <tr key={l.id} className="border-b border-line-faint">
                    <td className="w-10 py-1 pr-2 font-mono text-xs text-tone-3">
                      {l.row_index != null ? `r${l.row_index}` : "—"}
                    </td>
                    <td className="py-1 pr-2">
                      {l.label}
                      {l.party && <span className="ml-2 font-mono text-[10px] text-info">↔ {l.party}</span>}
                    </td>
                    <td className={`py-1 text-right font-mono tabular-nums ${l.amount != null && l.amount < 0 ? "text-neg" : ""}`}>
                      {l.amount != null ? fmt(l.amount) : <Badge tone="amber">TUTAR EKSİK</Badge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        );
      })}

      {others.length > 0 && (
        <Panel title={`DİĞER SATIRLAR — ${others.length}`}>
          <table className="w-full text-sm">
            <tbody>
              {others.map((l) => (
                <tr key={l.id} className="border-b border-line-faint">
                  <td className="w-24 py-1 pr-2 font-mono text-[10px] text-tone-3">{l.line_type}</td>
                  <td className="py-1 pr-2">{l.label}</td>
                  <td className={`py-1 text-right font-mono tabular-nums ${l.amount != null && l.amount < 0 ? "text-neg" : ""}`}>
                    {l.amount != null ? fmt(l.amount) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}
    </>
  );
}
