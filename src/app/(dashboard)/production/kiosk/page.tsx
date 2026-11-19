// Atölye Kiosk (QR / Barkod İstasyonu) — Sıfır Finansal Sızıntı (Zero Financial Leakage):
// Yalnız saha operasyon kolonlarını sorgular (order_no, part_code/part_name, work_center,
// planned_qty, good_qty, scrap_qty, status, downtime_reason, operator_note, last_kiosk_event_at).
// Kasa, banka, kredi, maaş, birim satış fiyatı veya ciro verisi ASLA sorgulanmaz ve gösterilmez.

import Link from "@/components/ui/app-link";
import { FolioQrBadgeSvg, RadialMeterSvg } from "@/components/charts/folio-visuals";
import { Badge, type Tone } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { EmptyState, PageHeader } from "@/components/ui/shell";
import { SubmitButton } from "@/components/ui/submit-button";
import { getRequestUser } from "@/lib/auth";
import { can } from "@/lib/authz/matrix";
import { requireRouteAccess } from "@/lib/authz/route-guard";
import { getPool } from "@/lib/db";
import { isMissingSchemaError } from "@/lib/ledger/accounts";
import { decimal, rate } from "@/lib/money";
import {
  OPERATION_TYPE_LABEL,
  WORK_ORDER_STATUS_LABEL,
  type WorkCenterOperationType,
  type WorkOrderStatus,
} from "@/lib/production/erp-lite";
import {
  kioskCompleteWorkOrderAction,
  kioskRecordOutputAndScrapAction,
  kioskReportDowntimeAction,
  kioskStartWorkOrderAction,
} from "./actions";

export const dynamic = "force-dynamic";

interface KioskWorkOrderDbRow {
  id: string;
  order_no: string;
  part_code: string | null;
  part_name: string | null;
  work_center_code: string;
  work_center_name: string;
  operation_type: string;
  planned_qty: string;
  good_qty: string;
  scrap_qty: string;
  planned_minutes: string;
  actual_run_minutes: string;
  downtime_minutes: string;
  downtime_reason: string | null;
  operator_note: string | null;
  status: WorkOrderStatus;
  due_date: string | null;
  started_at: string | null;
  completed_at: string | null;
  last_kiosk_event_at: string | null;
}

const STATUS_TONE: Record<WorkOrderStatus, Tone> = {
  planned: "amber",
  in_progress: "blue",
  completed: "green",
  cancelled: "neutral",
};

const DOWNTIME_REASON_PRESETS = [
  "Takım değişimi / uç kırılması",
  "İlk parça kalite onayı bekleniyor",
  "Hammadde / aparat hazırlığı",
  "Program / CAM revizyonu",
  "Planlı koruyucu bakım",
  "Tezgâh arızası",
] as const;

