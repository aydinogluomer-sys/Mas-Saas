"use client";
// PHASE 4 — Standart Import V2 kullanıcı akışı (plan §4.1):
//   1 şablon indir → 2 dosya seç → 3-5 ÖNİZLE (şema+parse+dryRun) → 6 sorunlar → 7 ONAYLA
//   → 8 tek transaction → 9 sonuç + provenance
//
// Aynı <input type="file"> iki eylemde de kullanılır; onay isteği önizlemenin sha256'sını gizli
// alanla taşır. Kullanıcı önizlemeden sonra başka bir dosya seçerse sunucu SHA_MISMATCH ile
// durur — istemci tarafı "değişti mi" tahmini yapılmaz, sunucu ölçer.
import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { confirmV2Action, previewV2Action, type V2FlowState } from "@/app/(dashboard)/data/imports/v2/actions";
import type { PreviewReport } from "@/lib/importers/v2/service";
import { Badge, type Tone } from "@/components/ui/badge";

const IDLE: V2FlowState = { phase: "idle" };

function Submit({ label, pending: pendingLabel, className }: { label: string; pending: string; className: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={`${className} px-4 py-2.5 text-xs font-medium tracking-wide disabled:opacity-50 transition-all`}>
      {pending ? (
        <span className="inline-flex items-center gap-2">
          <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          {pendingLabel}
        </span>
      ) : label}
    </button>
  );
}

function Counter({ k, v, tone }: { k: string; v: number; tone?: Tone }) {
  const toneBg =
    tone === "amber"
      ? "bg-amber-500/10 border-amber-500/25 text-amber-300"
      : tone === "red"
        ? "bg-rose-500/10 border-rose-500/25 text-rose-300"
        : tone === "green"
          ? "bg-emerald-500/10 border-emerald-500/25 text-emerald-300"
          : "bg-surface-2/70 border-line text-tone-1";

  return (
    <div className={`rounded-xl border p-3 transition-all ${toneBg}`}>
      <div className="font-sans text-[11px] font-medium text-tone-3 uppercase tracking-wider">{k}</div>
      <div className="mt-1 flex items-baseline justify-between gap-2">
        <span className="font-sans text-xl font-bold tracking-tight tabular-nums">{v.toLocaleString("tr-TR")}</span>
        {tone && v > 0 ? <Badge tone={tone}>dikkat</Badge> : null}
      </div>
    </div>
  );
}

function IssueList({ title, rows, hint }: { title: string; rows: Array<{ sheet: string; row: number | null; column: string | null; message: string }>; hint: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface-2/40 p-3.5 transition-all">
      <div className="mb-2 flex items-center justify-between">
        <div className="font-sans text-xs font-semibold text-tone-2">{title}</div>
        <Badge tone={rows.length > 0 ? "amber" : "green"}>{rows.length}</Badge>
      </div>
      {rows.length === 0 ? (
        <p className="font-sans text-xs text-tone-3">Sorun tespit edilmedi</p>
      ) : (
        <>
          <p className="mb-2 font-sans text-xs text-tone-3">{hint}</p>
          <ul className="max-h-40 space-y-1.5 overflow-auto text-xs">
            {rows.slice(0, 50).map((r, i) => (
              <li key={i} className="rounded-lg bg-surface-1/60 px-2.5 py-1.5 font-mono text-[11px] text-tone-2 border border-line-faint">
                <span className="text-sky-400 font-semibold">{r.sheet}{r.row != null ? `:${r.row}` : ""}{r.column ? ` · ${r.column}` : ""}</span>{" — "}{r.message}
              </li>
            ))}
            {rows.length > 50 ? <li className="font-sans text-xs text-tone-3">… ve {rows.length - 50} satır daha</li> : null}
          </ul>
        </>
      )}
    </div>
  );
}

