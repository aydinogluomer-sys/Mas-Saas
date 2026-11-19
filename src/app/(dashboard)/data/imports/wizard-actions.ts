"use server";

import { requireSession } from "@/lib/auth";
import { canPerform, canSeeRoute, type AppRole } from "@/lib/authz/matrix";
import { refreshMetricSnapshots } from "@/lib/analytics/snapshots";
import { validateContinuity } from "@/lib/cashflow/engine";
import { getPool } from "@/lib/db";
import {
  confirmImport,
  previewImport,
  type ImportOutcome,
  type PreviewReport,
  type Rejection,
} from "@/lib/importers/v2/service";
import {
  inspectFileForColumnWizard,
  synthesizeCanonicalV2Buffer,
  validateWizardUploadMeta,
  type WizardInspectionResult,
} from "@/lib/importers/v2/wizard";
import { ensureWindow } from "@/lib/radar/engine";
import { istanbulDateISO } from "@/lib/reports/rules";

export type WizardRejection =
  | Rejection
  | { code: "FORBIDDEN" | "NO_FILE" | "BAD_MAPPING"; message: string; detail?: string };

export type WizardFlowState =
  | { phase: "idle" }
  | { phase: "rejected"; rejection: WizardRejection; at: string }
  | { phase: "inspected"; inspection: WizardInspectionResult; at: string }
  | {
      phase: "previewed";
      inspection: WizardInspectionResult;
      report: PreviewReport;
      mapping: Record<string, string>;
      targetV2Sheet: string;
      sourceSheetName: string;
      at: string;
    }
  | {
      phase: "imported";
      outcome: {
        workbookId: string;
        sha256: string;
        filename: string;
        perTable: ImportOutcome["result"]["perTable"];
        rowsStaged: number;
        rowsMapped: number;
        rowsNeedsReview: number;
        rowsRejected: number;
        rowsBlockedByParent: number;
        reviewsOpened: number;
      };
      at: string;
    };

const now = () => new Date().toISOString();

async function authorizeWizard(): Promise<
  { ok: true; actorId: string; role: AppRole } | { ok: false; state: WizardFlowState }
> {
  const session = await requireSession();
  if (
    (!canSeeRoute(session.role, "/data/imports") && !canSeeRoute(session.role, "/data/imports/v2")) ||
    !canPerform(session.role, "import_workbook_v2")
  ) {
    return {
      ok: false,
      state: {
        phase: "rejected",
        at: now(),
        rejection: {
          code: "FORBIDDEN",
          message: "Bu oturumun rolü içe aktarım yapamaz. Yönetici veya operatör yetkisi gerekir.",
          detail: `rol=${session.role}`,
        },
      },
    };
  }
  return { ok: true, actorId: session.id, role: session.role };
}

async function readWizardFile(
  formData: FormData,
): Promise<{ ok: true; buf: Buffer; name: string } | { ok: false; state: WizardFlowState }> {
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return {
      ok: false,
      state: {
        phase: "rejected",
        at: now(),
        rejection: { code: "NO_FILE", message: "Lütfen bir .xlsx veya .csv dosyası seçin." },
      },
    };
  }
  const metaErr = validateWizardUploadMeta({ name: file.name, size: file.size });
  if (metaErr) {
    return { ok: false, state: { phase: "rejected", at: now(), rejection: metaErr } };
  }
  return { ok: true, buf: Buffer.from(await file.arrayBuffer()), name: file.name.trim() };
}

function parseMappingJson(raw: FormDataEntryValue | null): Record<string, string> | null {
  if (typeof raw !== "string" || raw.trim() === "") return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return null;
  }
}

export async function inspectWizardAction(
  _prev: WizardFlowState,
  formData: FormData,
): Promise<WizardFlowState> {
  const auth = await authorizeWizard();
  if (!auth.ok) return auth.state;
  const f = await readWizardFile(formData);
  if (!f.ok) return f.state;

  const preferredSourceSheet = String(formData.get("sourceSheetName") ?? "").trim() || undefined;
  const preferredTargetV2Sheet = String(formData.get("targetV2Sheet") ?? "").trim() || undefined;

  const res = await inspectFileForColumnWizard(f.buf, f.name, {
    preferredSourceSheet,
    preferredTargetV2Sheet,
  });
  if (!res.ok) {
    return { phase: "rejected", rejection: res.rejection, at: now() };
  }
  return { phase: "inspected", inspection: res.inspection, at: now() };
}

