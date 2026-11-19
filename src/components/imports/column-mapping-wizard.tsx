"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import {
  confirmWizardAction,
  inspectWizardAction,
  previewWizardAction,
  type WizardFlowState,
} from "@/app/(dashboard)/data/imports/wizard-actions";
import { Badge, type Tone } from "@/components/ui/badge";

const IDLE: WizardFlowState = { phase: "idle" };

function WizardSubmit({
  label,
  pendingText,
  variant = "primary",
}: {
  label: string;
  pendingText: string;
  variant?: "primary" | "ghost";
}) {
  const { pending } = useFormStatus();
  const cls = variant === "primary" ? "button-primary" : "button-ghost";
  return (
    <button type="submit" disabled={pending} className={`${cls} px-3 py-1.5 text-xs disabled:opacity-50`}>
      {pending ? pendingText : label}
    </button>
  );
}

function StepPill({ step, active, done, title }: { step: number; active: boolean; done: boolean; title: string }) {
  return (
    <div
      className={`flex items-center gap-2 rounded border px-3 py-1.5 text-xs ${
        active
          ? "border-accent bg-accent/10 font-semibold text-tone-1"
          : done
            ? "border-pos/40 bg-pos/10 text-pos"
            : "border-line bg-surface-2 text-tone-3"
      }`}
    >
      <span className="font-mono text-[11px]">{done ? "✓" : `0${step}`}</span>
      <span>{title}</span>
    </div>
  );
}

function MetricBox({ label, value, tone }: { label: string; value: number; tone?: Tone }) {
  return (
    <div className="rounded border border-line bg-surface-2 px-2.5 py-2">
      <div className="font-mono text-[10px] uppercase tracking-wider text-tone-3">{label}</div>
      <div className="mt-0.5 flex items-center justify-between gap-2 font-mono text-base font-semibold tabular-nums text-tone-1">
        <span>{value}</span>
        {tone && value > 0 ? <Badge tone={tone}>dikkat</Badge> : null}
      </div>
    </div>
  );
}

