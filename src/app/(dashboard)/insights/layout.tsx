import type { ReactNode } from "react";
import { requireSession } from "@/lib/auth";
import { tabsFor } from "@/lib/authz/matrix"; import { ModuleFrame } from "@/components/ui/module-tabs";
const tabs=[{href:"/insights/ask",label:"Soru-Cevap"},{href:"/insights/briefing",label:"CFO brifingi"},{href:"/insights/analysis",label:"Analiz merkezi"},{href:"/insights/reports",label:"Raporlar"},{href:"/insights/reminders",label:"Hatırlatmalar"},{href:"/insights/tasks",label:"Görevler"}];
export default async function Layout({children}:{children:ReactNode}){const session=await requireSession();return <ModuleFrame title="İçgörüler" description="Kanıta dayalı cevaplar, raporlar, hatırlatmalar ve takip edilecek işler." tabs={tabsFor(session.role, tabs)}>{children}</ModuleFrame>}
