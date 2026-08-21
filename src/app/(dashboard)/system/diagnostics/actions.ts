"use server";
// Admin-only, and read-only by design: this screen exists to *observe* configuration, so the
// only action it offers is "look again". Nothing here mutates anything — no config toggle, no
// role change, no migration trigger. A diagnostics page that can also change things is how a
// read-only audit surface quietly becomes another attack surface.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";

const PAGE = "/system/diagnostics";

export async function refreshDiagnosticsAction(): Promise<void> {
  await requireAdmin();
  revalidatePath(PAGE);
  redirect(PAGE);
}
