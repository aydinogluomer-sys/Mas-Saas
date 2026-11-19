import Link from "@/components/ui/app-link";
import { can } from "@/lib/authz/matrix";
import { requireRouteAccess } from "@/lib/authz/route-guard";
import { loadBudgetVarianceSummary } from "@/lib/budget/engine";
import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { EmptyState, KpiCard, PageHeader, TableShell } from "@/components/ui/shell";
import { loadCashMonths } from "@/lib/cashflow/engine";
import { getPool } from "@/lib/db";
import { formatMoney } from "@/lib/money-format";
import { findContinuityIssues } from "@/lib/radar/rules";

export const dynamic = "force-dynamic";

export default async function CashflowControls(props: {
  searchParams?: Promise<{ error?: string; result?: string }>;
}) {
  const denied = await requireRouteAccess("/cashflow/controls");
  if (denied) return denied;
  const sp = (await props?.searchParams) ?? {};
  const session = await import("@/lib/auth").then((m) => m.getRequestUser()).catch(() => null);
  const canTask = session ? can(session.role, "action_items", "insert") : false;
  const createReconciliationTaskAction = canTask
    ? (await import("@/app/(dashboard)/data/reconciliation/actions")).createReconciliationTaskAction
    : null;

  const pool = getPool();
  const queryErrors: string[] = [];

  const [months, reviews, budgetVariances, controlAlertsRes, unmatchedBankRes, brokenPromisesRes, periodStatsRes] =
    await Promise.all([
      loadCashMonths(pool),
      pool.query(
        `select id, issue_type, severity, message, status
           from public.mapping_reviews
          where issue_type in ('continuity_break','month_gap')
          order by created_at desc
          limit 50`,
      ),
      loadBudgetVarianceSummary(pool),
      pool
        .query<{
          id: string;
          rule_code: string;
          severity: string;
          title: string;
          summary: string | null;
          status: string;
          detected_at: string;
        }>(
          `select id::text, rule_code, severity, title, summary, status,
                  to_char(detected_at at time zone 'Europe/Istanbul', 'YYYY-MM-DD HH24:MI') as detected_at
             from public.control_alerts
            where status in ('open', 'acknowledged', 'snoozed')
            order by case severity when 'critical' then 1 when 'high' then 2 when 'medium' then 3 else 4 end,
                     detected_at desc
            limit 40`,
        )
        .then((r) => ({ ok: true as const, rows: r.rows }))
        .catch(() => {
          queryErrors.push("control_alerts");
          return { ok: false as const, rows: null };
        }),
      pool
        .query<{ cnt: string; aged_cnt: string }>(
          `select count(*)::text as cnt,
                  count(*) filter (where txn_date <= current_date - interval '7 days')::text as aged_cnt
             from public.bank_transactions
            where match_status = 'unmatched'
              and status <> 'ignored'
              and coalesce(classification, '') <> 'own_transfer'`,
        )
        .then((r) => ({ ok: true as const, row: r.rows[0] ?? { cnt: "0", aged_cnt: "0" } }))
        .catch(() => {
          queryErrors.push("bank_transactions");
          return { ok: false as const, row: null };
        }),
      pool
        .query<{ cnt: string }>(
          `select count(*)::text as cnt
             from public.promises_to_pay
            where status in ('open', 'broken')
              and promised_date < current_date`,
        )
        .then((r) => ({ ok: true as const, row: r.rows[0] ?? { cnt: "0" } }))
        .catch(() => {
          queryErrors.push("promises_to_pay");
          return { ok: false as const, row: null };
        }),
      pool
        .query<{ locked_cnt: string; open_cnt: string }>(
          `select count(*) filter (where status = 'locked')::text as locked_cnt,
                  count(*) filter (where status in ('open', 'closing'))::text as open_cnt
             from public.accounting_periods`,
        )
        .then((r) => ({ ok: true as const, row: r.rows[0] ?? { locked_cnt: "0", open_cnt: "0" } }))
        .catch(() => {
          queryErrors.push("accounting_periods");
          return { ok: false as const, row: null };
        }),
    ]);

  const rawIssues = findContinuityIssues(months);
  const c = { breaks: rawIssues.breaks.length, gaps: rawIssues.gaps.length };
  const missing = months.filter((m) => [m.opening, m.income, m.expense, m.closing].some((v) => v == null));
  const liveAlerts = controlAlertsRes.ok ? controlAlertsRes.rows : [];
  const unmatchedBankCount = unmatchedBankRes.ok ? Number(unmatchedBankRes.row.cnt) : null;
  const agedUnmatchedCount = unmatchedBankRes.ok ? Number(unmatchedBankRes.row.aged_cnt) : null;
  const brokenPromiseCount = brokenPromisesRes.ok ? Number(brokenPromisesRes.row.cnt) : null;
  const lockedPeriods = periodStatsRes.ok ? Number(periodStatsRes.row.locked_cnt) : null;
  const openPeriods = periodStatsRes.ok ? Number(periodStatsRes.row.open_cnt) : null;

  const knownOpenSignals =
    (controlAlertsRes.ok ? liveAlerts.length : 0) +
    (agedUnmatchedCount !== null ? agedUnmatchedCount : 0) +
    (brokenPromiseCount !== null ? brokenPromiseCount : 0) +
    c.breaks +
    c.gaps;
  const hasQueryErrors = queryErrors.length > 0;

  return (
    <>
      <PageHeader
        title="Canlı Nakit Akışı & İç Kontrol İstisnaları"
        subtitle="Canlı control_alerts motoru, yaşlanmış eşleşmemiş banka hareketleri, gecikmiş ödeme sözleri, dönem kilitleri ve bütçe sapmaları"
        meta={
          <div className="flex flex-wrap items-center gap-2">
            {hasQueryErrors ? (
              <Badge tone="red" dot>
                {knownOpenSignals > 0
                  ? `${knownOpenSignals}+ sinyal · BİLİNMİYOR (${queryErrors.length} sorgu hatası)`
                  : `BİLİNMİYOR (${queryErrors.length} sorgu okunamadı)`}
              </Badge>
            ) : (
              <Badge tone={knownOpenSignals > 0 ? "red" : "green"} dot>
                {knownOpenSignals} aktif kontrol sinyali
              </Badge>
            )}
            <Link href="/system/controls" className="button-ghost px-2.5 py-1 text-xs">
              İç Kontrol Merkezi →
            </Link>
          </div>
        }
      />

      {hasQueryErrors ? (
        <div
          role="alert"
          className="rounded border border-neg/50 bg-neg/10 px-3 py-2 text-xs text-neg"
        >
          <span className="font-semibold">
            Kontrol sorgularının bir kısmı okunamadı (BİLİNMİYOR — 0 kabul edilmez):
          </span>{" "}
          <span className="font-mono">{queryErrors.join(", ")}</span>
        </div>
      ) : null}

      {sp.error ? (
        <div className="rounded border border-neg/40 bg-neg/10 px-3 py-2 text-xs text-neg">{sp.error}</div>
      ) : null}
      {sp.result ? (
        <div className="rounded border border-pos/40 bg-pos/10 px-3 py-2 text-xs text-pos">
          İşlem tamamlandı: {sp.result}
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <KpiCard
          label="Canlı Kontrol Uyarısı"
          value={controlAlertsRes.ok ? liveAlerts.length : "?"}
          tone={!controlAlertsRes.ok || liveAlerts.length > 0 ? "neg" : "pos"}
          note={controlAlertsRes.ok ? "control_alerts" : "sorgu okunamadı"}
        />
        <KpiCard
          label="Eşleşmemiş Banka (7g+)"
          value={unmatchedBankRes.ok ? `${agedUnmatchedCount} / ${unmatchedBankCount}` : "?"}
          tone={!unmatchedBankRes.ok ? "neg" : agedUnmatchedCount !== null && agedUnmatchedCount > 0 ? "warn" : "pos"}
          note={unmatchedBankRes.ok ? "102.99 mutabakat" : "sorgu okunamadı"}
        />
        <KpiCard
          label="Aşılmış Ödeme Sözü"
          value={brokenPromisesRes.ok ? brokenPromiseCount! : "?"}
          tone={!brokenPromisesRes.ok || (brokenPromiseCount !== null && brokenPromiseCount > 0) ? "neg" : "pos"}
          note={brokenPromisesRes.ok ? "promises_to_pay" : "sorgu okunamadı"}
        />
        <KpiCard
          label="Dönem Kilit Otoritesi"
          value={periodStatsRes.ok ? `${lockedPeriods} Kilitli` : "?"}
          tone={periodStatsRes.ok ? "info" : "warn"}
          note={periodStatsRes.ok ? `${openPeriods} açık dönem` : "sorgu okunamadı"}
        />
        <KpiCard label="Devir Kırığı" value={c.breaks} tone={c.breaks ? "neg" : "pos"} />
        <KpiCard
          label="Ay Boşluğu / Eksik"
          value={c.gaps + missing.length}
          tone={c.gaps + missing.length ? "warn" : "pos"}
        />
      </div>

      <Panel
        title={`CANLI İÇ KONTROL & MUTABAKAT UYARILARI — ${controlAlertsRes.ok ? liveAlerts.length : "?"}`}
        subtitle="Sistem içi otomatik denetim kurallarından (control_alerts) ve banka/söz istisnalarından beslenen canlı kuyruk"
        right={
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Link href="/finance/bank" className="underline" style={{ color: "var(--accent)" }}>
              Banka Eşleştirme ({unmatchedBankCount !== null ? unmatchedBankCount : "?"})
            </Link>
            <span>·</span>
            <Link href="/finance/promises" className="underline" style={{ color: "var(--accent)" }}>
              Ödeme Sözleri ({brokenPromiseCount !== null ? brokenPromiseCount : "?"})
            </Link>
            <span>·</span>
            <Link href="/cashflow/close" className="underline" style={{ color: "var(--accent)" }}>
              Dönem Kapanışı
            </Link>
          </div>
        }
      >
        {!controlAlertsRes.ok ? (
          <EmptyState>
            Canlı iç kontrol kuyruğu (`control_alerts`) okunamadı — durum BİLİNMİYOR (0 kabul edilmez).
          </EmptyState>
        ) : liveAlerts.length === 0 ? (
          <EmptyState>Açık canlı iç kontrol uyarısı (`control_alerts`) bulunmuyor.</EmptyState>
        ) : (
          <TableShell>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left uppercase" style={{ color: "var(--text-2)" }}>
                  <th className="py-1.5">Önem</th>
                  <th>Kural Kodu</th>
                  <th>Başlık & Açıklama</th>
                  <th>Durum</th>
                  <th>Tespit</th>
                  <th className="text-right">Aksiyon</th>
                </tr>
              </thead>
              <tbody>
                {liveAlerts.map((a) => (
                  <tr
                    key={a.id}
                    className="border-t"
                    style={{ borderColor: "var(--line)", color: "var(--text-1)" }}
                  >
                    <td className="py-2">
                      <Badge tone={a.severity === "critical" || a.severity === "high" ? "red" : "amber"}>
                        {a.severity}
                      </Badge>
                    </td>
                    <td className="font-mono">{a.rule_code}</td>
                    <td className="py-2">
                      <div className="font-medium">{a.title}</div>
                      {a.summary ? (
                        <div className="mt-0.5" style={{ color: "var(--text-2)" }}>
                          {a.summary}
                        </div>
                      ) : null}
                    </td>
                    <td>
                      <Badge tone="neutral">{a.status}</Badge>
                    </td>
                    <td className="font-mono tabular-nums" style={{ color: "var(--text-3)" }}>
                      {a.detected_at}
                    </td>
                    <td className="text-right">
                      {canTask && createReconciliationTaskAction ? (
                        <form action={createReconciliationTaskAction}>
                          <input type="hidden" name="returnTo" value="/cashflow/controls" />
                          <input
                            type="hidden"
                            name="title"
                            value={`[${a.rule_code}] ${String(a.title ?? "").slice(0, 110)}`}
                          />
                          <input
                            type="hidden"
                            name="severity"
                            value={a.severity === "critical" ? "critical" : a.severity === "high" ? "high" : "medium"}
                          />
                          <input type="hidden" name="relatedEntityTable" value="control_alerts" />
                          <input type="hidden" name="relatedEntityId" value={a.id} />
                          <input type="hidden" name="note" value={a.summary ?? a.title} />
                          <button
                            type="submit"
                            className="rounded border px-2 py-1 text-[11px] font-medium"
                            style={{
                              background: "var(--surface-2)",
                              borderColor: "var(--line)",
                              color: "var(--text-1)",
                            }}
                          >
                            Takip görevi aç
                          </button>
                        </form>
                      ) : (
                        <Link href="/system/controls" className="underline" style={{ color: "var(--accent)" }}>
                          İncele
                        </Link>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        )}
      </Panel>

      <Panel title="TARİHSEL DEVİR ZİNCİRİ KONTROL KAYITLARI">
        {reviews.rows.length ? (
          reviews.rows.map((r) => (
            <div key={r.id} className="row-hover flex items-center justify-between gap-2 border-b border-line-faint py-2">
              <div>
                <div className="flex gap-2">
                  <Badge tone={r.severity === "critical" || r.severity === "high" ? "red" : "amber"}>
                    {r.severity}
                  </Badge>
                  <Badge tone="neutral">{r.status}</Badge>
                  <span className="font-mono text-xs">{r.issue_type}</span>
                </div>
                <p className="mt-1 text-xs text-tone-3">{r.message}</p>
              </div>
              {canTask && createReconciliationTaskAction ? (
                <form action={createReconciliationTaskAction}>
                  <input type="hidden" name="returnTo" value="/cashflow/controls" />
                  <input type="hidden" name="title" value={`[${r.issue_type}] ${String(r.message ?? "").slice(0, 120)}`} />
                  <input
                    type="hidden"
                    name="severity"
                    value={r.severity === "critical" ? "critical" : r.severity === "high" ? "high" : "medium"}
                  />
                  <input type="hidden" name="relatedEntityTable" value="mapping_reviews" />
                  <input type="hidden" name="relatedEntityId" value={r.id} />
                  <input type="hidden" name="note" value={r.message ?? ""} />
                  <button
                    type="submit"
                    className="rounded border px-2 py-1 font-mono text-[10px]"
                    style={{
                      background: "var(--surface-2)",
                      borderColor: "var(--line)",
                      color: "var(--text-1)",
                    }}
                  >
                    Takip görevi aç
                  </button>
                </form>
              ) : null}
            </div>
          ))
        ) : (
          <p className="text-sm text-tone-3">Açık zincir kontrol kaydı yok.</p>
        )}
      </Panel>

      <Panel
        title={`BÜTÇE SAPMA ÖZETİ (KONTROL GÖRÜNÜMÜ) — ${budgetVariances.length}`}
        subtitle="Onaylı bütçelerin döviz ve yön bazında toplulaştırılmış sapma, aşım kalemi ve ölçülmemiş satır kontrolü"
      >
        {budgetVariances.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--text-2)" }}>
            Henüz onaylı bütçe sapma özeti kaydı bulunmuyor.
          </p>
        ) : (
          <TableShell>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left uppercase" style={{ color: "var(--text-2)" }}>
                  <th className="py-1.5">Bütçe</th>
                  <th>Yıl</th>
                  <th>Yön</th>
                  <th>Döviz</th>
                  <th className="text-right">Satır</th>
                  <th className="text-right">Bütçe Toplamı</th>
                  <th className="text-right">Gerçekleşen</th>
                  <th className="text-right">Sapma</th>
                  <th className="text-right">Aşım</th>
                  <th className="text-right">Ölçülmemiş</th>
                </tr>
              </thead>
              <tbody>
                {budgetVariances.map((bv) => (
                  <tr
                    key={`${bv.budgetId}-${bv.direction}-${bv.currency}`}
                    className="border-t"
                    style={{ borderColor: "var(--line)", color: "var(--text-1)" }}
                  >
                    <td className="py-1.5 font-medium">{bv.budgetName}</td>
                    <td className="font-mono tabular-nums">{bv.fiscalYear}</td>
                    <td>{bv.direction === "income" ? "Gelir" : "Gider"}</td>
                    <td className="font-mono">{bv.currency}</td>
                    <td className="text-right font-mono tabular-nums">{bv.lineCount}</td>
                    <td className="text-right font-mono tabular-nums">
                      {formatMoney(bv.budgetTotal, bv.currency)}
                    </td>
                    <td className="text-right font-mono tabular-nums">
                      {bv.actualTotal == null ? "—" : formatMoney(bv.actualTotal, bv.currency)}
                    </td>
                    <td
                      className={`text-right font-mono tabular-nums ${
                        bv.varianceTotal != null && bv.varianceTotal < 0 ? "text-neg" : ""
                      }`}
                    >
                      {bv.varianceTotal == null ? "—" : formatMoney(bv.varianceTotal, bv.currency)}
                    </td>
                    <td className="text-right">
                      {bv.overBudgetLines > 0 ? (
                        <Badge tone="red">{bv.overBudgetLines} kalem</Badge>
                      ) : (
                        <span className="font-mono text-pos">0</span>
                      )}
                    </td>
                    <td className="text-right font-mono tabular-nums" style={{ color: "var(--text-2)" }}>
                      {bv.notMeasuredLines}
                      {bv.departmentLinesUnmeasurable > 0
                        ? ` (${bv.departmentLinesUnmeasurable} dep.)`
                        : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        )}
      </Panel>
    </>
  );
}
