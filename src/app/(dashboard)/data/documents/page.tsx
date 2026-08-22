import { getPool } from "@/lib/db";
import { listDocuments, sweepIntegrity } from "@/lib/documents/engine";
import { documentRoot } from "@/lib/documents/storage";
import { Badge, type Tone } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { EmptyState, KeyStat, PageHeader, TableShell } from "@/components/ui/shell";

export const dynamic = "force-dynamic";

const TYPE_LABEL: Record<string, string> = {
  contract: "Sözleşme", invoice_scan: "Fatura görüntüsü", bank_statement: "Banka ekstresi",
  receipt: "Makbuz", tax_document: "Vergi belgesi", insurance: "Sigorta",
  correspondence: "Yazışma", report: "Rapor", other: "Diğer",
};
const STATUS_TONE: Record<string, Tone> = {
  active: "green", archived: "neutral", superseded: "amber",
};
const kb = (n: number | null) => (n == null ? "—" : `${Math.round(n / 1024)} KB`);

export default async function DocumentsPage() {
  const pool = getPool();
  const [docs, integrity] = await Promise.all([
    listDocuments(pool, 200),
    // Bounded sweep: the point is to surface missing/corrupt files, not to re-hash the archive
    // on every page load.
    sweepIntegrity(pool, 100),
  ]);

  const withoutFile = docs.filter((d) => d.currentVersion == null);
  const broken = integrity.missing.length + integrity.corrupt.length;

  return (
    <>
      <PageHeader
        title="Doküman Merkezi"
        subtitle="Sözleşme, fatura görüntüsü, ekstre ve yazışmalar — sürümlü ve sağlamalı"
        meta={<Badge tone={broken > 0 ? "red" : "green"} dot>
          {broken > 0 ? `${broken} dosya sorunlu` : "bütünlük tamam"}
        </Badge>}
      />

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <KeyStat label="Doküman" value={String(docs.length)} tone="info" sub="kayıtlı" />
        <KeyStat label="Dosyası olmayan" value={String(withoutFile.length)}
          tone={withoutFile.length > 0 ? "warn" : "neutral"} sub="sürüm yüklenmemiş" />
        <KeyStat label="Diskte bulunamayan" value={String(integrity.missing.length)}
          tone={integrity.missing.length > 0 ? "neg" : "pos"} sub={`${integrity.checked} dosya denetlendi`} />
        <KeyStat label="Sağlaması tutmayan" value={String(integrity.corrupt.length)}
          tone={integrity.corrupt.length > 0 ? "neg" : "pos"} sub="bozulma tespiti" />
      </div>

      <Panel title="DEPOLAMA">
        <p className="font-mono text-[11px] leading-relaxed text-tone-2">
          Dosyalar <strong>yerel diskte</strong> tutulur; veritabanı yalnız yolu ve sha256
          sağlamasını taşır — Faz 2&apos;nin <code>source_workbooks.storage_path</code> +{" "}
          <code>file_sha256</code> deseninin aynısı. Kök dizin:{" "}
          <code className="text-tone-1">{documentRoot()}</code>
        </p>
        <p className="mt-2 font-mono text-[10px] leading-relaxed text-tone-4">
          Bunun bedeli açıkça şudur: veritabanı yedeği tek başına geri yükleme için yeterli
          değildir — doküman dizini de yedeklenmelidir. Karşılığında, taranmış her sözleşme
          pg_dump&apos;a girmez; Faz 33 hacimli bir dump&apos;ın yedek doğrulamasını kırdığını
          ölçmüştü. Sağlama NOT NULL olduğu için bir geri yükleme, hangi dosyanın eksik veya bozuk
          olduğunu <strong>kanıtlayabilir</strong>.
        </p>
      </Panel>

      {broken > 0 && (
        <Panel title="BÜTÜNLÜK UYARILARI">
          <TableShell>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left font-mono text-[10px] uppercase text-tone-4">
                  <th className="py-1">Depolama yolu</th><th>Sorun</th>
                </tr>
              </thead>
              <tbody>
                {integrity.missing.map((r) => (
                  <tr key={r.storagePath} className="border-t border-line-faint">
                    <td className="py-1 font-mono text-[10px]">{r.storagePath}</td>
                    <td className="text-neg">Diskte yok</td>
                  </tr>
                ))}
                {integrity.corrupt.map((r) => (
                  <tr key={r.storagePath} className="border-t border-line-faint">
                    <td className="py-1 font-mono text-[10px]">{r.storagePath}</td>
                    <td className="text-neg">
                      {r.sizeMatches === false ? "Boyut uyuşmuyor" : "Sağlama uyuşmuyor"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        </Panel>
      )}

      <Panel title="DOKÜMANLAR" right={<span className="font-mono text-[10px] uppercase text-tone-4">{docs.length} kayıt</span>}>
        {docs.length === 0 ? (
          <EmptyState>Henüz doküman yok.</EmptyState>
        ) : (
          <TableShell>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left font-mono text-[10px] uppercase text-tone-4">
                  <th className="py-1">Başlık</th><th>Tür</th><th>Durum</th>
                  <th className="text-right">Sürüm</th><th className="text-right">Boyut</th>
                  <th>Etiketler</th><th>Yüklendi</th>
                </tr>
              </thead>
              <tbody>
                {docs.map((d) => (
                  <tr key={d.id} className="border-t border-line-faint">
                    <td className="max-w-[22rem] truncate py-1">{d.title}</td>
                    <td className="text-tone-2">{TYPE_LABEL[d.docType] ?? d.docType}</td>
                    <td><Badge tone={STATUS_TONE[d.status] ?? "neutral"}>{d.status}</Badge></td>
                    {/* No file yet renders as a dash, not as "version 0". */}
                    <td className="text-right font-mono">
                      {d.currentVersion == null ? "—" : `v${d.currentVersion} / ${d.versionCount}`}
                    </td>
                    <td className="text-right font-mono text-tone-3">{kb(d.byteSize)}</td>
                    <td className="text-tone-3">{d.tags.length ? d.tags.join(", ") : "—"}</td>
                    <td className="font-mono text-tone-3">{d.uploadedAt ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        )}
      </Panel>
    </>
  );
}
