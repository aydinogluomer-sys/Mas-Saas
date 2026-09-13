"use server";

// PHASE 4 — /data/imports/v2 sunucu eylemleri: ÖNİZLE ve ONAYLA.
//
// İki eylem de dosyayı alır; ikincisi ayrıca önizlemede gösterilen sha256'yı taşır ve servis
// katmanı eşleşmezse yazmadan durur (service.ts başlığındaki gerekçe). Rol denetimi burada
// BAĞIMSIZ olarak yapılır: sayfa kapısı (requireRouteAccess) bir UI kararıdır; eylem ise gerçek
// yazma noktasıdır ve doğrudan çağrılabilir.
import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/auth";
import { canPerform } from "@/lib/authz/matrix";
import { getPool } from "@/lib/db";
import { refreshMetricSnapshots } from "@/lib/analytics/snapshots";
import {
  confirmImport, previewImport, validateUploadMeta,
  type ImportOutcome, type PreviewReport, type Rejection,
} from "@/lib/importers/v2/service";

export type V2Rejection = Rejection | { code: "FORBIDDEN" | "NO_FILE"; message: string; detail?: string };

export type V2FlowState =
  | { phase: "idle" }
  | { phase: "rejected"; rejection: V2Rejection; at: string }
  | { phase: "previewed"; report: PreviewReport; at: string }
  | { phase: "imported"; outcome: { workbookId: string; sha256: string; filename: string; perTable: ImportOutcome["result"]["perTable"]; rowsStaged: number; rowsMapped: number; rowsNeedsReview: number; rowsRejected: number; rowsBlockedByParent: number; reviewsOpened: number }; at: string };

const now = () => new Date().toISOString();

async function authorize(): Promise<{ ok: true; actorId: string } | { ok: false; state: V2FlowState }> {
  const session = await requireSession();
  if (!canPerform(session.role, "import_workbook_v2")) {
    return { ok: false, state: { phase: "rejected", at: now(), rejection: {
      code: "FORBIDDEN",
      message: "Bu oturumun katmanı içe aktarma yapamaz (izleyici / onaylayıcı yalnız okur). Gerekiyorsa bir yöneticiden operatör yetkisi isteyin.",
      detail: `rol=${session.role}`,
    } } };
  }
  return { ok: true, actorId: session.id };
}

async function readFile(formData: FormData): Promise<{ ok: true; buf: Buffer; name: string } | { ok: false; state: V2FlowState }> {
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, state: { phase: "rejected", at: now(), rejection: { code: "NO_FILE", message: "Dosya seçilmedi." } } };
  }
  // Baytları okumadan önce ad/uzantı/boyut: 50 MB üstü dosya belleğe alınmaz.
  const meta = validateUploadMeta({ name: file.name, size: file.size });
  if (meta) return { ok: false, state: { phase: "rejected", at: now(), rejection: meta } };
  return { ok: true, buf: Buffer.from(await file.arrayBuffer()), name: file.name.trim() };
}

export async function previewV2Action(_prev: V2FlowState, formData: FormData): Promise<V2FlowState> {
  const auth = await authorize();
  if (!auth.ok) return auth.state;
  const f = await readFile(formData);
  if (!f.ok) return f.state;

  const client = await getPool().connect();
  try {
    const r = await previewImport(client, f.buf, f.name, auth.actorId);
    if (!r.ok) return { phase: "rejected", rejection: r.rejection, at: now() };
    return { phase: "previewed", report: r.report, at: now() };
  } finally {
    client.release();
  }
}

export async function confirmV2Action(_prev: V2FlowState, formData: FormData): Promise<V2FlowState> {
  const auth = await authorize();
  if (!auth.ok) return auth.state;
  const f = await readFile(formData);
  if (!f.ok) return f.state;
  const expected = String(formData.get("expectedSha256") ?? "");

  const r = await confirmImport(getPool(), f.buf, f.name, auth.actorId, expected);
  if (!r.ok) return { phase: "rejected", rejection: r.rejection, at: now() };

  // Anlık görüntüler: import sonrası panolar taze olsun. Başarısızlığı import'u geri almaz —
  // import zaten COMMIT edildi; snapshot yenilemesi ayrı, yeniden çalıştırılabilir bir iştir.
  await refreshMetricSnapshots(getPool(), auth.actorId).catch(() => undefined);
  revalidatePath("/data/imports");
  revalidatePath("/data/imports/v2");
  revalidatePath("/data/reviews");
  revalidatePath("/data/quality");

  const res = r.outcome.result;
  return {
    phase: "imported", at: now(),
    outcome: {
      workbookId: r.outcome.workbookId, sha256: r.outcome.sha256, filename: r.outcome.filename,
      perTable: res.perTable, rowsStaged: res.rowsStaged, rowsMapped: res.rowsMapped,
      rowsNeedsReview: res.rowsNeedsReview, rowsRejected: res.rowsRejected,
      rowsBlockedByParent: res.rowsBlockedByParent, reviewsOpened: res.reviewsOpened,
    },
  };
}
