// PHASE 4 — şablon indirme (plan §4.1 adım 1, §4.6 DOWNLOAD_TEMPLATE).
//
// Şablon depodan okunmaz, sözleşmeden ÜRETİLİR: `templates/*.xlsx` kopyası bir gün güncellenmeyi
// unutulsa bile kullanıcı sözleşmeyle aynı kolonları alır. Üretim byte-deterministik
// (zip-canonical) → her indirme aynı sha256; başlıkta taşınır ki "hangi şablonu doldurdunuz"
// sorusu tek bir özetle cevaplanabilsin. Kullanıcı girdisi YOK: yol/ad sabit, traversal yüzeyi yok.
import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { requireApiSession } from "@/lib/auth";
import { canAccessRoute } from "@/lib/authz/route-access";
import { buildTemplateBuffer, TEMPLATE_FILENAME } from "@/lib/importers/v2/template";

export const dynamic = "force-dynamic";

export async function GET() {
  // requireApiSession: a live session whose user is not under a forced password change (0095).
  const user = await requireApiSession();
  if (!user) return NextResponse.json({ error: "Yetkisiz." }, { status: 401 });
  // Şablonu indirebilen = sayfayı açabilen (operator/manager/admin). Salt-okur katmanlar 403.
  if (!canAccessRoute(user.role, "/data/imports/v2")) {
    return NextResponse.json({ error: "Bu katman içe aktarma yapamaz; şablon indirme de o yüzeyin parçasıdır." }, { status: 403 });
  }

  const { buffer } = await buildTemplateBuffer();
  const sha = createHash("sha256").update(buffer).digest("hex");
  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${TEMPLATE_FILENAME}"`,
      "Content-Length": String(buffer.length),
      "X-Template-SHA256": sha,
      ETag: `"${sha}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
