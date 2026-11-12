import { getPool } from "@/lib/db";
import { createConfiguredDispatcher } from "@/lib/jobs/dispatcher";
import { listJobs, loadQueueHealth } from "@/lib/jobs/queue";
import { JOB_TYPES, queueVerdict, type JobStatus } from "@/lib/jobs/rules";
import { getSlowThreshold, slowQueryReport } from "@/lib/perf/slow-query";
import {
  cancelJobAction,
  enqueueAndDispatchJobAction,
  processNextQueuedJobAction,
  reapStaleJobsAction,
  replayJobAction,
  sweepQueueAction,
} from "./actions";
import { Badge, type Tone } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { EmptyState, KeyStat, PageHeader, TableShell } from "@/components/ui/shell";
import { requireRouteAccess } from "@/lib/authz/route-guard";

export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<JobStatus, string> = {
  queued: "kuyrukta", running: "çalışıyor", succeeded: "tamamlandı",
  failed: "başarısız", dead_letter: "ölü mektup", cancelled: "iptal",
};
const STATUS_TONE: Record<JobStatus, Tone> = {
  queued: "blue", running: "amber", succeeded: "green",
  failed: "amber", dead_letter: "red", cancelled: "neutral",
};
const TYPE_LABEL: Record<string, string> = {
  excel_import: "Excel içe aktarma",
  bank_statement_import: "Banka ekstresi",
  report_generation: "Rapor üretimi",
  large_export: "Büyük dışa aktarma",
  read_model_refresh: "Read-model tazeleme",
  fx_rate_sync: "TCMB günlük kur senkronizasyonu",
  accounting_sync: "Muhasebe / ERP senkronizasyonu",
  bank_api_sync: "Banka API senkronizasyonu",
  einvoice_sync: "e-Fatura / GİB senkronizasyonu",
};

