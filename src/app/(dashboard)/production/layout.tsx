import type { ReactNode } from "react";
import { requireSession } from "@/lib/auth";
import { tabsFor } from "@/lib/authz/matrix"; import { ModuleFrame } from "@/components/ui/module-tabs";
const tabs=[{href:"/production",label:"Özet"},{href:"/production/capacity",label:"Kapasite"},{href:"/production/costs",label:"Maliyet"},{href:"/production/profitability",label:"Parça kârlılığı"},{href:"/production/roi",label:"Makine ve ROI"}];
export default async function Layout({children}:{children:ReactNode}){const session=await requireSession();return <ModuleFrame title="Üretim" description="Kapasite, başabaş maliyeti, parça marjı ve makine yatırımı." tabs={tabsFor(session.role, tabs)}>{children}</ModuleFrame>}
