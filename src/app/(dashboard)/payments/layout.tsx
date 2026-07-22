import type { ReactNode } from "react";
import { ModuleFrame } from "@/components/ui/module-tabs";
const tabs=[{href:"/payments",label:"Özet"},{href:"/payments/calendar",label:"Takvim",aliases:["/calendar"]},{href:"/payments/items",label:"Ödeme kalemleri"},{href:"/payments/missing",label:"Eksik veriler"},{href:"/payments/history",label:"Geçmiş"},{href:"/payments/archive",label:"Arşiv"}];
export default function Layout({children}:{children:ReactNode}){return <ModuleFrame title="Ödemeler" description="Bugünün yükü, yaklaşan vadeler ve düzenli ödeme kalemleri." tabs={tabs}>{children}</ModuleFrame>}
