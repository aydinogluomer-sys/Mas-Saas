import type { ReactNode } from "react";
import { requireSession } from "@/lib/auth";
import { tabsFor } from "@/lib/authz/matrix"; import { ModuleFrame } from "@/components/ui/module-tabs";
const tabs=[{href:"/system",label:"Durum"},{href:"/system/backup",label:"Yedekleme"},{href:"/system/audit",label:"Denetim kayıtları"},{href:"/system/controls",label:"Kontrol merkezi"},{href:"/system/jobs",label:"Arka plan işleri"},{href:"/system/archive",label:"Arşiv Merkezi"},{href:"/system/security",label:"Erişim ve güvenlik"},{href:"/system/features",label:"Özellik haritası"}];
export default async function Layout({children}:{children:ReactNode}){const session=await requireSession();return <ModuleFrame title="Sistem" description="Uygulama durumu, veri sürekliliği, erişim ve özellik görünürlüğü." tabs={tabsFor(session.role, tabs)}>{children}</ModuleFrame>}
