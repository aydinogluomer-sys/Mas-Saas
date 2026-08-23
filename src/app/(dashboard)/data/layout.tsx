import type { ReactNode } from "react";
import { requireSession } from "@/lib/auth";
import { tabsFor } from "@/lib/authz/matrix"; import { ModuleFrame } from "@/components/ui/module-tabs";
const tabs=[{href:"/data/quality",label:"Veri sağlığı"},{href:"/data/imports",label:"İçe aktarımlar"},{href:"/data/reviews",label:"İnceleme kuyruğu"},{href:"/data/approvals",label:"Onay kuyruğu"},{href:"/data/reconciliation",label:"Mutabakat"},{href:"/data/assumptions",label:"Dış varsayımlar"},{href:"/data/documents",label:"Dokümanlar"},{href:"/data/sources",label:"Kaynak gezgini"}];
export default async function Layout({children}:{children:ReactNode}){const session=await requireSession();return <ModuleFrame title="Veri Merkezi" description="Excel aktarımı, karar güveni, mutabakat ve kaynak kanıtları." tabs={tabsFor(session.role, tabs)}>{children}</ModuleFrame>}
