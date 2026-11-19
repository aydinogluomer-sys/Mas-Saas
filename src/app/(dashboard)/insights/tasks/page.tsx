import Link from "@/components/ui/app-link";
import { getRequestUser } from "@/lib/auth";
import { can } from "@/lib/authz/matrix";
import { requireRouteAccess } from "@/lib/authz/route-guard";
import { getPool } from "@/lib/db";
import {
  assignActionOwnerAction,
  autoCloseSettledActionsAction,
  createManualActionAction,
  setActionStatusAction,
} from "@/app/(dashboard)/data/quality/actions";
import {
  countSettledOpenActionItems,
  listAssignableUsers,
  loadTasksWithOwners,
} from "@/lib/action-items/engine";
import type { ActionStatus } from "@/lib/data-quality/rules";
import { Badge, type Tone } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { EmptyState, KpiCard, PageHeader } from "@/components/ui/shell";

export const dynamic = "force-dynamic";

type Status = ActionStatus;

const tones: Record<Status, Tone> = {
  open: "amber",
  in_progress: "blue",
  blocked: "red",
  done: "green",
  cancelled: "neutral",
};

const STATUS_TR: Record<Status, string> = {
  open: "açık",
  in_progress: "devam ediyor",
  blocked: "engellenmiş",
  done: "tamamlandı",
  cancelled: "iptal",
};

const SEVERITY_TR: Record<string, string> = {
  critical: "kritik",
  high: "yüksek",
  medium: "orta",
  low: "düşük",
};

const SOURCE_TR: Record<string, string> = {
  manual: "manuel",
  home_cockpit: "ana ekran",
  home_action: "ana ekran",
  ai_answer: "soru-cevap",
  ai_response: "soru-cevap",
  report: "rapor",
  review: "inceleme",
  mapping_review: "eşleştirme incelemesi",
  collection: "tahsilat",
};

