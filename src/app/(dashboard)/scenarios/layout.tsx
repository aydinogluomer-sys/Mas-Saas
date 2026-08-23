import type { ReactNode } from "react";
import { requireSession } from "@/lib/auth";
import { tabsFor } from "@/lib/authz/matrix"; import { ModuleFrame } from "@/components/ui/module-tabs";
const tabs=[{href:"/scenarios",label:"Yeni senaryo"},{href:"/scenarios/compare",label:"Karşılaştırma"},{href:"/scenarios/history",label:"Geçmiş"},{href:"/scenarios/optimization",label:"Optimizasyon adayları"}];
export default async function Layout({children}:{children:ReactNode}){const session=await requireSession();return <ModuleFrame title="Senaryolar" description="Kaynak kayıtları değiştirmeyen what-if analizleri ve finansman seçenekleri." tabs={tabsFor(session.role, tabs)}>{children}</ModuleFrame>}
