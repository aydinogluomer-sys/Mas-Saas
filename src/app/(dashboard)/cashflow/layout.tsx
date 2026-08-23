import type { ReactNode } from "react";
import { requireSession } from "@/lib/auth";
import { tabsFor } from "@/lib/authz/matrix"; import { ModuleFrame } from "@/components/ui/module-tabs";
const tabs=[{href:"/cashflow",label:"Özet"},{href:"/cashflow/monthly",label:"Aylık görünüm"},{href:"/cashflow/budget",label:"Bütçe ve tahmin"},{href:"/cashflow/concentration",label:"Yoğunlaşma"},{href:"/cashflow/controls",label:"Veri kontrolleri"}];
export default async function Layout({children}:{children:ReactNode}){const session=await requireSession();return <ModuleFrame title="Nakit Akışı" description="Runway, aylık projeksiyon, yoğunlaşma ve borç servisi baskısı." tabs={tabsFor(session.role, tabs)}>{children}</ModuleFrame>}