export async function previewWizardAction(
  _prev: WizardFlowState,
  formData: FormData,
): Promise<WizardFlowState> {
  const auth = await authorizeWizard();
  if (!auth.ok) return auth.state;
  const f = await readWizardFile(formData);
  if (!f.ok) return f.state;

  const sourceSheetName = String(formData.get("sourceSheetName") ?? "").trim();
  const targetV2Sheet = String(formData.get("targetV2Sheet") ?? "").trim();
  const mapping = parseMappingJson(formData.get("columnMappingJson"));
  if (!mapping) {
    return {
      phase: "rejected",
      at: now(),
      rejection: { code: "BAD_MAPPING", message: "Kolon eşleştirme verisi okunamadı." },
    };
  }

  const inspected = await inspectFileForColumnWizard(f.buf, f.name, {
    preferredSourceSheet: sourceSheetName || undefined,
    preferredTargetV2Sheet: targetV2Sheet || undefined,
  });
  if (!inspected.ok) {
    return { phase: "rejected", rejection: inspected.rejection, at: now() };
  }

  let effectiveBuffer = f.buf;
  let effectiveFilename = f.name;
  const effectiveTarget = targetV2Sheet || inspected.inspection.targetV2Sheet;
  const effectiveSource = sourceSheetName || inspected.inspection.selectedSourceSheet;

  if (inspected.inspection.mode === "interactive_mapping") {
    const synth = await synthesizeCanonicalV2Buffer(f.buf, f.name, {
      sourceSheetName: effectiveSource,
      targetV2Sheet: effectiveTarget,
      columnMapping: mapping,
    });
    if (!synth.ok) {
      return { phase: "rejected", rejection: synth.rejection, at: now() };
    }
    effectiveBuffer = synth.buffer;
    effectiveFilename = synth.effectiveFilename;
  }

  const client = await getPool().connect();
  try {
    const r = await previewImport(client, effectiveBuffer, effectiveFilename, auth.actorId, {
      role: auth.role,
    });
    if (!r.ok) return { phase: "rejected", rejection: r.rejection, at: now() };
    return {
      phase: "previewed",
      inspection: inspected.inspection,
      report: r.report,
      mapping,
      targetV2Sheet: effectiveTarget,
      sourceSheetName: effectiveSource,
      at: now(),
    };
  } finally {
    client.release();
  }
}

export async function confirmWizardAction(
  _prev: WizardFlowState,
  formData: FormData,
): Promise<WizardFlowState> {
  const auth = await authorizeWizard();
  if (!auth.ok) return auth.state;
  const f = await readWizardFile(formData);
  if (!f.ok) return f.state;

  const expectedSha256 = String(formData.get("expectedSha256") ?? "").trim();
  const mode = String(formData.get("mode") ?? "interactive_mapping").trim();
  const sourceSheetName = String(formData.get("sourceSheetName") ?? "").trim();
  const targetV2Sheet = String(formData.get("targetV2Sheet") ?? "").trim();
  const mapping = parseMappingJson(formData.get("columnMappingJson"));
  if (!mapping) {
    return {
      phase: "rejected",
      at: now(),
      rejection: { code: "BAD_MAPPING", message: "Kolon eşleştirme verisi okunamadı." },
    };
  }

  let effectiveBuffer = f.buf;
  let effectiveFilename = f.name;
  if (mode !== "canonical_v2") {
    const synth = await synthesizeCanonicalV2Buffer(f.buf, f.name, {
      sourceSheetName: sourceSheetName || undefined,
      targetV2Sheet,
      columnMapping: mapping,
    });
    if (!synth.ok) {
      return { phase: "rejected", rejection: synth.rejection, at: now() };
    }
    effectiveBuffer = synth.buffer;
    effectiveFilename = synth.effectiveFilename;
  }

  const r = await confirmImport(
    getPool(),
    effectiveBuffer,
    effectiveFilename,
    auth.actorId,
    expectedSha256,
    { role: auth.role },
  );
  if (!r.ok) return { phase: "rejected", rejection: r.rejection, at: now() };

  const pool = getPool();
  const pt = r.outcome.result.perTable;
  if ((pt.payments?.inserted ?? 0) + (pt.payments?.updated ?? 0) > 0) {
    await ensureWindow(pool, istanbulDateISO(), auth.actorId, 24).catch(() => undefined);
  }
  if (
    (pt.cashflow_months?.inserted ?? 0) +
      (pt.cashflow_months?.updated ?? 0) +
      (pt.cashflow_lines?.inserted ?? 0) +
      (pt.cashflow_lines?.updated ?? 0) >
    0
  ) {
    await validateContinuity(pool).catch(() => undefined);
  }
  await refreshMetricSnapshots(pool, auth.actorId).catch(() => undefined);

  const res = r.outcome.result;
  return {
    phase: "imported",
    at: now(),
    outcome: {
      workbookId: r.outcome.workbookId,
      sha256: r.outcome.sha256,
      filename: r.outcome.filename,
      perTable: res.perTable,
      rowsStaged: res.rowsStaged,
      rowsMapped: res.rowsMapped,
      rowsNeedsReview: res.rowsNeedsReview,
      rowsRejected: res.rowsRejected,
      rowsBlockedByParent: res.rowsBlockedByParent,
      reviewsOpened: res.reviewsOpened,
    },
  };
}