export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<{
    status?: Status | "all";
    q?: string;
    owner?: string;
    autoClosed?: string;
  }>;
}) {
  const denied = await requireRouteAccess("/insights/tasks");
  if (denied) return denied;

  const user = await getRequestUser();
  const canUpdate = user ? can(user.role, "action_items", "update") : false;
  const canCreate = user ? can(user.role, "action_items", "insert") : false;

  const sp = await searchParams;
  const status: Status | "all" = sp.status ?? "open";
  const q = (sp.q ?? "").trim();
  const ownerFilter = (sp.owner ?? "").trim();
  const autoClosedParam = sp.autoClosed !== undefined ? Number(sp.autoClosed) : null;

  const pool = getPool();
  const [tasks, users, settledReadyCount] = await Promise.all([
    loadTasksWithOwners(pool, { status, q, ownerUserId: ownerFilter }),
    listAssignableUsers(pool),
    countSettledOpenActionItems(pool),
  ]);

  const criticalOpenCount = tasks.filter(
    (t) => (t.severity === "critical" || t.severity === "high") && t.status !== "done" && t.status !== "cancelled",
  ).length;
  const assignedCount = tasks.filter((t) => Boolean(t.owner_user_id || t.owner_display)).length;

  const currentQuery = (nextStatus: Status | "all") => {
    const params = new URLSearchParams();
    params.set("status", nextStatus);
    if (q) params.set("q", q);
    if (ownerFilter) params.set("owner", ownerFilter);
    return `/insights/tasks?${params.toString()}`;
  };
  const backHref = currentQuery(status);

  const tabs: [Status | "all", string][] = [
    ["open", "Açık"],
    ["in_progress", "Devam eden"],
    ["blocked", "Engellenmiş"],
    ["done", "Tamamlanan"],
    ["cancelled", "İptal"],
    ["all", "Tümü"],
  ];

  return (
    <>
      <PageHeader
        title="Görevler & Ekip Aksiyonları"
        subtitle="AI, rapor, tahsilat eskalasyonu ve veri incelemelerinden üretilen kullanıcı bazlı (owner_user_id) görev panosu"
        actions={
          canUpdate ? (
            <form action={autoCloseSettledActionsAction}>
              <input type="hidden" name="backTo" value={backHref} />
              <button className="button-ghost px-3 py-2 text-xs">
                Ödenen Kayıt Görevlerini Otomatik Kapat
                {settledReadyCount > 0 ? ` (${settledReadyCount})` : ""}
              </button>
            </form>
          ) : undefined
        }
      />

      {autoClosedParam !== null && !Number.isNaN(autoClosedParam) ? (
        <div
          className="mb-3 rounded-lg border px-4 py-3 text-sm"
          style={{
            borderColor: "var(--pos)",
            background: "var(--surface-1)",
            color: "var(--text-1)",
          }}
        >
          Tahsilat/ödeme mutabakatı tamamlanan <b>{autoClosedParam}</b> görev otomatik olarak <b>tamamlandı</b> durumuna alındı ve denetim izine yazıldı.
        </div>
      ) : null}

      {settledReadyCount > 0 && canUpdate ? (
        <div
          className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border px-4 py-3 text-sm"
          style={{
            borderColor: "var(--warn)",
            background: "var(--surface-2)",
            color: "var(--text-1)",
          }}
        >
          <span>
            Bağlı faturası, çeki veya ödeme satırı kapanmış <b>{settledReadyCount}</b> açık görev tespit edildi (
            <code>auto_close_on_settlement = true</code>).
          </span>
          <form action={autoCloseSettledActionsAction}>
            <input type="hidden" name="backTo" value={backHref} />
            <button className="button-accent px-3 py-1.5 text-xs">
              Şimdi Otomatik Kapat ({settledReadyCount})
            </button>
          </form>
        </div>
      ) : null}

      <div className="mb-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard label="Listelenen Görev" value={String(tasks.length)} hint={`Filtre: ${status === "all" ? "Tümü" : STATUS_TR[status]}`} />
        <KpiCard label="Kritik / Yüksek Öncelik" value={String(criticalOpenCount)} hint="Açık & takip bekleyen" />
        <KpiCard label="Sorumlusu Atanmış" value={String(assignedCount)} hint={`${users.length} ekip kullanıcısı`} />
        <KpiCard label="Otomatik Kapanmaya Hazır" value={String(settledReadyCount)} hint="Bağlı finansal kaydı kapanan" />
      </div>

      <Panel title="Filtreler & Ekip Sorumlusu">
        <form className="flex flex-wrap items-center gap-2">
          <input name="q" defaultValue={q} placeholder="Başlık, not veya sorumlu ara..." className="field-control min-w-56 p-2" />
          <select name="owner" defaultValue={ownerFilter} className="field-control p-2">
            <option value="">Tüm Sorumlular</option>
            <option value="unassigned">Atanmamış Görevler</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.label}
              </option>
            ))}
          </select>
          <input type="hidden" name="status" value={status} />
          <button className="button-accent px-3 py-2">Filtrele</button>
          {(q || ownerFilter) && (
            <Link href={`/insights/tasks?status=${status}`} className="button-ghost px-3 py-2 text-xs">
              Sıfırla
            </Link>
          )}
        </form>
        <div className="mt-2 flex flex-wrap gap-2">
          {tabs.map(([v, l]) => (
            <Link
              key={v}
              href={currentQuery(v)}
              className={status === v ? "button-accent px-2.5 py-1 text-xs" : "button-ghost px-2.5 py-1 text-xs"}
            >
              {l}
            </Link>
          ))}
        </div>
      </Panel>

      <div className="mt-3 grid gap-3 lg:grid-cols-[1fr_340px]">
        <Panel title={`${tasks.length} görev`}>
          {tasks.length === 0 ? (
            <EmptyState
              title="Seçili filtrede görev bulunamadı"
              description="Yeni manuel görev ekleyebilir veya Raporlar / Soru-Cevap / Veri Kalitesi ekranlarından aksiyon üretebilirsiniz."
            />
          ) : (
            tasks.map((a) => (
              <div key={a.id} className="border-b border-line-faint py-3 last:border-b-0">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge tone={tones[a.status]}>{STATUS_TR[a.status] ?? a.status}</Badge>
                      <Badge tone={a.severity === "critical" || a.severity === "high" ? "red" : "neutral"}>
                        {SEVERITY_TR[a.severity] ?? a.severity}
                      </Badge>
                      <span className="text-xs text-tone-3">{SOURCE_TR[a.source_type] ?? a.source_type}</span>
                      {a.auto_close_on_settlement && a.related_entity_table ? (
                        <Badge tone="blue">Tahsilatta Otomatik Kapanır</Badge>
                      ) : null}
                    </div>
                    <b className="mt-1 block text-sm">{a.title}</b>
                    <p className="mt-0.5 text-xs text-tone-3">
                      Sorumlu: <b>{a.owner_display ?? "Atanmamış"}</b> · Vade: {a.due_date ?? "tarih yok"} · Oluşturma: {a.created_at}
                      {a.related_entity_table ? ` · Bağlı kayıt: ${a.related_entity_table}` : ""}
                    </p>
                    {a.note && <p className="mt-1.5 whitespace-pre-line text-sm text-tone-2">{a.note}</p>}
                  </div>
                  {a.source_href && (
                    <Link className="text-sm text-info" href={a.source_href}>
                      Kaynağa git →
                    </Link>
                  )}
                </div>

                {!(["done", "cancelled"] as string[]).includes(a.status) && canUpdate && (
                  <div className="mt-2.5 flex flex-wrap items-center gap-2">
                    <form action={assignActionOwnerAction} className="flex items-center gap-1">
                      <input type="hidden" name="actionId" value={a.id} />
                      <input type="hidden" name="backTo" value={backHref} />
                      <select
                        name="ownerUserId"
                        defaultValue={a.owner_user_id ?? ""}
                        className="field-control px-2 py-1 text-xs"
                        aria-label="Sorumlu ata"
                      >
                        <option value="">— Sorumlu Seç —</option>
                        {users.map((u) => (
                          <option key={u.id} value={u.id}>
                            {u.label}
                          </option>
                        ))}
                      </select>
                      <button className="button-ghost px-2 py-1 text-xs">Ata</button>
                    </form>

                    {(["in_progress", "blocked", "cancelled"] as Status[]).map((s) => (
                      <form key={s} action={setActionStatusAction}>
                        <input type="hidden" name="id" value={a.id} />
                        <input type="hidden" name="status" value={s} />
                        <input type="hidden" name="backTo" value={backHref} />
                        <button className="button-ghost px-2 py-1 text-xs">
                          {s === "in_progress" ? "Başlat" : s === "blocked" ? "Engelle" : "İptal"}
                        </button>
                      </form>
                    ))}
                    <form action={setActionStatusAction} className="flex gap-1">
                      <input type="hidden" name="id" value={a.id} />
                      <input type="hidden" name="status" value="done" />
                      <input type="hidden" name="backTo" value={backHref} />
                      <input
                        name="completionNote"
                        required
                        placeholder="Kapanış notu"
                        className="field-control w-40 px-2 py-1 text-xs"
                      />
                      <button className="button-accent px-2.5 py-1 text-xs">Tamamla</button>
                    </form>
                  </div>
                )}
              </div>
            ))
          )}
        </Panel>

        <Panel title="Manuel görev oluştur">
          {canCreate ? (
            <form action={createManualActionAction} className="space-y-2.5">
              <input type="hidden" name="backTo" value={backHref} />
              <div>
                <label className="mb-1 block text-xs text-tone-3">Görev Başlığı *</label>
                <input name="title" required placeholder="Örn. 30+ gün gecikmiş fatura mutabakatı" className="field-control w-full p-2 text-sm" />
              </div>
              <div>
                <label className="mb-1 block text-xs text-tone-3">Öncelik</label>
                <select name="severity" defaultValue="medium" className="field-control w-full p-2 text-sm">
                  <option value="critical">Kritik</option>
                  <option value="high">Yüksek</option>
                  <option value="medium">Orta</option>
                  <option value="low">Düşük</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs text-tone-3">Ekip Sorumlusu (Kullanıcı Hesabı)</label>
                <select name="ownerUserId" defaultValue={user?.id ?? ""} className="field-control w-full p-2 text-sm">
                  <option value="">— Kullanıcı Seçilmedi —</option>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs text-tone-3">Alternatif Sorumlu Etiketi (Opsiyonel)</label>
                <input name="owner" placeholder="Dış danışman / departman adı" className="field-control w-full p-2 text-sm" />
              </div>
              <div>
                <label className="mb-1 block text-xs text-tone-3">Hedef Vade Tarihi</label>
                <input name="dueDate" type="date" className="field-control w-full p-2 text-sm" />
              </div>
              <label className="flex items-center gap-2 text-xs text-tone-2">
                <input type="checkbox" name="autoCloseOnSettlement" defaultChecked />
                Bağlı finansal kayıt ödendiğinde otomatik kapat
              </label>
              <div>
                <label className="mb-1 block text-xs text-tone-3">Açıklama / Not</label>
                <textarea name="note" rows={3} placeholder="Görev detayı veya mutabakat referansı" className="field-control w-full p-2 text-sm" />
              </div>
              <button className="button-accent w-full px-3 py-2 text-sm">Görevi Oluştur</button>
            </form>
          ) : (
            <p className="text-sm text-tone-3">Manuel görev oluşturmak için operatör veya yönetici yetkisi gereklidir.</p>
          )}
        </Panel>
      </div>
    </>
  );
}
