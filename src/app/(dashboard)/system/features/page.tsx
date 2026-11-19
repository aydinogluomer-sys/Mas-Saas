import Link from "@/components/ui/app-link";
import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { EmptyState, PageHeader, TableShell } from "@/components/ui/shell";
import { getRequestUser } from "@/lib/auth";
import { can } from "@/lib/authz/matrix";
import { requireRouteAccess } from "@/lib/authz/route-guard";
import { getPool } from "@/lib/db";
import { createBranchAction, createLegalEntityAction } from "@/lib/entities/actions";
import { listBranches, listLegalEntities } from "@/lib/entities/engine";
import { FEATURE_REGISTRY } from "@/lib/feature-registry";

export const dynamic = "force-dynamic";

export default async function FeaturesPage() {
  const denied = await requireRouteAccess("/system/features");
  if (denied) return denied;

  const session = await getRequestUser();
  const pool = getPool();
  const [entities, branches] = await Promise.all([
    listLegalEntities(pool),
    listBranches(pool, null),
  ]);

  const canCreateEntity = session ? can(session.role, "legal_entities", "insert") : false;
  const canCreateBranch = session ? can(session.role, "branches", "insert") : false;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Grup Tüzel Kişilikleri, Şubeler & Faz Özellik Haritası"
        subtitle="Grup içi çoklu şirket (legal_entities) ve tesis/şube (branches) tanımları ile 30+ finansal modülün doğrulama haritası"
        meta={
          <Badge tone="green" dot>
            {entities.length} grup şirketi · {branches.length} şube · {FEATURE_REGISTRY.length} yetenek
          </Badge>
        }
      />

      {/* Karar 1 / M-68: Grup İçi Çoklu Tüzel Kişilik & Şube Yönetimi */}
      <Panel
        title="GRUP TÜZEL KİŞİLİKLERİ (LEGAL_ENTITIES) VE ŞUBE / TESİSLER (BRANCHES)"
        subtitle="Üst bardaki Grup/Konsolide seçicisini ve PostgreSQL RLS (app.current_legal_entity_id) izolasyonunu besleyen holding içi şirket yapısı"
      >
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-3">
            <div className="font-mono text-[11px] font-semibold uppercase tracking-wider text-tone-2">
              Grup Şirketleri ({entities.length})
            </div>
            {entities.length === 0 ? (
              <EmptyState>Henüz tanımlı grup tüzel kişiliği yok.</EmptyState>
            ) : (
              <TableShell>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left font-mono text-[10px] uppercase text-tone-4">
                      <th className="py-1.5 pr-2">Kod</th>
                      <th className="py-1.5 pr-2">Ünvan</th>
                      <th className="py-1.5 pr-2">VKN</th>
                      <th className="py-1.5 pr-2">Döviz</th>
                      <th className="py-1.5">Durum</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entities.map((ent) => (
                      <tr key={ent.id} className="border-t border-line-faint">
                        <td className="py-1.5 pr-2 font-mono font-semibold">{ent.code}</td>
                        <td className="py-1.5 pr-2 font-medium text-[var(--text-1)]">{ent.name}</td>
                        <td className="py-1.5 pr-2 font-mono text-tone-3">{ent.taxIdVkn ?? "—"}</td>
                        <td className="py-1.5 pr-2 font-mono">{ent.baseCurrency}</td>
                        <td className="py-1.5">
                          <Badge tone={ent.isDefault ? "green" : "blue"}>
                            {ent.isDefault ? "Ana Şirket" : "Grup Şirketi"}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableShell>
            )}

            {canCreateEntity ? (
              <form
                action={createLegalEntityAction}
                className="grid grid-cols-2 gap-2 rounded border border-[var(--line)] bg-[var(--surface-2)] p-3 text-xs"
              >
                <input type="hidden" name="returnTo" value="/system/features" />
                <div className="col-span-2 font-medium text-[var(--text-1)]">
                  + Yeni Grup Tüzel Kişiliği Ekle
                </div>
                <input
                  required
                  name="code"
                  placeholder="Kısa Kod (ör. MAS-TR)"
                  className="field-control px-2 py-1.5 font-mono text-xs"
                />
                <input
                  required
                  name="name"
                  placeholder="Resmi Şirket Ünvanı"
                  className="field-control px-2 py-1.5 text-xs"
                />
                <input
                  name="taxIdVkn"
                  placeholder="VKN (10 hane, opsiyonel)"
                  className="field-control px-2 py-1.5 font-mono text-xs"
                />
                <select name="baseCurrency" defaultValue="TRY" className="field-control px-2 py-1.5 text-xs">
                  <option value="TRY">TRY — Türk Lirası</option>
                  <option value="EUR">EUR — Euro</option>
                  <option value="USD">USD — ABD Doları</option>
                </select>
                <button type="submit" className="button-accent col-span-2 px-3 py-1.5 font-medium">
                  Grup Şirketi Oluştur
                </button>
              </form>
            ) : null}
          </div>

          <div className="space-y-3">
            <div className="font-mono text-[11px] font-semibold uppercase tracking-wider text-tone-2">
              Şube ve Üretim Tesisleri ({branches.length})
            </div>
            {branches.length === 0 ? (
              <EmptyState>Henüz tanımlı şube veya üretim tesisi yok.</EmptyState>
            ) : (
              <TableShell>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left font-mono text-[10px] uppercase text-tone-4">
                      <th className="py-1.5 pr-2">Kod</th>
                      <th className="py-1.5 pr-2">Şube / Tesis Adı</th>
                      <th className="py-1.5 pr-2">Şehir</th>
                      <th className="py-1.5">Tür</th>
                    </tr>
                  </thead>
                  <tbody>
                    {branches.map((br) => (
                      <tr key={br.id} className="border-t border-line-faint">
                        <td className="py-1.5 pr-2 font-mono font-semibold">{br.code}</td>
                        <td className="py-1.5 pr-2 font-medium text-[var(--text-1)]">{br.name}</td>
                        <td className="py-1.5 pr-2 text-tone-3">{br.city ?? "—"}</td>
                        <td className="py-1.5">
                          <Badge tone={br.isHeadquarters ? "green" : "neutral"}>
                            {br.isHeadquarters ? "Merkez" : "Şube / Tesis"}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableShell>
            )}

            {canCreateBranch && entities.length > 0 ? (
              <form
                action={createBranchAction}
                className="grid grid-cols-2 gap-2 rounded border border-[var(--line)] bg-[var(--surface-2)] p-3 text-xs"
              >
                <input type="hidden" name="returnTo" value="/system/features" />
                <div className="col-span-2 font-medium text-[var(--text-1)]">
                  + Yeni Şube / Üretim Tesisi Ekle
                </div>
                <select
                  required
                  name="legalEntityId"
                  className="field-control col-span-2 px-2 py-1.5 text-xs"
                >
                  {entities.map((ent) => (
                    <option key={ent.id} value={ent.id}>
                      {ent.code} — {ent.name}
                    </option>
                  ))}
                </select>
                <input
                  required
                  name="code"
                  placeholder="Şube Kodu (ör. FAB-01)"
                  className="field-control px-2 py-1.5 font-mono text-xs"
                />
                <input
                  required
                  name="name"
                  placeholder="Şube / Fabrika Adı"
                  className="field-control px-2 py-1.5 text-xs"
                />
                <input
                  name="city"
                  placeholder="Şehir (ör. Kocaeli)"
                  className="field-control px-2 py-1.5 text-xs"
                />
                <label className="flex items-center gap-1.5 text-xs text-tone-2">
                  <input type="checkbox" name="isHeadquarters" />
                  <span>Genel Merkez</span>
                </label>
                <button type="submit" className="button-accent col-span-2 px-3 py-1.5 font-medium">
                  Şube / Tesis Ekle
                </button>
              </form>
            ) : null}
          </div>
        </div>
      </Panel>

      <Panel title="Özellik kayıtları">
        <p className="mb-3 text-[12px] text-tone-3">
          Bu tablo{" "}
          <strong className="text-tone-2">
            elle tutulan bir envanterdir; canlı test sonucu değildir.
          </strong>{" "}
          &quot;Motor&quot; ve &quot;Arayüz&quot; sütunları koda göre güncellenen beyanlardır. Bir
          özelliğin gerçekten çalıştığını görmek için &quot;Kanıtlayan kapı&quot; sütunundaki komutu
          çalıştırın; birim testler için{" "}
          <code className="font-mono text-[11px] text-tone-2">pnpm test</code>.
        </p>
        <TableShell>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-tone-3">
                <th>No</th>
                <th>Özellik</th>
                <th>Motor</th>
                <th>Arayüz</th>
                <th>Kanıtlayan kapı</th>
                <th>Kanonik rota</th>
              </tr>
            </thead>
            <tbody>
              {FEATURE_REGISTRY.map((f) => (
                <tr key={f.id} className="border-t border-line-faint">
                  <td className="py-2 font-mono text-[11px] text-tone-3">{f.id}</td>
                  <td>{f.title}</td>
                  <td>
                    <Badge tone={f.implemented ? "green" : "amber"}>
                      {f.implemented ? "hazır" : "bekliyor"}
                    </Badge>
                  </td>
                  <td>
                    <Badge tone={f.uiVisible ? "green" : "amber"}>
                      {f.uiVisible ? "görünür" : "gizli"}
                    </Badge>
                  </td>
                  <td>
                    <span className="flex flex-wrap gap-1">
                      {f.verifiedBy.map((gate) => (
                        <code key={gate} className="font-mono text-[10px] text-tone-2">
                          pnpm {gate}
                        </code>
                      ))}
                    </span>
                  </td>
                  <td>
                    <Link className="text-info" href={f.canonicalRoute}>
                      {f.canonicalRoute} →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableShell>
      </Panel>
    </div>
  );
}
