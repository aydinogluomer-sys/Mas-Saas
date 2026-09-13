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
    <button type="submit" disabled={pending} className={`${className} px-3 py-2 text-xs disabled:opacity-50`}>
      {pending ? pendingLabel : label}
    </button>
  );
}

function Counter({ k, v, tone }: { k: string; v: number; tone?: Tone }) {
  return (
    <div className="border p-2" style={{ borderColor: "var(--line)", background: "var(--surface-2)", borderRadius: "var(--radius)" }}>
      <div className="font-mono text-[9px] uppercase tracking-wider" style={{ color: "var(--text-3)" }}>{k}</div>
      <div className="mt-0.5 flex items-center gap-2 font-mono text-lg tabular-nums">
        {v}
        {tone && v > 0 ? <Badge tone={tone}>dikkat</Badge> : null}
      </div>
    </div>
  );
}

function IssueList({ title, rows, hint }: { title: string; rows: Array<{ sheet: string; row: number | null; column: string | null; message: string }>; hint: string }) {
  return (
    <div className="border p-2" style={{ borderColor: "var(--line)", borderRadius: "var(--radius)" }}>
      <div className="mb-1 flex items-center justify-between">
        <div className="font-mono text-[10px] uppercase tracking-wider" style={{ color: "var(--text-3)" }}>{title}</div>
        <Badge tone={rows.length > 0 ? "amber" : "green"}>{rows.length}</Badge>
      </div>
      {rows.length === 0 ? (
        <p className="text-xs" style={{ color: "var(--text-3)" }}>yok</p>
      ) : (
        <>
          <p className="mb-1 text-[11px]" style={{ color: "var(--text-2)" }}>{hint}</p>
          <ul className="max-h-40 space-y-0.5 overflow-auto font-mono text-[11px]">
            {rows.slice(0, 50).map((r, i) => (
              <li key={i}>
                <span style={{ color: "var(--text-3)" }}>{r.sheet}{r.row != null ? `:${r.row}` : ""}{r.column ? ` · ${r.column}` : ""}</span>{" — "}{r.message}
              </li>
            ))}
            {rows.length > 50 ? <li style={{ color: "var(--text-3)" }}>… ve {rows.length - 50} satır daha</li> : null}
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
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 font-mono text-[11px]" style={{ color: "var(--text-2)" }}>
        <span>{report.filename}</span>
        <span>· {(report.bytes / 1024).toFixed(0)} KB</span>
        <span>· şema {report.schema.name} v{report.schema.version} · şablon {report.schema.template ?? "?"}</span>
        <span title="Önizlenen dosyanın SHA256'sı; onayda yeniden hesaplanır ve eşleşmesi zorunludur.">· sha256 {report.sha256.slice(0, 16)}…</span>
      </div>

      {/* plan §4.2 sayaçları — adları plandaki gibi */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <Counter k="YARATILACAK" v={c.create} />
        <Counter k="GÜNCELLENECEK" v={c.update} />
        <Counter k="İNCELEME" v={c.review} tone="amber" />
        <Counter k="REDDEDİLECEK" v={c.reject} tone="red" />
        <Counter k="BELİRLENEMEDİ" v={c.undetermined} tone="amber" />
      </div>
      <p className="font-mono text-[11px]" style={{ color: "var(--text-3)" }}>
        BELİRLENEMEDİ = kayıt kodu olmayan satır; yeni mi güncelleme mi olduğu ancak yazarken belli olur — önizleme tahmin etmez.
        {c.blockedByParent > 0 ? ` · ${c.blockedByParent} satır üst kaydı bu dosyada kabul edilmediği için yazılmayacak.` : ""}
        {c.stagedOnly > 0 ? ` · ${c.stagedOnly} satır (${report.stagedOnlyFamilies.join(", ")}) yalnız hazırlık katmanına yazılır; eşleyicisi yok.` : ""}
        {` · açılacak inceleme kaydı: ${c.reviewsToOpen}.`}
      </p>

      <div className="grid gap-2 lg:grid-cols-2">
        <div className="border p-2" style={{ borderColor: "var(--line)", borderRadius: "var(--radius)" }}>
          <div className="mb-1 flex items-center justify-between">
            <div className="font-mono text-[10px] uppercase tracking-wider" style={{ color: "var(--text-3)" }}>DESTEKLENMEYEN ALANLAR</div>
            <Badge tone={report.lists.unsupportedFields.length + report.lists.unknownSheets.length > 0 ? "amber" : "green"}>
              {report.lists.unsupportedFields.length + report.lists.unknownSheets.length}
            </Badge>
          </div>
          {report.lists.unsupportedFields.length === 0 && report.lists.unknownSheets.length === 0 ? (
            <p className="text-xs" style={{ color: "var(--text-3)" }}>yok</p>
          ) : (
            <ul className="font-mono text-[11px]">
              {report.lists.unsupportedFields.map((u, i) => <li key={`h${i}`}>{u.sheet} · başlık «{u.header}» — sözleşmede yok; hücreler ham veride korunur, alana yazılmaz</li>)}
              {report.lists.unknownSheets.map((s, i) => <li key={`s${i}`}>sayfa «{s}» — sözleşmede yok; içe aktarılmaz</li>)}
            </ul>
          )}
        </div>
        <IssueList title="TRY-DIŞI FİNANS KAYITLARI" rows={report.lists.nonTryFinance}
          hint="Bu sürüm çek/kredi toplamlarını yalnız TRY için hesaplar. Kayıt kaynakta korunur, finans KPI'larına girmez; kur çevrilmez." />
        <IssueList title="MÜKERRER ŞÜPHELİLER" rows={report.lists.duplicateSuspects}
          hint="Benzer kayıtlar otomatik birleştirilmez veya silinmez; incelemeye düşer." />
        <IssueList title="MISSING REQUIRED FIELD" rows={report.lists.missingRequired}
          hint="Zorunlu alanı boş satırlar yazılmaz. Boş = bilinmiyor; 0 yazmak farklı bir beyandır." />
      </div>

      {report.lists.forbiddenSheets.length > 0 ? (
        <div role="alert" data-testid="v2-forbidden-sheets" className="border px-3 py-2" style={{ borderColor: "var(--warn)", background: "color-mix(in srgb, var(--warn) 8%, transparent)", borderRadius: "var(--radius)" }}>
          <div className="font-mono text-[10px] uppercase" style={{ color: "var(--warn)" }}>YETKİ DIŞI SAYFALAR — onay reddedilecek</div>
          <ul className="mt-1 font-mono text-[11px]">
            {report.lists.forbiddenSheets.map((f) => (
              <li key={f.sheet}>{f.sheet} → {f.table} · {f.readyRows} hazır satır · gereken katman: {f.allowedRoles.join(" / ")}</li>
            ))}
          </ul>
          <p className="mt-1 text-xs" style={{ color: "var(--text-2)" }}>Bu sayfaları boşaltıp yeniden yükleyin ya da dosyayı yetkili bir kullanıcıya iletin.</p>
        </div>
      ) : null}

      <details className="text-xs">
        <summary className="cursor-pointer font-mono text-[11px]" style={{ color: "var(--text-2)" }}>Sayfa bazında ({report.sheets.length} sayfa)</summary>
        <table className="mt-1 w-full text-xs">
          <thead>
            <tr className="text-left font-mono text-[10px] uppercase" style={{ color: "var(--text-3)" }}>
              <th className="pr-2">sayfa</th><th className="pr-2 text-right">okunan</th><th className="pr-2 text-right">hazır</th>
              <th className="pr-2 text-right">inceleme</th><th className="pr-2 text-right">red</th><th className="pr-2 text-right">üst-engelli</th><th>eksik kolon</th>
            </tr>
          </thead>
          <tbody>
            {report.sheets.map((s) => (
              <tr key={s.sheet} className="border-t" style={{ borderColor: "var(--line)" }}>
                <td className="pr-2 font-mono">{s.sheet}</td>
                <td className="pr-2 text-right tabular-nums">{s.rowsRead}</td>
                <td className="pr-2 text-right tabular-nums">{s.ready}</td>
                <td className="pr-2 text-right tabular-nums">{s.needsReview}</td>
                <td className="pr-2 text-right tabular-nums">{s.rejected}</td>
                <td className="pr-2 text-right tabular-nums">{s.blockedByParent}</td>
                <td className="font-mono text-[10px]" style={{ color: "var(--text-3)" }}>{s.missingColumns.join(", ") || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>

      {nothingToWrite ? (
        <p className="font-mono text-[11px]" style={{ color: "var(--warn)" }}>
          Bu dosyada domain&apos;e yazılacak hazır satır yok. Onaylarsanız yalnız hazırlık katmanı ve inceleme kayıtları oluşur.
        </p>
      ) : null}
    </div>
  );
}

export function V2ImportFlow() {
  const [preview, previewAction] = useActionState(previewV2Action, IDLE);
  const [confirm, confirmAction] = useActionState(confirmV2Action, IDLE);
  // Seçili dosya React durumunda tutulur — <input type=file> bir formun İÇİNDE olsaydı React 19
  // eylem bittiğinde formu sıfırlar ve ikinci adımda (onay) dosya kaybolurdu. (Etkileşim kapısı
  // bunu birebir yakaladı: ONAYLA tıklanıyor, hiçbir şey olmuyordu.) Girdi formların dışında;
  // her form gönderilirken dosya kendi gizli alanına takılır.
  const [file, setFile] = useState<File | null>(null);
  const [noFileMsg, setNoFileMsg] = useState<string | null>(null);

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
  // Önizleme başka bir dosyaya aitse onay düğmesi anlamsız: sunucu zaten SHA ile durur, ama
  // kullanıcıya da söylenir.
  const previewedName = preview.phase === "previewed" ? preview.report.filename : null;
  const fileChangedSincePreview = previewedName != null && file != null && file.name !== previewedName;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2" id="v2-file-picker">
        <input
          type="file" accept=".xlsx" data-testid="v2-file"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="border border-line bg-black/40 p-2 font-mono text-xs file:mr-3 file:border-0 file:bg-surface-3 file:px-2 file:py-1 file:font-mono file:text-xs file:text-tone-1"
        />
        <form action={previewAction} onSubmit={attach} id="v2-preview-form" className="contents">
          <input type="file" name="file" className="hidden" tabIndex={-1} aria-hidden="true" />
          <Submit label="ÖNİZLE" pending="ÇÖZÜMLENİYOR…" className="button-ghost" />
        </form>
        <span className="font-mono text-[10px] text-tone-3">
          {file ? `${file.name} · ${(file.size / 1024).toFixed(0)} KB · ` : ""}yalnız .xlsx · en çok 50 MB · 100.000 satır · önizleme hiçbir şey yazmaz
        </span>
      </div>
      {noFileMsg ? <p className="font-mono text-[11px]" style={{ color: "var(--warn)" }}>{noFileMsg}</p> : null}

      {latest.phase === "rejected" ? (
        <div role="alert" data-testid="v2-rejection" className="border px-3 py-2" style={{ borderColor: "var(--neg)", background: "color-mix(in srgb, var(--neg) 8%, transparent)", borderRadius: "var(--radius)" }}>
          <div className="font-mono text-[10px] uppercase" style={{ color: "var(--neg)" }}>{latest.rejection.code}</div>
          <p className="text-sm">{latest.rejection.message}</p>
          {latest.rejection.detail ? <p className="mt-1 font-mono text-[10px]" style={{ color: "var(--text-3)" }}>{latest.rejection.detail}</p> : null}
        </div>
      ) : null}

      {preview.phase === "previewed" && latest.phase !== "imported" ? (
        <div className="space-y-3 border-t pt-3" style={{ borderColor: "var(--line)" }}>
          <Preview report={preview.report} />
          {/* 7. adım — kullanıcı onayı. Aynı dosya, önizlemenin sha256'sı gizli alanda. */}
          <form action={confirmAction} onSubmit={attach} className="flex flex-wrap items-center gap-2" id="v2-confirm-form">
            <input type="file" name="file" className="hidden" tabIndex={-1} aria-hidden="true" />
            <input type="hidden" name="expectedSha256" value={preview.report.sha256} />
            <Submit label="ONAYLA VE İÇE AKTAR" pending="YAZILIYOR — TEK İŞLEM…" className="button-primary" />
            <span className="font-mono text-[10px] text-tone-3">
              {fileChangedSincePreview
                ? `seçili dosya (${file?.name}) önizlenen dosyadan (${previewedName}) farklı — önce yeniden önizleyin`
                : "önizlenen dosya tek bir veritabanı işleminde yazılır; hata olursa hiçbir şey değişmez"}
            </span>
          </form>
        </div>
      ) : null}

      {latest.phase === "imported" ? (
        <div className="space-y-2 border px-3 py-2" style={{ borderColor: "var(--pos)", background: "color-mix(in srgb, var(--pos) 8%, transparent)", borderRadius: "var(--radius)" }} data-testid="v2-import-result">
          <div className="font-mono text-[10px] uppercase" style={{ color: "var(--pos)" }}>İÇE AKTARILDI</div>
          <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
            <div><div className="font-mono text-[9px] uppercase text-tone-3">workbook</div><a data-hard-nav="true" className="font-mono underline" href={`/data/imports/${latest.outcome.workbookId}`}>{latest.outcome.workbookId.slice(0, 8)}…</a></div>
            <div><div className="font-mono text-[9px] uppercase text-tone-3">sha256</div><div className="truncate font-mono" data-testid="v2-result-sha">{latest.outcome.sha256}</div></div>
            <div><div className="font-mono text-[9px] uppercase text-tone-3">dosya</div><div className="truncate font-mono">{latest.outcome.filename}</div></div>
            <div><div className="font-mono text-[9px] uppercase text-tone-3">zaman</div><div className="font-mono">{latest.at.replace("T", " ").slice(0, 19)} UTC</div></div>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            <Counter k="HAZIRLIĞA YAZILAN" v={latest.outcome.rowsStaged} />
            <Counter k="ALANA YAZILAN" v={latest.outcome.rowsMapped} />
            <Counter k="İNCELEMEYE DÜŞEN" v={latest.outcome.rowsNeedsReview} tone="amber" />
            <Counter k="REDDEDİLEN" v={latest.outcome.rowsRejected} tone="red" />
            <Counter k="AÇILAN İNCELEME" v={latest.outcome.reviewsOpened} tone="amber" />
          </div>
          <div className="font-mono text-[11px]" style={{ color: "var(--text-2)" }}>
            {Object.entries(latest.outcome.perTable).length === 0
              ? "domain tablolarına yazılan kayıt yok"
              : Object.entries(latest.outcome.perTable).map(([t, o]) => `${t}: +${o.inserted} / ~${o.updated}`).join(" · ")}
          </div>
          <p className="font-mono text-[11px]" style={{ color: "var(--text-3)" }}>
            Kaynak izi: her satır <code>import_rows</code>&apos;ta ham hâliyle, her yazılan kayıt kaynak satırına bağlı. Ayrıntı için workbook bağlantısı; sorunlar için <a className="underline" href="/data/reviews">İnceleme kuyruğu</a>.
          </p>
        </div>
      ) : null}
    </div>
  );
}