export default async function JobsPage() {
  const denied = await requireRouteAccess("/system/jobs");
  if (denied) return denied;
  const pool = getPool();
  const [jobs, health] = await Promise.all([listJobs(pool, 100), loadQueueHealth(pool)]);
  const slow = slowQueryReport(15);

  const deadLetters = jobs.filter((j) => j.status === "dead_letter");
  const queued = jobs.filter((j) => j.status === "queued");
  const running = jobs.filter((j) => j.status === "running");
  const oldestQueued = queued.length
    ? Math.max(...queued.map((j) => (Date.now() - Date.parse(j.createdAt)) / 1000))
    : null;
  const verdict = queueVerdict(oldestQueued, deadLetters.length);
  const inspectorDispatcher = createConfiguredDispatcher();

  return (
    <>
      <PageHeader
        title="Arka Plan İşleri"
        subtitle="İçe aktarma, rapor ve dışa aktarma kuyruğu — yeniden deneme, ölü mektup ve ilerleme"
        meta={<Badge tone={verdict.tone === "neg" ? "red" : verdict.tone === "warn" ? "amber" : "green"} dot>
          {verdict.label}
        </Badge>}
        action={
          <div className="flex flex-wrap gap-2">
            <form action={processNextQueuedJobAction}>
              <button className="button-accent px-3 py-2 font-mono text-xs uppercase tracking-wider">
                Sıradaki işi çalıştır
              </button>
            </form>
            <form action={reapStaleJobsAction}>
              <input type="hidden" name="olderThanMinutes" value="30" />
              <button className="button-ghost px-3 py-2 font-mono text-xs uppercase tracking-wider">
                Asılı İşleri Kurtar
              </button>
            </form>
            <form action={sweepQueueAction}>
              <button className="button-ghost px-3 py-2 font-mono text-xs uppercase tracking-wider">
                Kuyruğu süpür
              </button>
            </form>
          </div>
        }
      />

      <Panel
        title="MERKEZİ İŞ DAĞITICISI (DISPATCHER) & KAYITLI İŞÇİLER"
        subtitle="FOR UPDATE SKIP LOCKED ile atomik iş sahiplenme ve idempotent görev çalıştırıcıları"
      >
        <div className="mb-3 flex flex-wrap gap-1.5">
          {JOB_TYPES.map((jt) => {
            const registered = inspectorDispatcher.hasHandler(jt);
            return (
              <Badge key={jt} tone={registered ? "green" : "neutral"} dot>
                {TYPE_LABEL[jt] ?? jt}: {registered ? "aktif handler" : "harici işçi"}
              </Badge>
            );
          })}
        </div>
        <div className="flex flex-wrap gap-2 border-t border-line-faint pt-2.5">
          <form action={enqueueAndDispatchJobAction}>
            <input type="hidden" name="jobType" value="read_model_refresh" />
            <input type="hidden" name="task" value="overview.refresh" />
            <button type="submit" className="button-ghost px-2.5 py-1 text-xs">
              + Ana Ekran & Süreklilik Tazele
            </button>
          </form>
          <form action={enqueueAndDispatchJobAction}>
            <input type="hidden" name="jobType" value="read_model_refresh" />
            <input type="hidden" name="task" value="controls.evaluate" />
            <button type="submit" className="button-ghost px-2.5 py-1 text-xs">
              + İç Kontrol Denetimi Çalıştır
            </button>
          </form>
          <form action={enqueueAndDispatchJobAction}>
            <input type="hidden" name="jobType" value="report_generation" />
            <input type="hidden" name="task" value="report.generate" />
            <button type="submit" className="button-ghost px-2.5 py-1 text-xs">
              + Günlük CFO Özeti Üret
            </button>
          </form>
          <form action={enqueueAndDispatchJobAction}>
            <input type="hidden" name="jobType" value="fx_rate_sync" />
            <input type="hidden" name="task" value="fx.tcmb_daily" />
            <button type="submit" className="button-ghost px-2.5 py-1 text-xs">
              + TCMB Günlük Kur Çek
            </button>
          </form>
          <form action={enqueueAndDispatchJobAction}>
            <input type="hidden" name="jobType" value="large_export" />
            <input type="hidden" name="task" value="export.large" />
            <input type="hidden" name="dataset" value="open_invoices" />
            <input type="hidden" name="format" value="csv" />
            <button type="submit" className="button-ghost px-2.5 py-1 text-xs">
              + Büyük Dışa Aktarma Üret
            </button>
          </form>
        </div>
      </Panel>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <KeyStat label="Kuyrukta" value={String(queued.length)} tone={queued.length > 0 ? "info" : "neutral"} sub="Sırasını bekliyor" />
        <KeyStat label="Çalışıyor" value={String(running.length)} tone={running.length > 0 ? "warn" : "neutral"} sub="Bir işçi devraldı" />
        <KeyStat label="Ölü mektup" value={String(deadLetters.length)} tone={deadLetters.length > 0 ? "neg" : "pos"} sub="Elle inceleme gerekir" />
        <KeyStat
          label="En eski bekleyen"
          value={oldestQueued == null ? "—" : `${Math.round(oldestQueued / 60)} dk`}
          tone={oldestQueued != null && oldestQueued > 3600 ? "neg" : "neutral"}
          sub={oldestQueued == null ? "bekleyen iş yok" : "kuyruk gecikmesi"}
        />
      </div>

      {deadLetters.length > 0 && (
        <Panel title="ÖLÜ MEKTUP KUYRUĞU">
          <p className="mb-2 font-mono text-[10px] text-tone-4">
            Bu işler deneme haklarını tüketti veya kalıcı olarak reddedildi. Tekrar oynatmadan önce
            sebebin düzeltilmiş olması gerekir — tekrar oynatma denemeleri sıfırlar ve kim yaptıysa
            denetim kaydına yazılır.
          </p>
          <TableShell>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left font-mono text-[10px] uppercase text-tone-4">
                  <th className="py-1">Tür</th><th>Sebep</th><th className="text-right">Deneme</th><th />
                </tr>
              </thead>
              <tbody>
                {deadLetters.map((j) => (
                  <tr key={j.id} className="border-t border-line-faint">
                    <td className="py-1">{TYPE_LABEL[j.jobType] ?? j.jobType}</td>
                    <td className="max-w-[28rem] truncate text-tone-2">{j.deadLetterReason ?? j.lastError ?? "—"}</td>
                    <td className="text-right font-mono">{j.attempts}/{j.maxAttempts}</td>
                    <td className="text-right">
                      <form action={replayJobAction}>
                        <input type="hidden" name="jobId" value={j.id} />
                        <button className="border border-line-strong px-2 py-1 font-mono text-[10px] uppercase">
                          tekrar oynat
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        </Panel>
      )}

      <Panel title="KUYRUK" right={<span className="font-mono text-[10px] uppercase text-tone-4">{jobs.length} kayıt</span>}>
        {jobs.length === 0 ? (
          <EmptyState>Kuyrukta iş yok.</EmptyState>
        ) : (
          <TableShell>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left font-mono text-[10px] uppercase text-tone-4">
                  <th className="py-1">Tür</th><th>Durum</th><th>İlerleme</th>
                  <th className="text-right">Deneme</th><th>Son hata</th><th className="text-right">İşlem</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => (
                  <tr key={j.id} className="border-t border-line-faint">
                    <td className="py-1">{TYPE_LABEL[j.jobType] ?? j.jobType}</td>
                    <td><Badge tone={STATUS_TONE[j.status]}>{STATUS_LABEL[j.status]}</Badge></td>
                    <td className="font-mono text-tone-2">
                      {j.progressPercent == null
                        ? <span title="toplam henüz bilinmiyor">— {j.progressDone > 0 ? `(${j.progressDone})` : ""}</span>
                        : `%${j.progressPercent} (${j.progressDone}/${j.progressTotal})`}
                    </td>
                    <td className="text-right font-mono">{j.attempts}/{j.maxAttempts}</td>
                    <td className="max-w-[20rem] truncate text-tone-3">{j.lastError ?? "—"}</td>
                    <td className="text-right">
                      {j.status === "queued" ? (
                        <form action={cancelJobAction} className="inline">
                          <input type="hidden" name="jobId" value={j.id} />
                          <button
                            type="submit"
                            className="button-ghost px-2 py-0.5 font-mono text-[10px] uppercase"
                          >
                            İptal Et
                          </button>
                        </form>
                      ) : (
                        <span className="font-mono text-[10px] text-tone-4">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        )}
      </Panel>

      <Panel title="KUYRUK SAĞLIĞI (TÜR × DURUM)">
        {health.length === 0 ? <EmptyState>Ölçülecek iş yok.</EmptyState> : (
          <TableShell>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left font-mono text-[10px] uppercase text-tone-4">
                  <th className="py-1">Tür</th><th>Durum</th><th className="text-right">Adet</th>
                  <th className="text-right">Ort. süre</th><th className="text-right">En çok deneme</th>
                </tr>
              </thead>
              <tbody>
                {health.map((h) => (
                  <tr key={`${h.jobType}-${h.status}`} className="border-t border-line-faint">
                    <td className="py-1">{TYPE_LABEL[h.jobType] ?? h.jobType}</td>
                    <td>{STATUS_LABEL[h.status] ?? h.status}</td>
                    <td className="text-right font-mono">{h.jobCount}</td>
                    <td className="text-right font-mono text-tone-2">
                      {h.avgSeconds == null ? "—" : `${h.avgSeconds.toFixed(1)} sn`}
                    </td>
                    <td className="text-right font-mono text-tone-3">{h.maxAttemptsUsed ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        )}
      </Panel>

      <Panel
        title="YAVAŞ SORGULAR"
        right={<span className="font-mono text-[10px] uppercase text-tone-4">eşik {getSlowThreshold()} ms</span>}
      >
        <p className="mb-2 font-mono text-[10px] text-tone-4">
          Bu ölçüm bu sunucu sürecinin belleğinde tutulur; yeniden başlatınca sıfırlanır ve
          veritabanına yazılmaz. Yalnızca sorgunun ŞEKLİ saklanır — parametre değerleri
          (tutarlar, karşı taraf adları) hiçbir zaman kaydedilmez. Toplam süreye göre sıralıdır:
          500 kez çalışan 40 ms&apos;lik bir sorgu, tek seferlik 900 ms&apos;lik bir sorgudan daha
          pahalıdır.
        </p>
        {slow.rows.length === 0 ? (
          <EmptyState>Eşiği aşan sorgu kaydedilmedi.</EmptyState>
        ) : (
          <TableShell>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left font-mono text-[10px] uppercase text-tone-4">
                  <th className="py-1">Sorgu şekli</th><th className="text-right">Adet</th>
                  <th className="text-right">Toplam</th><th className="text-right">En kötü</th>
                </tr>
              </thead>
              <tbody>
                {slow.rows.map((r) => (
                  <tr key={r.fingerprint} className="border-t border-line-faint">
                    <td className="max-w-[36rem] truncate py-1 font-mono text-[11px]">{r.fingerprint}</td>
                    <td className="text-right font-mono">{r.count}</td>
                    <td className="text-right font-mono">{r.totalMs.toFixed(0)} ms</td>
                    <td className="text-right font-mono text-tone-2">{r.maxMs.toFixed(0)} ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        )}
        {slow.dropped > 0 && (
          <p className="mt-2 font-mono text-[10px] text-tone-4">
            {slow.dropped} sorgu şekli tampon dolduğu için atlandı (üst sınır 200).
          </p>
        )}
      </Panel>
    </>
  );
}
