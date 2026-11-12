import { redirect } from "next/navigation";
import { requireRouteAccess } from "@/lib/authz/route-guard";

export default async function Page() {
  const denied = await requireRouteAccess("/data");
  if (denied) return denied;
  redirect("/data/quality");
}
