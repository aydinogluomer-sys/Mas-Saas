import { getPool } from "@/lib/db";
import { listArchive, type ArchiveEntity } from "@/lib/archive/engine";
import { ArchiveList } from "@/components/archive/archive-list";
import { Panel } from "@/components/ui/panel";
import { PageHeader } from "@/components/ui/shell";
export const dynamic="force-dynamic";
export default async function SystemArchive({searchParams}:{searchParams:Promise<{q?:string;type?:ArchiveEntity}>}){const sp=await searchParams;const rows=await listArchive(getPool(),sp.type,sp.q??"");return <><PageHeader title="Arşiv Merkezi" subtitle="Modüllerde arşivlenen kayıtları ara ve güvenle geri yükle."/><Panel title={`${rows.length} arşiv kaydı`}><form className="mb-4 flex flex-wrap gap-2"><input name="q" defaultValue={sp.q} placeholder="Kayıt ara" className="field-control min-w-52 flex-1 p-2"/><select name="type" defaultValue={sp.type??""} className="field-control p-2"><option value="">Tüm türler</option><option value="payments">Ödemeler</option><option value="checks">Çekler</option><option value="loans">Krediler</option><option value="scenario_runs">Senaryolar</option><option value="external_assumptions">Varsayımlar</option><option value="action_items">Görevler</option></select><button className="button-accent px-3 py-2">Filtrele</button></form><ArchiveList rows={rows} backTo="/system/archive"/></Panel></>}
