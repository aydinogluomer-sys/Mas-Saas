import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSampleErpPayload } from "@/lib/erp/bridge";
import { getErpIntegrationSummary, ingestErpPayload } from "@/lib/erp/engine";
import { ERP_VENDORS, type ErpVendor } from "@/lib/erp/types";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const pool = getPool();
    const summary = await getErpIntegrationSummary(pool);
    return NextResponse.json({ ok: true, ...summary });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      vendor?: string;
      sample?: boolean;
      data?: Array<Record<string, unknown>>;
    };

    const vendor = (body.vendor || "logo") as ErpVendor;
    if (!ERP_VENDORS.includes(vendor)) {
      return NextResponse.json({ ok: false, error: "Geçersiz vendor" }, { status: 400 });
    }

    const pool = getPool();

    // If sample requested or no data provided, use the realistic sample payload
    let payloadData = body.data;
    if (!payloadData || payloadData.length === 0 || body.sample) {
      const sample = getSampleErpPayload(vendor);
      payloadData = sample.data;
    }

    const result = await ingestErpPayload(
      pool,
      vendor,
      "invoices",
      payloadData,
      `ui_manual_sync:${vendor}`,
    );

    return NextResponse.json({ ok: true, result });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
