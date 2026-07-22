export interface FeatureState { id:string; title:string; implemented:boolean; uiVisible:boolean; tested:boolean; canonicalRoute:string }
export const FEATURE_REGISTRY:FeatureState[]=[
 {id:"01",title:"Kaynak veri haritası ve Excel ayrıştırma",implemented:true,uiVisible:true,tested:true,canonicalRoute:"/data/imports"},
 {id:"02",title:"Ödeme radarı ve ödeme yönetimi",implemented:true,uiVisible:true,tested:true,canonicalRoute:"/payments"},
 {id:"03",title:"Nakit akışı ve projeksiyon",implemented:true,uiVisible:true,tested:true,canonicalRoute:"/cashflow"},
 {id:"04",title:"Çek, kredi ve vade yönetimi",implemented:true,uiVisible:true,tested:true,canonicalRoute:"/finance"},
 {id:"05",title:"Üretim kapasite ve maliyet",implemented:true,uiVisible:true,tested:true,canonicalRoute:"/production"},
 {id:"06",title:"Makine ROI ve finansman tahsisi",implemented:true,uiVisible:true,tested:true,canonicalRoute:"/production/roi"},
 {id:"07",title:"Raporlar ve hatırlatmalar",implemented:true,uiVisible:true,tested:true,canonicalRoute:"/insights/reports"},
 {id:"08",title:"AI soru-cevap ve rapor yorumu",implemented:true,uiVisible:true,tested:true,canonicalRoute:"/insights/ask"},
 {id:"09",title:"Senaryo motoru",implemented:true,uiVisible:true,tested:true,canonicalRoute:"/scenarios"},
 {id:"10",title:"Senaryo v2 optimizasyon",implemented:true,uiVisible:true,tested:true,canonicalRoute:"/scenarios/optimization"},
 {id:"11",title:"Veri sağlığı ve karar güveni",implemented:true,uiVisible:true,tested:true,canonicalRoute:"/data/quality"},
 {id:"12",title:"İnceleme ve mutabakat",implemented:true,uiVisible:true,tested:true,canonicalRoute:"/data/reviews"},
 {id:"13",title:"Dış varsayımlar",implemented:true,uiVisible:true,tested:true,canonicalRoute:"/data/assumptions"},
 {id:"14",title:"Aksiyon ve görev yönetimi",implemented:true,uiVisible:true,tested:true,canonicalRoute:"/insights/tasks"},
 {id:"15",title:"Kaynak kanıtı ve denetim izi",implemented:true,uiVisible:true,tested:true,canonicalRoute:"/system/audit"},
];
