import type { ReactNode } from "react"; import { ModuleFrame } from "@/components/ui/module-tabs";
const tabs=[{href:"/production",label:"Özet"},{href:"/production/capacity",label:"Kapasite"},{href:"/production/costs",label:"Maliyet"},{href:"/production/profitability",label:"Parça kârlılığı"},{href:"/production/roi",label:"Makine ve ROI"}];
export default function Layout({children}:{children:ReactNode}){return <ModuleFrame title="Üretim" description="Kapasite, başabaş maliyeti, parça marjı ve makine yatırımı." tabs={tabs}>{children}</ModuleFrame>}
