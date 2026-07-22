import { getPool } from "@/lib/db";
import { concentration } from "@/lib/radar/rules";
import { ConcentrationBars } from "@/components/cashflow/charts";
import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { PageHeader } from "@/components/ui/shell";
export const dynamic="force-dynamic";
export default async function CashflowConcentration(){const pool=getPool();const [i,v]=await Promise.all([pool.query(`select coalesce(p.name,cl.label) key,cl.amount::float8 amount from public.cashflow_lines cl left join public.parties p on p.id=cl.party_id where cl.line_type='customer_income'`),pool.query(`select coalesce(p.name,cl.label) key,cl.amount::float8 amount from public.cashflow_lines cl left join public.parties p on p.id=cl.party_id where cl.line_type='vendor_payment'`)]);const income=concentration(i.rows),vendor=concentration(v.rows);return <><PageHeader title="Nakit yoğunlaşması" subtitle="Gelirin müşteri, giderin tedarikçi ve cari taraflar üzerindeki dağılımı." meta={<Badge tone={income.entries.some(e=>e.flagged)||vendor.entries.some(e=>e.flagged)?"amber":"green"} dot>yoğunlaşma kontrolü</Badge>}/><div className="grid grid-cols-1 gap-4 lg:grid-cols-2"><Panel title="MÜŞTERİ GELİR YOĞUNLAŞMASI"><ConcentrationBars entries={income.entries} unknownCount={income.unknownCount}/></Panel><Panel title="TEDARİKÇİ GİDER YOĞUNLAŞMASI"><ConcentrationBars entries={vendor.entries} unknownCount={vendor.unknownCount}/></Panel></div></>}
