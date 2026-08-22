import type { ReactNode } from "react"; import { ModuleFrame } from "@/components/ui/module-tabs";
const tabs=[{href:"/cashflow",label:"Özet"},{href:"/cashflow/monthly",label:"Aylık görünüm"},{href:"/cashflow/budget",label:"Bütçe ve tahmin"},{href:"/cashflow/concentration",label:"Yoğunlaşma"},{href:"/cashflow/controls",label:"Veri kontrolleri"}];
export default function Layout({children}:{children:ReactNode}){return <ModuleFrame title="Nakit Akışı" description="Runway, aylık projeksiyon, yoğunlaşma ve borç servisi baskısı." tabs={tabs}>{children}</ModuleFrame>}
