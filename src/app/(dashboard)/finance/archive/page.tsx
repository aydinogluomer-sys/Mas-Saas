import { getPool } from "@/lib/db";
import { listArchive, type ArchiveEntity } from "@/lib/archive/engine";
import { ArchiveList } from "@/components/archive/archive-list";
import { Panel } from "@/components/ui/panel";
import { KeyStat, PageHeader } from "@/components/ui/shell";
import { requireRouteAccess } from "@/lib/authz/route-guard";
import Link from "@/components/ui/app-link";

export const dynamic = "force-dynamic";

const FINANCE_ENTITIES: { key: ArchiveEntity; label: string }[] = [
  { key: "checks", label: "Çek / Senet" },
  { key: "loans", label: "Krediler" },
  { key: "invoices", label: "Faturalar" },
  { key: "credit_facilities", label: "Kredi Limitleri" },
  { key: "parties", label: "Cariler" },
  { key: "cash_accounts", label: "Banka / Kasa Hesapları" },
];

export default async function FinanceArchive({
  searchParams,
}: {
  searchParams?: Promise<{ entity?: string; q?: string }>;
}) {
  const denied = await requireRouteAccess("/finance/archive");
  if (denied) return denied;
  const sp = searchParams ? await searchParams : {};
  const selectedEntity = FINANCE_ENTITIES.find((e) => e.key === sp.entity)?.key;
  const query = sp.q?.trim() ?? "";
  const pool = getPool();

  const lists = await Promise.all(
    (selectedEntity ? [selectedEntity] : FINANCE_ENTITIES.map((e) => e.key)).map((entity) =>
      listArchive(pool, entity, query),
    ),
  );
  const rows = lists.flat().sort((a, b) => b.archivedAt.localeCompare(a.archivedAt));

  return (
    <>
      <PageHeader
        title="Finansman & Cari Arşivi"
        subtitle="Arşivlenen çek, kredi, fatura, kredi limiti, cari ve banka hesapları; tüm denetim izi ve kaynak bağları korunur."
      />

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <KeyStat label="Toplam Arşiv Kaydı" value={rows.length} tone="neutral" />
        <KeyStat
          label="Fatura & Çek"
          value={rows.filter((r) => r.entityTable === "invoices" || r.entityTable === "checks").length}
          tone="info"
        />
        <KeyStat
          label="Kredi & Limit"
          value={rows.filter((r) => r.entityTable === "loans" || r.entityTable === "credit_facilities").length}
          tone="info"
        />
        <KeyStat
          label="Cari & Banka Hesabı"
          value={rows.filter((r) => r.entityTable === "parties" || r.entityTable === "cash_accounts").length}
          tone="neutral"
        />
      </div>

      <Panel title="FİLTRE & KAYIT LİSTESİ" subtitle={`${rows.length} arşivlenmiş kayıt listeleniyor`}>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap gap-1.5 text-xs">
            <Link
              href="/finance/archive"
              className={`rounded border px-2.5 py-1 ${!selectedEntity ? "border-accent bg-accent/10 font-medium text-accent" : "border-line text-tone-2 hover:bg-elev"}`}
            >
              Tümü
            </Link>
            {FINANCE_ENTITIES.map((item) => (
              <Link
                key={item.key}
                href={`/finance/archive?entity=${item.key}${query ? `&q=${encodeURIComponent(query)}` : ""}`}
                className={`rounded border px-2.5 py-1 ${selectedEntity === item.key ? "border-accent bg-accent/10 font-medium text-accent" : "border-line text-tone-2 hover:bg-elev"}`}
              >
                {item.label}
              </Link>
            ))}
          </div>
          <form method="get" action="/finance/archive" className="flex items-center gap-1.5 text-xs">
            {selectedEntity ? <input type="hidden" name="entity" value={selectedEntity} /> : null}
            <input
              name="q"
              defaultValue={query}
              placeholder="Arşivde ara..."
              className="rounded border border-line bg-surface px-2.5 py-1 text-tone-1"
            />
            <button className="button-ghost px-2.5 py-1">Ara</button>
          </form>
        </div>
        <ArchiveList rows={rows} backTo="/finance/archive" />
      </Panel>
    </>
  );
}
