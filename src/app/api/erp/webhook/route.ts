import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { verifyErpApiKey } from "@/lib/erp/bridge";
import { ingestErpPayload } from "@/lib/erp/engine";
import { erpWebhookPayloadSchema } from "@/lib/erp/types";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const startTime = Date.now();

  try {
    // 1. Authorization check
    const apiKey =
      req.headers.get("x-erp-api-key") ??
      req.headers.get("authorization") ??
      req.headers.get("api-key");

    const { env } = await import("@/lib/env");
    if (!verifyErpApiKey(apiKey, env.erpApiKey)) {
      return NextResponse.json(
        { ok: false, error: "Yetkisiz erişim: Geçersiz veya eksik ERP API anahtarı" },
        { status: 401 },
      );
    }

    // 2. Parse & validate JSON body
    const body = await req.json().catch(() => null);
    if (!body) {
      return NextResponse.json(
        { ok: false, error: "Geçersiz istek: JSON gövdesi bekleniyor" },
        { status: 400 },
      );
    }

    const parsed = erpWebhookPayloadSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        {
          ok: false,
          error: "Şema doğrulama hatası",
          issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
        },
        { status: 422 },
      );
    }

    const { vendor, payloadType, data } = parsed.data;
    const pool = getPool();

    // 3. Ingest into database
    const outcome = await ingestErpPayload(
      pool,
      vendor,
      payloadType,
      data,
      `erp_webhook:${vendor}`,
    );

    const durationMs = Date.now() - startTime;

    return NextResponse.json({
      ...outcome,
      durationMs,
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message, durationMs: Date.now() - startTime },
      { status: 500 },
    );
  }
}