export default async function ProductionKioskPage({
  searchParams,
}: {
  searchParams?: Promise<{ code?: string; status?: string; result?: string; error?: string }>;
}) {
  const denied = await requireRouteAccess("/production/kiosk");
  if (denied) return denied;

  const session = await getRequestUser();
  const canOperateKiosk = session ? can(session.role, "work_orders", "update") : false;
  const sp = (await searchParams) ?? {};
  const codeFilter = (sp.code ?? "").trim();
  const showCompleted = sp.status === "all";

  const pool = getPool();
  const likePattern = codeFilter ? `%${codeFilter}%` : null;

  const ordersRes = await pool
    .query<KioskWorkOrderDbRow>(
      `select wo.id::text,
              wo.order_no,
              pp.part_code,
              pp.part_name,
              wc.code as work_center_code,
              wc.name as work_center_name,
              wc.operation_type,
              wo.planned_qty::text,
              wo.good_qty::text,
              wo.scrap_qty::text,
              wo.planned_minutes::text,
              wo.actual_run_minutes::text,
              wo.downtime_minutes::text,
              wo.downtime_reason,
              wo.operator_note,
              wo.status,
              to_char(wo.due_date, 'YYYY-MM-DD') as due_date,
              wo.started_at::text,
              wo.completed_at::text,
              wo.last_kiosk_event_at::text
         from public.work_orders wo
         join public.work_centers wc on wc.id = wo.work_center_id
         left join public.production_parts pp on pp.id = wo.part_id
        where wo.status <> 'cancelled'
          and ($1::text is null
               or wo.order_no ilike $1
               or coalesce(pp.part_code, '') ilike $1
               or wc.code ilike $1)
          and ($2::boolean = true or wo.status in ('planned', 'in_progress'))
        order by
          case wo.status
            when 'in_progress' then 0
            when 'planned' then 1
            else 2
          end,
          wo.due_date asc nulls last,
          wo.created_at desc
        limit 30`,
      [likePattern, showCompleted || codeFilter.length > 0],
    )
    .catch(async (err: unknown) => {
      const pgCode = (err as { code?: string } | null)?.code;
      if (pgCode === "42703") {
        // Fallback when 0121 optional kiosk columns are not yet present
        return pool
          .query<KioskWorkOrderDbRow>(
            `select wo.id::text,
                    wo.order_no,
                    pp.part_code,
                    pp.part_name,
                    wc.code as work_center_code,
                    wc.name as work_center_name,
                    wc.operation_type,
                    wo.planned_qty::text,
                    wo.good_qty::text,
                    wo.scrap_qty::text,
                    wo.planned_minutes::text,
                    wo.actual_run_minutes::text,
                    wo.downtime_minutes::text,
                    wo.downtime_reason,
                    null::text as operator_note,
                    wo.status,
                    to_char(wo.due_date, 'YYYY-MM-DD') as due_date,
                    wo.started_at::text,
                    wo.completed_at::text,
                    null::text as last_kiosk_event_at
               from public.work_orders wo
               join public.work_centers wc on wc.id = wo.work_center_id
               left join public.production_parts pp on pp.id = wo.part_id
              where wo.status <> 'cancelled'
                and ($1::text is null
                     or wo.order_no ilike $1
                     or coalesce(pp.part_code, '') ilike $1
                     or wc.code ilike $1)
                and ($2::boolean = true or wo.status in ('planned', 'in_progress'))
              order by
                case wo.status
                  when 'in_progress' then 0
                  when 'planned' then 1
                  else 2
                end,
                wo.due_date asc nulls last,
                wo.created_at desc
              limit 30`,
            [likePattern, showCompleted || codeFilter.length > 0],
          )
          .catch((innerErr: unknown) => {
            if (isMissingSchemaError(innerErr)) return { rows: [] as KioskWorkOrderDbRow[], rowCount: 0 };
            throw innerErr;
          });
      }
      if (isMissingSchemaError(err)) return { rows: [] as KioskWorkOrderDbRow[], rowCount: 0 };
      throw err;
    });

  const orders = ordersRes.rows.map((r) => {
    const plannedQty = rate(r.planned_qty);
    const goodQty = rate(r.good_qty);
    const scrapQty = rate(r.scrap_qty);
    const plannedMinutes = rate(r.planned_minutes);
    const actualRunMinutes = rate(r.actual_run_minutes);
    const downtimeMinutes = rate(r.downtime_minutes);
    const completionPct =
      plannedQty > 0
        ? Number(decimal(goodQty).times(100).div(plannedQty).round(1).toFixed(1))
        : null;

    return {
      id: r.id,
      orderNo: r.order_no,
      partCode: r.part_code,
      partName: r.part_name,
      workCenterCode: r.work_center_code,
      workCenterName: r.work_center_name,
      operationType: r.operation_type as WorkCenterOperationType,
      plannedQty,
      goodQty,
      scrapQty,
      plannedMinutes,
      actualRunMinutes,
      downtimeMinutes,
      downtimeReason: r.downtime_reason,
      operatorNote: r.operator_note,
      status: r.status,
      dueDate: r.due_date,
      startedAt: r.started_at,
      completedAt: r.completed_at,
      lastKioskEventAt: r.last_kiosk_event_at,
      completionPct,
    };
  });

  const inProgressCount = orders.filter((o) => o.status === "in_progress").length;
  const plannedCount = orders.filter((o) => o.status === "planned").length;

  return (
    <div className="space-y-4">
      <PageHeader
        title="CNC Atölye Operatör Barkod / Karekod İstasyonu"
        subtitle="Eldiven uyumlu saha üretim terminali — yalnız iş emri, tezgâh, sağlam/fire adet ve duruş verilerini içerir (sıfır finansal veri)."
        meta={
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="blue" dot>
              {inProgressCount} Üretimde · {plannedCount} Sırada
            </Badge>
            <Link
              href={showCompleted ? "/production/kiosk" : "/production/kiosk?status=all"}
              className="button-ghost min-h-[40px] inline-flex items-center px-3 py-1.5 text-xs font-semibold"
            >
              {showCompleted ? "Yalnız Aktif İş Emirleri" : "Tamamlananları da Göster"}
            </Link>
          </div>
        }
      />

      {sp.error ? (
        <div
          role="alert"
          className="rounded-[var(--radius-md)] border px-4 py-3 text-sm font-medium"
          style={{
            borderColor: "color-mix(in srgb, var(--neg) 40%, var(--line))",
            background: "color-mix(in srgb, var(--neg) 10%, var(--surface-1))",
            color: "var(--neg)",
          }}
        >
          {sp.error}
        </div>
      ) : null}

      {sp.result ? (
        <div
          role="status"
          className="rounded-[var(--radius-md)] border px-4 py-3 text-sm font-medium"
          style={{
            borderColor: "color-mix(in srgb, var(--pos) 40%, var(--line))",
            background: "color-mix(in srgb, var(--pos) 10%, var(--surface-1))",
            color: "var(--pos)",
          }}
        >
          {sp.result}
        </div>
      ) : null}

      {/* Barkod / Karekod Okuyucu Girişi */}
      <Panel
        title="Barkod / Karekod Okuyucu Girişi"
        subtitle="USB veya Bluetooth el barkod okuyucu ile iş emri kodunu (WO-...) okuttuğunuzda Enter tuşu doğrudan ilgili istasyonu açar."
      >
        <form method="get" action="/production/kiosk" className="flex flex-wrap items-center gap-2.5">
          <input
            type="search"
            name="code"
            defaultValue={codeFilter}
            autoFocus
            aria-label="İş emri barkodunu okutun veya yazın"
            placeholder="İş emri barkodunu okutun veya yazın…"
            className="field-control min-h-[48px] min-w-[240px] flex-1 px-3.5 py-2.5 font-mono text-base"
          />
          <button
            type="submit"
            className="button-accent min-h-[48px] px-5 py-2.5 text-sm font-semibold"
          >
            İstasyonu Aç
          </button>
          {codeFilter ? (
            <Link
              href="/production/kiosk"
              className="button-ghost inline-flex min-h-[48px] items-center px-4 py-2.5 text-sm font-medium"
            >
              Filtreyi Temizle
            </Link>
          ) : null}
        </form>
      </Panel>

      {orders.length === 0 ? (
        <EmptyState>
          {codeFilter
            ? `"${codeFilter}" barkod veya parça koduyla eşleşen aktif iş emri bulunamadı.`
            : "Sırada bekleyen veya üretimde olan açık iş emri bulunmuyor."}
        </EmptyState>
      ) : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {orders.map((wo) => {
            const isClosed = wo.status === "completed" || wo.status === "cancelled";
            const opLabel = OPERATION_TYPE_LABEL[wo.operationType] ?? wo.operationType;

            return (
              <section
                key={wo.id}
                aria-label={`İş emri istasyonu ${wo.orderNo}`}
                className="folio-corner-mark flex flex-col justify-between rounded-[var(--radius-lg)] border border-line bg-surface-1 p-4 shadow-[var(--shadow-card)]"
              >
                {/* Üst Kimlik + QR + Radial Tamamlanma */}
                <div className="flex flex-wrap items-start justify-between gap-4 border-b border-line-faint pb-3.5">
                  <div className="flex items-start gap-3.5">
                    <FolioQrBadgeSvg
                      code={wo.orderNo}
                      caption={wo.partCode ?? wo.workCenterCode}
                      size={80}
                    />
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="tnum font-mono text-base font-bold text-tone-1">
                          {wo.orderNo}
                        </span>
                        <Badge tone={STATUS_TONE[wo.status]} dot>
                          {WORK_ORDER_STATUS_LABEL[wo.status] ?? wo.status}
                        </Badge>
                      </div>
                      <div className="text-sm font-semibold text-tone-1">
                        {wo.partCode ? `${wo.partCode} · ` : ""}
                        {wo.partName ?? "Standart Atölye Operasyonu"}
                      </div>
                      <div className="font-mono text-xs text-tone-2">
                        İstasyon: <strong>{wo.workCenterCode}</strong> — {wo.workCenterName} ({opLabel})
                      </div>
                      {wo.dueDate ? (
                        <div className="tnum font-mono text-xs text-tone-3">
                          Termin: {wo.dueDate}
                        </div>
                      ) : null}
                    </div>
                  </div>

                  <RadialMeterSvg
                    percent={wo.completionPct}
                    label="Adet İlerlemesi"
                    sublabel={`${wo.goodQty} / ${wo.plannedQty} sağlam`}
                    targetPercent={100}
                    size="sm"
                  />
                </div>

                {/* Saha Sayaç Kutuları */}
                <div className="my-3.5 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <div className="rounded-[var(--radius-md)] border border-line-faint bg-surface-0 px-3 py-2">
                    <div className="font-mono text-[10.5px] uppercase text-tone-3">Planlanan</div>
                    <div className="tnum mt-0.5 font-mono text-base font-bold text-tone-1">
                      {wo.plannedQty} ad
                    </div>
                  </div>
                  <div className="rounded-[var(--radius-md)] border border-line-faint bg-surface-0 px-3 py-2">
                    <div className="font-mono text-[10.5px] uppercase text-tone-3">Sağlam Üretim</div>
                    <div className="tnum mt-0.5 font-mono text-base font-bold text-pos">
                      {wo.goodQty} ad
                    </div>
                  </div>
                  <div className="rounded-[var(--radius-md)] border border-line-faint bg-surface-0 px-3 py-2">
                    <div className="font-mono text-[10.5px] uppercase text-tone-3">Fire (Scrap)</div>
                    <div
                      className={`tnum mt-0.5 font-mono text-base font-bold ${
                        wo.scrapQty > 0 ? "text-neg" : "text-tone-2"
                      }`}
                    >
                      {wo.scrapQty} ad
                    </div>
                  </div>
                  <div className="rounded-[var(--radius-md)] border border-line-faint bg-surface-0 px-3 py-2">
                    <div className="font-mono text-[10.5px] uppercase text-tone-3">Çalışma / Duruş</div>
                    <div className="tnum mt-0.5 font-mono text-sm font-semibold text-tone-1">
                      {wo.actualRunMinutes}dk /{" "}
                      <span className={wo.downtimeMinutes > 0 ? "text-warn" : "text-tone-3"}>
                        {wo.downtimeMinutes}dk
                      </span>
                    </div>
                  </div>
                </div>

                {/* Duruş Nedeni & Operatör Notu Özeti */}
                {wo.downtimeReason || wo.operatorNote || wo.lastKioskEventAt ? (
                  <div className="mb-3.5 space-y-1 rounded-[var(--radius-md)] border border-line-faint bg-surface-2 px-3 py-2 text-xs">
                    {wo.downtimeReason ? (
                      <div className="text-warn">
                        <strong>Son Duruş Nedeni:</strong> {wo.downtimeReason}
                      </div>
                    ) : null}
                    {wo.operatorNote ? (
                      <div className="text-tone-2">
                        <strong>Operatör Notu:</strong> {wo.operatorNote}
                      </div>
                    ) : null}
                    {wo.lastKioskEventAt ? (
                      <div className="tnum font-mono text-[11px] text-tone-3">
                        Son Kiosk Hareketi: {wo.lastKioskEventAt.slice(0, 16).replace("T", " ")}
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {/* Dokunmatik (44px+) Operatör Aksiyonları */}
                {!isClosed && canOperateKiosk ? (
                  <div className="space-y-3 border-t border-line-faint pt-3">
                    {/* Hızlı Başlat & Tamamla Satırı */}
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      {wo.status === "planned" ? (
                        <form action={kioskStartWorkOrderAction}>
                          <input type="hidden" name="workOrderId" value={wo.id} />
                          <input type="hidden" name="codeFilter" value={codeFilter} />
                          <SubmitButton
                            pendingLabel="Başlatılıyor…"
                            className="button-accent min-h-[48px] w-full px-4 py-2.5 text-sm font-semibold"
                          >
                            Tezgâhta Başlat
                          </SubmitButton>
                        </form>
                      ) : (
                        <div className="flex min-h-[48px] items-center justify-center rounded-[var(--radius-control)] border border-line bg-surface-2 px-3 text-xs font-semibold text-info">
                          Tezgâhta Aktif Üretimde
                        </div>
                      )}

                      <form action={kioskCompleteWorkOrderAction}>
                        <input type="hidden" name="workOrderId" value={wo.id} />
                        <input type="hidden" name="codeFilter" value={codeFilter} />
                        <SubmitButton
                          pendingLabel="Tamamlanıyor…"
                          className="button-ghost min-h-[48px] w-full px-4 py-2.5 text-sm font-semibold text-pos"
                        >
                          İş Emrini Tamamla
                        </SubmitButton>
                      </form>
                    </div>

                    {/* Sağlam Adet / Fire / Çalışma Dakikası Kaydı */}
                    <form
                      action={kioskRecordOutputAndScrapAction}
                      className="rounded-[var(--radius-md)] border border-line bg-surface-0 p-3"
                    >
                      <input type="hidden" name="workOrderId" value={wo.id} />
                      <input type="hidden" name="codeFilter" value={codeFilter} />
                      <div className="mb-2 font-mono text-[11px] font-semibold uppercase tracking-[0.05em] text-tone-2">
                        Üretim &amp; Fire Bildirimi (+Ekle)
                      </div>
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                        <label className="flex flex-col gap-1 text-xs font-medium text-tone-2">
                          <span>+Sağlam Adet</span>
                          <input
                            type="number"
                            name="addedGoodQty"
                            min="0"
                            step="1"
                            defaultValue="1"
                            className="field-control min-h-[44px] px-3 py-2 font-mono text-base"
                          />
                        </label>
                        <label className="flex flex-col gap-1 text-xs font-medium text-tone-2">
                          <span>+Fire Adet</span>
                          <input
                            type="number"
                            name="addedScrapQty"
                            min="0"
                            step="1"
                            defaultValue="0"
                            className="field-control min-h-[44px] px-3 py-2 font-mono text-base"
                          />
                        </label>
                        <label className="flex flex-col gap-1 text-xs font-medium text-tone-2">
                          <span>+Tezgâh Süresi (dk)</span>
                          <input
                            type="number"
                            name="addedRunMinutes"
                            min="0"
                            step="1"
                            defaultValue="15"
                            className="field-control min-h-[44px] px-3 py-2 font-mono text-base"
                          />
                        </label>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <input
                          type="text"
                          name="operatorNote"
                          maxLength={500}
                          placeholder="Operatör vardiya / ölçü notu (isteğe bağlı)"
                          className="field-control min-h-[44px] min-w-[180px] flex-1 px-3 py-2 text-base"
                        />
                        <SubmitButton
                          pendingLabel="Kaydediliyor…"
                          className="button-accent min-h-[44px] px-4 py-2 text-sm font-semibold"
                        >
                          Sağlam &amp; Fire Kaydet
                        </SubmitButton>
                      </div>
                    </form>

                    {/* Duruş Bildirimi Çekmecesi */}
                    <details className="rounded-[var(--radius-md)] border border-line bg-surface-0 p-3">
                      <summary className="flex min-h-[36px] cursor-pointer items-center justify-between font-mono text-xs font-semibold text-warn">
                        <span>+ Tezgâh Duruşu / Arıza Bildir</span>
                        <span className="text-[11px] text-tone-3">Dokunarak Aç</span>
                      </summary>
                      <form action={kioskReportDowntimeAction} className="mt-2.5 space-y-2">
                        <input type="hidden" name="workOrderId" value={wo.id} />
                        <input type="hidden" name="codeFilter" value={codeFilter} />
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                          <label className="flex flex-col gap-1 text-xs font-medium text-tone-2">
                            <span>Duruş Süresi (dk)</span>
                            <input
                              type="number"
                              name="addedDowntimeMinutes"
                              min="1"
                              max="1440"
                              step="1"
                              required
                              defaultValue="15"
                              className="field-control min-h-[44px] px-3 py-2 font-mono text-base"
                            />
                          </label>
                          <label className="flex flex-col gap-1 text-xs font-medium text-tone-2 sm:col-span-2">
                            <span>Duruş Nedeni</span>
                            <select
                              name="downtimeReason"
                              defaultValue={DOWNTIME_REASON_PRESETS[0]}
                              className="field-control min-h-[44px] px-3 py-2 text-base"
                            >
                              {DOWNTIME_REASON_PRESETS.map((reason) => (
                                <option key={reason} value={reason}>
                                  {reason}
                                </option>
                              ))}
                            </select>
                          </label>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <input
                            type="text"
                            name="operatorNote"
                            maxLength={500}
                            placeholder="Ek duruş detayı (isteğe bağlı)"
                            className="field-control min-h-[44px] min-w-[180px] flex-1 px-3 py-2 text-base"
                          />
                          <SubmitButton
                            pendingLabel="Duruş İşleniyor…"
                            className="button-ghost min-h-[44px] px-4 py-2 text-sm font-semibold text-warn"
                          >
                            Duruş Bildir
                          </SubmitButton>
                        </div>
                      </form>
                    </details>
                  </div>
                ) : null}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