function Preview({ report }: { report: PreviewReport }) {
  const c = report.counters;
  const nothingToWrite = c.create + c.update + c.undetermined === 0;
  return (
    <div className="space-y-4">
      {/* File & Schema Metadata Badge Bar */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl bg-surface-2/60 border border-line px-3.5 py-2.5 text-xs text-tone-2">
        <span className="inline-flex items-center gap-1.5 font-medium text-tone-1">
          <svg className="h-4 w-4 text-emerald-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
          </svg>
          {report.filename}
        </span>
        <span className="text-tone-3">·</span>
        <span>{(report.bytes / 1024).toFixed(0)} KB</span>
        <span className="text-tone-3">·</span>
        <span>Şema <strong className="text-tone-1">{report.schema.name} v{report.schema.version}</strong></span>
        <span className="text-tone-3">·</span>
        <span title="Önizlenen dosyanın SHA256'sı; onayda yeniden hesaplanır ve eşleşmesi zorunludur." className="font-mono text-[11px] text-tone-3">
          SHA256: {report.sha256.slice(0, 16)}…
        </span>
      </div>

      {/* Plan §4.2 Sayaçları */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Counter k="Yaratılacak" v={c.create} tone={c.create > 0 ? "green" : undefined} />
        <Counter k="Güncellenecek" v={c.update} tone={c.update > 0 ? "green" : undefined} />
        <Counter k="İnceleme" v={c.review} tone="amber" />
        <Counter k="Reddedilecek" v={c.reject} tone="red" />
        <Counter k="Belirlenemedi" v={c.undetermined} tone={c.undetermined > 0 ? "amber" : undefined} />
      </div>

      <p className="font-sans text-xs text-tone-3">
        Belirlenemedi = Kayıt kodu olmayan satırlar; yeni mi güncelleme mi olduğu veritabanına yazılırken doğrulanır.
        {c.blockedByParent > 0 ? ` · ${c.blockedByParent} satır üst kaydı bu dosyada kabul edilmediği için yazılmayacak.` : ""}
        {c.stagedOnly > 0 ? ` · ${c.stagedOnly} satır (${report.stagedOnlyFamilies.join(", ")}) kaynak katmanında korunur.` : ""}
        {` · Açılacak inceleme kaydı: ${c.reviewsToOpen}.`}
      </p>

      <div className="grid gap-3 lg:grid-cols-2">
        <div className="rounded-xl border border-line bg-surface-2/40 p-3.5 transition-all">
          <div className="mb-2 flex items-center justify-between">
            <div className="font-sans text-xs font-semibold text-tone-2">Desteklenmeyen Alanlar</div>
            <Badge tone={report.lists.unsupportedFields.length + report.lists.unknownSheets.length > 0 ? "amber" : "green"}>
              {report.lists.unsupportedFields.length + report.lists.unknownSheets.length}
            </Badge>
          </div>
          {report.lists.unsupportedFields.length === 0 && report.lists.unknownSheets.length === 0 ? (
            <p className="font-sans text-xs text-tone-3">Tüm kolon ve sayfalar sözleşmeyle uyumlu</p>
          ) : (
            <ul className="space-y-1 font-mono text-[11px] text-tone-2">
              {report.lists.unsupportedFields.map((u, i) => <li key={`h${i}`}>{u.sheet} · başlık «{u.header}» — sözleşmede yok; ham veride korunur</li>)}
              {report.lists.unknownSheets.map((s, i) => <li key={`s${i}`}>sayfa «{s}» — sözleşmede yok; içe aktarılmaz</li>)}
            </ul>
          )}
        </div>
        <IssueList title="TRY-Dışı Finans Kayıtları" rows={report.lists.nonTryFinance}
          hint="Çek/kredi toplamları TRY bazında hesaplanır. Dövizli kayıtlar kaynakta korunur, finans KPI'larına girmez." />
        <IssueList title="Mükerrer Şüphelileri" rows={report.lists.duplicateSuspects}
          hint="Benzer kayıtlar otomatik birleştirilmez veya silinmez; inceleme kuyruğuna aktarılır." />
        <IssueList title="Eksik Zorunlu Alanlar" rows={report.lists.missingRequired}
          hint="Zorunlu alanı boş olan satırlar aktarılmaz; doğrulama için inceleme kaydı açılır." />
      </div>

      {report.lists.forbiddenSheets.length > 0 ? (
        <div role="alert" data-testid="v2-forbidden-sheets" className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3.5">
          <div className="font-sans text-xs font-semibold text-amber-400">Yetki Dışı Sayfalar — Onay Reddedilecek</div>
          <ul className="mt-1.5 space-y-1 font-mono text-[11px] text-amber-200/90">
            {report.lists.forbiddenSheets.map((f) => (
              <li key={f.sheet}>{f.sheet} → {f.table} · {f.readyRows} hazır satır · Gereken rol: {f.allowedRoles.join(" / ")}</li>
            ))}
          </ul>
          <p className="mt-2 font-sans text-xs text-tone-2">Bu sayfaları boşaltıp yeniden yükleyin ya da dosyayı yetkili bir kullanıcıya iletin.</p>
        </div>
      ) : null}

      <details className="rounded-xl border border-line bg-surface-2/20 p-3 text-xs">
        <summary className="cursor-pointer font-sans text-xs font-medium text-tone-2 hover:text-tone-1">
          Sayfa Detayları ({report.sheets.length} sayfa)
        </summary>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-line text-left font-sans text-[11px] font-semibold text-tone-3">
                <th className="py-1.5 pr-2">Sayfa</th>
                <th className="py-1.5 pr-2 text-right">Okunan</th>
                <th className="py-1.5 pr-2 text-right">Hazır</th>
                <th className="py-1.5 pr-2 text-right">İnceleme</th>
                <th className="py-1.5 pr-2 text-right">Red</th>
                <th className="py-1.5 pr-2 text-right">Üst-Engelli</th>
                <th className="py-1.5">Eksik Kolon</th>
              </tr>
            </thead>
            <tbody>
              {report.sheets.map((s) => (
                <tr key={s.sheet} className="border-b border-line-faint hover:bg-surface-3/30 transition-colors">
                  <td className="py-1.5 pr-2 font-mono font-medium text-tone-1">{s.sheet}</td>
                  <td className="py-1.5 pr-2 text-right tabular-nums text-tone-2">{s.rowsRead}</td>
                  <td className="py-1.5 pr-2 text-right tabular-nums font-medium text-emerald-400">{s.ready}</td>
                  <td className="py-1.5 pr-2 text-right tabular-nums text-amber-400">{s.needsReview}</td>
                  <td className="py-1.5 pr-2 text-right tabular-nums text-rose-400">{s.rejected}</td>
                  <td className="py-1.5 pr-2 text-right tabular-nums text-tone-3">{s.blockedByParent}</td>
                  <td className="py-1.5 font-mono text-[11px] text-tone-3">{s.missingColumns.join(", ") || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      {nothingToWrite ? (
        <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 font-sans text-xs text-amber-300">
          Bu dosyada ana tablolara yazılacak hazır satır bulunamadı. Onaylarsanız yalnız hazırlık katmanı ve inceleme kayıtları oluşur.
        </p>
      ) : null}
    </div>
  );
}

export function V2ImportFlow() {
  const [preview, previewAction] = useActionState(previewV2Action, IDLE);
  const [confirm, confirmAction] = useActionState(confirmV2Action, IDLE);
  // Seçili dosya React durumunda tutulur — form gönderilirken dosya kendi gizli alanına takılır.
  const [file, setFile] = useState<File | null>(null);
  const [noFileMsg, setNoFileMsg] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const attach = (e: React.FormEvent<HTMLFormElement>) => {
    if (!file) { e.preventDefault(); setNoFileMsg("Önce bir .xlsx dosyası seçin."); return; }
    setNoFileMsg(null);
    const dt = new DataTransfer(); dt.items.add(file);
    const hidden = e.currentTarget.elements.namedItem("file") as HTMLInputElement | null;
    if (hidden) hidden.files = dt.files;
  };

  // En son hangi eylem konuştuysa o gösterilir (zaman damgasına göre).
  const latest: V2FlowState = (() => {
    const p = preview.phase === "idle" ? null : preview;
    const c = confirm.phase === "idle" ? null : confirm;
    if (p && c) return (c as { at: string }).at >= (p as { at: string }).at ? c : p;
    return p ?? c ?? IDLE;
  })();

  const previewedName = preview.phase === "previewed" ? preview.report.filename : null;
  const fileChangedSincePreview = previewedName != null && file != null && file.name !== previewedName;

  return (
    <div className="space-y-4">
      {/* Modern Drag & Drop Dropzone */}
      <div id="v2-file-picker" className="space-y-3">
        <div
          onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setIsDragging(false);
            const dropped = e.dataTransfer.files?.[0];
            if (dropped && dropped.name.endsWith(".xlsx")) {
              setFile(dropped);
              setNoFileMsg(null);
            }
          }}
          className={`relative group rounded-2xl border-2 border-dashed p-6 text-center transition-all duration-200 ${
            isDragging
              ? "border-sky-500 bg-sky-500/10 shadow-lg shadow-sky-500/10"
              : file
                ? "border-emerald-500/50 bg-emerald-500/5"
                : "border-line-strong bg-surface-2/40 hover:border-sky-500/50 hover:bg-surface-2/70"
          }`}
        >
          {/* Native file input covering the dropzone for click & automated test support */}
          <input
            type="file"
            accept=".xlsx"
            data-testid="v2-file"
            onChange={(e) => {
              const selected = e.target.files?.[0] ?? null;
              setFile(selected);
              setNoFileMsg(null);
            }}
            className="absolute inset-0 z-10 h-full w-full opacity-0 cursor-pointer"
          />

          {!file ? (
            <div className="flex flex-col items-center justify-center pointer-events-none">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-sky-500/15 border border-sky-500/25 text-sky-400 mb-3 shadow-lg shadow-sky-500/10 group-hover:scale-105 transition-transform">
                <svg className="h-6 w-6 stroke-current stroke-2 fill-none" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 16.5V3m0 0l4.5 4.5M12 3L7.5 7.5M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5" />
                </svg>
              </div>
              <div className="font-sans text-sm font-medium text-tone-1">
                Excel dosyanızı buraya sürükleyip bırakın veya <span className="text-sky-400 underline decoration-sky-400/40 underline-offset-2">seçmek için tıklayın</span>
              </div>
              <div className="mt-1 font-sans text-xs text-tone-3">
                Yalnız .xlsx formatı · Maksimum 50 MB · 100.000 satıra kadar
              </div>
            </div>
          ) : (
            <div className="flex flex-col sm:flex-row items-center justify-between gap-4 pointer-events-none">
              <div className="flex items-center gap-3.5">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 shadow-md">
                  <svg className="h-6 w-6 stroke-current stroke-2 fill-none" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                  </svg>
                </div>
                <div className="text-left">
                  <div className="font-sans text-sm font-semibold text-tone-1 max-w-[280px] sm:max-w-md truncate">{file.name}</div>
                  <div className="mt-0.5 flex items-center gap-2 font-sans text-xs text-tone-3">
                    <span>{(file.size / 1024).toFixed(0)} KB</span>
                    <span>·</span>
                    <Badge tone="green">Yüklenmeye Hazır</Badge>
                  </div>
                </div>
              </div>
              <div className="font-sans text-xs text-sky-400 underline decoration-sky-400/40">
                Farklı dosya seçmek için tıklayın
              </div>
            </div>
          )}
        </div>

        {/* Action & Preview Form */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <form action={previewAction} onSubmit={attach} id="v2-preview-form" className="flex items-center gap-3">
            <input type="file" name="file" className="hidden" tabIndex={-1} aria-hidden="true" />
            <Submit label="ÖNİZLE" pending="ÇÖZÜMLENİYOR…" className="button-accent shadow-md shadow-sky-500/10" />
          </form>
          <div className="font-sans text-xs text-tone-3">
            Önizleme salt okunurdur; hiçbir veri yazmaz ve güvenle doğrulama yapar.
          </div>
        </div>
      </div>

      {noFileMsg ? (
        <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3.5 py-2 font-sans text-xs text-amber-300">
          {noFileMsg}
        </p>
      ) : null}

      {latest.phase === "rejected" ? (
        <div role="alert" data-testid="v2-rejection" className="rounded-2xl border border-rose-500/30 bg-rose-500/10 p-4 shadow-lg shadow-rose-500/5">
          <div className="flex items-center gap-2">
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-rose-500/20 text-rose-400 text-xs font-bold">!</span>
            <div className="font-mono text-xs font-bold uppercase tracking-wider text-rose-400">{latest.rejection.code}</div>
          </div>
          <p className="mt-2 font-sans text-sm font-medium text-tone-1">{latest.rejection.message}</p>
          {latest.rejection.detail ? <p className="mt-1 font-mono text-xs text-tone-3">{latest.rejection.detail}</p> : null}
        </div>
      ) : null}

      {preview.phase === "previewed" && latest.phase !== "imported" ? (
        <div className="space-y-4 rounded-2xl border border-line bg-surface-1/50 p-4">
          <Preview report={preview.report} />
          {/* 7. adım — kullanıcı onayı. Aynı dosya, önizlemenin sha256'sı gizli alanda. */}
          <form action={confirmAction} onSubmit={attach} className="flex flex-wrap items-center gap-3 border-t border-line pt-4" id="v2-confirm-form">
            <input type="file" name="file" className="hidden" tabIndex={-1} aria-hidden="true" />
            <input type="hidden" name="expectedSha256" value={preview.report.sha256} />
            <Submit label="ONAYLA VE İÇE AKTAR" pending="YAZILIYOR — TEK İŞLEM…" className="button-primary shadow-lg shadow-emerald-500/15" />
            <span className="font-sans text-xs text-tone-3">
              {fileChangedSincePreview
                ? `Seçili dosya (${file?.name}) önizlenen dosyadan (${previewedName}) farklı — lütfen önce yeniden önizleyin.`
                : "Önizlenen dosya tek bir veritabanı işleminde atomik olarak yazılır; hata olursa hiçbir şey değişmez."}
            </span>
          </form>
        </div>
      ) : null}

      {latest.phase === "imported" ? (
        <div className="space-y-3 rounded-2xl border border-emerald-500/40 bg-emerald-500/10 p-4 shadow-xl shadow-emerald-500/10" data-testid="v2-import-result">
          <div className="flex items-center gap-2">
            <div className="flex h-6 w-6 items-center justify-center rounded-full bg-emerald-500/20 text-emerald-400 text-xs">✓</div>
            <div className="font-sans text-sm font-bold text-emerald-300">BAŞARIYLA İÇE AKTARILDI</div>
          </div>
          <div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4 rounded-xl bg-surface-1/60 p-3 border border-emerald-500/20">
            <div>
              <div className="font-sans text-[11px] text-tone-3">Çalışma Kitabı</div>
              <a data-hard-nav="true" className="font-mono font-medium text-sky-400 underline underline-offset-2" href={`/data/imports/${latest.outcome.workbookId}`}>
                {latest.outcome.workbookId.slice(0, 8)}…
              </a>
            </div>
            <div>
              <div className="font-sans text-[11px] text-tone-3">SHA256</div>
              <div className="truncate font-mono text-tone-2" data-testid="v2-result-sha">{latest.outcome.sha256}</div>
            </div>
            <div>
              <div className="font-sans text-[11px] text-tone-3">Dosya</div>
              <div className="truncate font-medium text-tone-1">{latest.outcome.filename}</div>
            </div>
            <div>
              <div className="font-sans text-[11px] text-tone-3">Zaman</div>
              <div className="font-sans text-tone-2">{latest.at.replace("T", " ").slice(0, 19)} UTC</div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            <Counter k="Hazırlığa Yazılan" v={latest.outcome.rowsStaged} />
            <Counter k="Alana Yazılan" v={latest.outcome.rowsMapped} />
            <Counter k="İncelemeye Düşen" v={latest.outcome.rowsNeedsReview} tone="amber" />
            <Counter k="Reddedilen" v={latest.outcome.rowsRejected} tone="red" />
            <Counter k="Açılan İnceleme" v={latest.outcome.reviewsOpened} tone="amber" />
          </div>
          <div className="font-sans text-xs text-tone-2">
            {Object.entries(latest.outcome.perTable).length === 0
              ? "Domain tablolarına yazılan kayıt yok"
              : Object.entries(latest.outcome.perTable).map(([t, o]) => `${t}: +${o.inserted} / ~${o.updated}`).join(" · ")}
          </div>
          <p className="font-sans text-xs text-tone-3">
            Kaynak izi: Her satır <code>import_rows</code> tablosunda ham hâliyle saklanır. Ayrıntılar için çalışma kitabı bağlantısına; sorunlar için <a className="text-sky-400 underline underline-offset-2" href="/data/reviews">İnceleme kuyruğuna</a> gidin.
          </p>
        </div>
      ) : null}
    </div>
  );
}
