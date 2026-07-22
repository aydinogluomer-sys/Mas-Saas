import type { ReactNode } from "react"; import { ModuleFrame } from "@/components/ui/module-tabs";
const tabs=[{href:"/scenarios",label:"Yeni senaryo"},{href:"/scenarios/compare",label:"Karşılaştırma"},{href:"/scenarios/history",label:"Geçmiş"},{href:"/scenarios/optimization",label:"Optimizasyon adayları"}];
export default function Layout({children}:{children:ReactNode}){return <ModuleFrame title="Senaryolar" description="Kaynak kayıtları değiştirmeyen what-if analizleri ve finansman seçenekleri." tabs={tabs}>{children}</ModuleFrame>}