export function ColumnMappingWizard({ templateHref }: { templateHref: string }) {
  const [inspected, inspectAction] = useActionState(inspectWizardAction, IDLE);
  const [previewed, previewAction] = useActionState(previewWizardAction, IDLE);
  const [confirmed, confirmAction] = useActionState(confirmWizardAction, IDLE);

  const [file, setFile] = useState<File | null>(null);
  const [noFileMsg, setNoFileMsg] = useState<string | null>(null);
  const [targetSheetOverride, setTargetSheetOverride] = useState<string>("");
  const [sourceSheetOverride, setSourceSheetOverride] = useState<string>("");
  const [mappingOverrides, setMappingOverrides] = useState<Record<string, string>>({});

  const latest: WizardFlowState = (() => {
    const candidates = [inspected, previewed, confirmed].filter(
      (s): s is Exclude<WizardFlowState, { phase: "idle" }> => s.phase !== "idle",
    );
    if (candidates.length === 0) return IDLE;
    candidates.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    return candidates[0];
  })();

  const activeInspection =
    latest.phase === "inspected"
      ? latest.inspection
      : latest.phase === "previewed"
        ? latest.inspection
        : inspected.phase === "inspected"
          ? inspected.inspection
          : null;

  const effectiveTargetSheet = targetSheetOverride || activeInspection?.targetV2Sheet || "08_FATURALAR";
  const effectiveSourceSheet = sourceSheetOverride || activeInspection?.selectedSourceSheet || "";

  const targetSheetSpec =
    activeInspection?.targetSheetOptions.find((s) => s.name === effectiveTargetSheet) ??
    activeInspection?.targetSheetOptions[0] ??
    null;

  const effectiveMapping: Record<string, string> = {};
  if (activeInspection) {
    for (const col of activeInspection.columns) {
      const k = String(col.colIndex);
      effectiveMapping[k] =
        k in mappingOverrides ? mappingOverrides[k] : (col.suggestedKey ?? "");
    }
  }

  const attachFile = (e: React.FormEvent<HTMLFormElement>) => {
    if (!file) {
      e.preventDefault();
      setNoFileMsg("Önce bir .xlsx veya .csv dosyası seçin.");
      return;
    }
    setNoFileMsg(null);
    const dt = new DataTransfer();
    dt.items.add(file);
    const hidden = e.currentTarget.elements.namedItem("file") as HTMLInputElement | null;
    if (hidden) hidden.files = dt.files;
  };

  const currentStep =
    latest.phase === "imported"
      ? 3
      : latest.phase === "previewed"
        ? 3
        : activeInspection
          ? 2
          : 1;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <StepPill step={1} active={currentStep === 1} done={currentStep > 1} title="Dosya Yükle (.xlsx / .csv)" />
          <StepPill step={2} active={currentStep === 2} done={currentStep > 2} title="Kolon Eşleştirme & Tanıma" />
          <StepPill step={3} active={currentStep === 3} done={latest.phase === "imported"} title="Atomik Önizleme & Kayıt" />
        </div>
        <a data-hard-nav="true" href={templateHref} className="button-ghost px-2.5 py-1 text-xs">
          Standart V2 Şablonu İndir (.xlsx)
        </a>
      </div>

      {/* STEP 1: FILE PICKER */}
      <div className="flex flex-wrap items-center gap-2.5">
        <input
          type="file"
          accept=".xlsx,.csv"
          data-testid="wizard-file-input"
          onChange={(e) => {
            const f = e.target.files?.[0] ?? null;
            setFile(f);
            setMappingOverrides({});
            setTargetSheetOverride("");
            setSourceSheetOverride("");
          }}
          className="rounded border border-line bg-surface-2 p-2 font-mono text-xs text-tone-1 file:mr-3 file:rounded file:border-0 file:bg-surface-3 file:px-2.5 file:py-1 file:font-mono file:text-xs file:text-tone-1"
        />
        <form action={inspectAction} onSubmit={attachFile} className="contents">
          <input type="file" name="file" className="hidden" tabIndex={-1} aria-hidden="true" />
          <input type="hidden" name="sourceSheetName" value={sourceSheetOverride} />
          <input type="hidden" name="targetV2Sheet" value={targetSheetOverride} />
          <WizardSubmit
            label="1 · Sütunları Analiz Et"
            pendingText="Başlıklar Taranıyor…"
            variant="primary"
          />
        </form>
        <span className="font-mono text-[11px] text-tone-3">
          {file ? `${file.name} · ${(file.size / 1024).toFixed(1)} KB · ` : ""}
          Serbest Excel (.xlsx), CSV (.csv) veya Standart 17-Sayfa V2 Şablonu · Tüm dövizler (TRY/USD/EUR/GBP) desteklenir
        </span>
      </div>

      {noFileMsg ? (
        <div className="rounded border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">{noFileMsg}</div>
      ) : null}

      {latest.phase === "rejected" ? (
        <div role="alert" className="rounded border border-neg/40 bg-neg/10 px-3 py-2 text-xs text-neg">
          <div className="font-mono text-[10px] font-semibold uppercase">{latest.rejection.code}</div>
          <p className="mt-0.5 text-sm">{latest.rejection.message}</p>
          {latest.rejection.detail ? (
            <p className="mt-1 font-mono text-[10px] text-tone-3">{latest.rejection.detail}</p>
          ) : null}
        </div>
      ) : null}

      {/* STEP 2: INTERACTIVE COLUMN MAPPING */}
      {activeInspection && latest.phase !== "imported" ? (
        <div className="space-y-3 rounded border border-line bg-surface-2 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs font-semibold text-tone-1">
                  2 · KOLON EŞLEŞTİRME HARİTASI — {activeInspection.filename}
                </span>
                <Badge tone={activeInspection.mode === "canonical_v2" ? "green" : "blue"}>
                  {activeInspection.mode === "canonical_v2"
                    ? "Tam V2 Sözleşme Şablonu Algılandı"
                    : `Serbest ${activeInspection.ext.toUpperCase()} Sütun Eşleştirme`}
                </Badge>
              </div>
              <p className="mt-0.5 text-xs text-tone-2">
                Toplam {activeInspection.totalDataRows.toLocaleString("tr-TR")} veri satırı okundu. Eşleşmeyen sütunlar
                kaybolmaz; <code className="font-mono">import_rows.row_json</code> içinde ham kanıt olarak saklanır.
              </p>
            </div>

            {activeInspection.mode === "interactive_mapping" ? (
              <div className="flex flex-wrap items-center gap-2 text-xs">
                {activeInspection.sourceSheets.length > 1 ? (
                  <label className="flex items-center gap-1">
                    <span className="font-mono text-[10px] uppercase text-tone-3">Kaynak Sekme:</span>
                    <select
                      value={effectiveSourceSheet}
                      onChange={(e) => setSourceSheetOverride(e.target.value)}
                      className="field-control px-2 py-1 text-xs"
                    >
                      {activeInspection.sourceSheets.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                <label className="flex items-center gap-1">
                  <span className="font-mono text-[10px] uppercase text-tone-3">Hedef V2 Modülü:</span>
                  <select
                    value={effectiveTargetSheet}
                    onChange={(e) => {
                      setTargetSheetOverride(e.target.value);
                      setMappingOverrides({});
                    }}
                    className="field-control px-2 py-1 font-mono text-xs"
                  >
                    {activeInspection.targetSheetOptions.map((opt) => (
                      <option key={opt.name} value={opt.name}>
                        {opt.name} — {opt.title}
                      </option>
                    ))}
                  </select>
                </label>
                <form action={inspectAction} onSubmit={attachFile} className="inline">
                  <input type="file" name="file" className="hidden" tabIndex={-1} aria-hidden="true" />
                  <input type="hidden" name="sourceSheetName" value={effectiveSourceSheet} />
                  <input type="hidden" name="targetV2Sheet" value={effectiveTargetSheet} />
                  <WizardSubmit label="Başlıkları Yeniden Eşle" pendingText="Eşleniyor…" variant="ghost" />
                </form>
              </div>
            ) : null}
          </div>

          {activeInspection.mode === "canonical_v2" && activeInspection.canonicalSheetSummary ? (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {activeInspection.canonicalSheetSummary.map((s) => (
                <div key={s.sheet} className="rounded border border-line bg-surface px-2.5 py-2 text-xs">
                  <div className="font-mono font-semibold text-tone-1">{s.sheet}</div>
                  <div className="text-[11px] text-tone-2">
                    {s.rowsRead} satır · {s.matchedHeaders} sözleşmeli kolon
                    {s.unknownHeaders.length > 0 ? ` · ${s.unknownHeaders.length} ek kolon` : ""}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="overflow-x-auto rounded border border-line bg-surface">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-line text-left font-mono text-[10px] uppercase tracking-wider text-tone-3">
                    <th className="px-2.5 py-1.5">Kaynak Kolon Başlığı</th>
                    <th className="px-2.5 py-1.5">Örnek Hücre Değerleri</th>
                    <th className="px-2.5 py-1.5">Tanıma</th>
                    <th className="px-2.5 py-1.5">Hedef V2 Alanı ({effectiveTargetSheet})</th>
                  </tr>
                </thead>
                <tbody>
                  {activeInspection.columns.map((col) => {
                    const currentVal = effectiveMapping[String(col.colIndex)] ?? "";
                    return (
                      <tr key={col.colIndex} className="border-b border-line-faint">
                        <td className="px-2.5 py-1.5 font-mono font-medium text-tone-1">{col.rawHeader}</td>
                        <td className="max-w-xs truncate px-2.5 py-1.5 font-mono text-[11px] text-tone-2">
                          {col.sampleValues.length > 0 ? col.sampleValues.join(" · ") : "—"}
                        </td>
                        <td className="px-2.5 py-1.5">
                          <Badge
                            tone={
                              col.matchKind === "exact_contract"
                                ? "green"
                                : col.matchKind === "synonym"
                                  ? "blue"
                                  : "neutral"
                            }
                          >
                            {col.matchKind === "exact_contract"
                              ? "Tam Sözleşme"
                              : col.matchKind === "synonym"
                                ? "Otomatik EşAnlam"
                                : "Ham Kanıt"}
                          </Badge>
                        </td>
                        <td className="px-2.5 py-1.5">
                          <select
                            value={currentVal}
                            onChange={(e) =>
                              setMappingOverrides((prev) => ({
                                ...prev,
                                [String(col.colIndex)]: e.target.value,
                              }))
                            }
                            className="field-control w-full max-w-xs px-2 py-1 font-mono text-xs"
                          >
                            <option value="">— Ham kanıtta koru (import_rows) —</option>
                            <option value="__skip__">— Sütunu tamamen atla —</option>
                            {targetSheetSpec?.columns.map((tc) => (
                              <option key={tc.key} value={tc.key}>
                                {tc.header} ({tc.key}){tc.required ? " *" : ""}
                              </option>
                            ))}
                          </select>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <form action={previewAction} onSubmit={attachFile} className="flex flex-wrap items-center gap-2">
            <input type="file" name="file" className="hidden" tabIndex={-1} aria-hidden="true" />
            <input type="hidden" name="sourceSheetName" value={effectiveSourceSheet} />
            <input type="hidden" name="targetV2Sheet" value={effectiveTargetSheet} />
            <input type="hidden" name="columnMappingJson" value={JSON.stringify(effectiveMapping)} />
            <WizardSubmit
              label="2 · Eşleştirmeyi Doğrula & Satırları Önizle"
              pendingText="Atomik Kuru-Çalıştırma (Dry-Run) Yapılıyor…"
              variant="primary"
            />
            <span className="font-mono text-[11px] text-tone-3">
              Önizleme veritabanına hiçbir kayıt yazmaz; SHA-256 ve tüm satır kısıtlarını doğrular.
            </span>
          </form>
        </div>
      ) : null}

      {/* STEP 3: PREVIEW & ATOMIC COMMIT */}
      {latest.phase === "previewed" ? (
        <div className="space-y-3 rounded border border-line bg-surface p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-mono text-xs font-semibold text-tone-1">
              3 · ATOMİK ÖNİZLEME RAPORU — SHA256 {latest.report.sha256.slice(0, 16)}…
            </span>
            <Badge tone={latest.report.counters.reject > 0 ? "amber" : "green"}>
              {latest.report.counters.create + latest.report.counters.update} satır yazıma hazır
            </Badge>
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            <MetricBox label="Yaratılacak" value={latest.report.counters.create} />
            <MetricBox label="Güncellenecek" value={latest.report.counters.update} />
            <MetricBox label="İnceleme" value={latest.report.counters.review} tone="amber" />
            <MetricBox label="Reddedilecek" value={latest.report.counters.reject} tone="red" />
            <MetricBox label="Belirlenemedi" value={latest.report.counters.undetermined} tone="amber" />
          </div>

          {latest.report.lists.missingRequired.length > 0 ? (
            <div className="rounded border border-warn/40 bg-warn/10 p-2 font-mono text-[11px] text-warn">
              Zorunlu alanı eksik {latest.report.lists.missingRequired.length} satır var:{" "}
              {latest.report.lists.missingRequired
                .slice(0, 4)
                .map((m) => `${m.sheet}:${m.row ?? "?"} (${m.message})`)
                .join(" · ")}
            </div>
          ) : null}

          <form action={confirmAction} onSubmit={attachFile} className="flex flex-wrap items-center gap-2.5 pt-1">
            <input type="file" name="file" className="hidden" tabIndex={-1} aria-hidden="true" />
            <input type="hidden" name="expectedSha256" value={latest.report.sha256} />
            <input type="hidden" name="mode" value={latest.inspection.mode} />
            <input type="hidden" name="sourceSheetName" value={latest.sourceSheetName} />
            <input type="hidden" name="targetV2Sheet" value={latest.targetV2Sheet} />
            <input type="hidden" name="columnMappingJson" value={JSON.stringify(latest.mapping)} />
            <WizardSubmit
              label="3 · Onayla ve Atomik Olarak İçe Aktar"
              pendingText="Tek Veritabanı İşleminde Yazılıyor…"
              variant="primary"
            />
            <span className="font-mono text-[11px] text-tone-3">
              Ya tüm uygun satırlar tek transaction içinde yazılır ya da hata anında sıfır iz bırakarak geri alınır.
            </span>
          </form>
        </div>
      ) : null}

      {latest.phase === "imported" ? (
        <div
          data-testid="wizard-import-result"
          className="space-y-2 rounded border border-pos/40 bg-pos/10 px-3 py-2.5"
        >
          <div className="font-mono text-xs font-semibold uppercase text-pos">
            ✓ ATOMİK İÇE AKTARIM TAMAMLANDI
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            <MetricBox label="Hazırlığa Yazılan" value={latest.outcome.rowsStaged} />
            <MetricBox label="Domain'e Yazılan" value={latest.outcome.rowsMapped} />
            <MetricBox label="İncelemeye Düşen" value={latest.outcome.rowsNeedsReview} tone="amber" />
            <MetricBox label="Reddedilen" value={latest.outcome.rowsRejected} tone="red" />
            <MetricBox label="Açılan İnceleme" value={latest.outcome.reviewsOpened} tone="amber" />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-xs text-tone-1">
            <span>
              {Object.entries(latest.outcome.perTable)
                .map(([t, o]) => `${t}: +${o.inserted} / ~${o.updated}`)
                .join(" · ") || "Yalnız hazırlık katmanı güncellendi"}
            </span>
            <a
              data-hard-nav="true"
              href={`/data/imports/${latest.outcome.workbookId}`}
              className="underline decoration-line-strong underline-offset-2"
            >
              Kaynak İzi & Workbook Detayını Aç →
            </a>
          </div>
        </div>
      ) : null}
    </div>
  );
}

