import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth";
import { can } from "@/lib/authz/matrix";
import { getPool } from "@/lib/db";
import { DomainError } from "@/lib/domain-error";
import { loadVerifiedDocumentDownload } from "@/lib/documents/engine";
import { DocumentIntegrityError } from "@/lib/documents/storage";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ documentId: string }> },
): Promise<Response> {
  const session = await requireApiSession();
  if (!session) {
    return NextResponse.json({ error: "Oturum gerekli." }, { status: 401 });
  }
  if (!can(session.role, "documents", "select") || !can(session.role, "attachments", "select")) {
    return NextResponse.json({ error: "Doküman indirme yetkiniz yok." }, { status: 403 });
  }

  const { documentId } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(documentId)) {
    return NextResponse.json({ error: "Geçersiz doküman kimliği." }, { status: 400 });
  }

  const url = new URL(request.url);
  const versionParam = url.searchParams.get("version");
  const versionNo = versionParam ? Number(versionParam) : undefined;
  if (versionParam && (!Number.isInteger(versionNo) || (versionNo ?? 0) < 1)) {
    return NextResponse.json({ error: "Geçersiz sürüm numarası." }, { status: 400 });
  }

  try {
    const file = await loadVerifiedDocumentDownload(getPool(), documentId, versionNo);
    const asciiFallback = file.originalFilename.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
    const encoded = encodeURIComponent(file.originalFilename);
    return new Response(new Uint8Array(file.bytes), {
      status: 200,
      headers: {
        "Content-Type": file.mimeType,
        "Content-Length": String(file.bytes.byteLength),
        "Content-Disposition": `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`,
        "X-Content-Type-Options": "nosniff",
        "X-Document-Sha256": file.sha256,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (e) {
    if (e instanceof DomainError) {
      return NextResponse.json({ error: e.message }, { status: e.code === "NOT_FOUND" ? 404 : 400 });
    }
    if (e instanceof DocumentIntegrityError) {
      return NextResponse.json({ error: e.message }, { status: 409 });
    }
    throw e;
  }
}

