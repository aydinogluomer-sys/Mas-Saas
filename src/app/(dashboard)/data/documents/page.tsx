import { getRequestUser } from "@/lib/auth";
import { can } from "@/lib/authz/matrix";
import { requireRouteAccess } from "@/lib/authz/route-guard";
import { Badge, type Tone } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { EmptyState, KeyStat, PageHeader, TableShell } from "@/components/ui/shell";
import { getPool } from "@/lib/db";
import {
  DOC_TYPES,
  LINK_KINDS,
  listDocuments,
  listRecentDocumentLinks,
  sweepIntegrity,
} from "@/lib/documents/engine";
import { documentRoot } from "@/lib/documents/storage";
import { attachToEntityAction, uploadDocumentAction } from "./actions";

export const dynamic = "force-dynamic";

const TYPE_LABEL: Record<string, string> = {
  contract: "Sözleşme",
  invoice_scan: "Fatura görüntüsü",
  bank_statement: "Banka ekstresi",
  receipt: "Makbuz / Dekont",
  tax_document: "Vergi belgesi",
  insurance: "Sigorta",
  correspondence: "Yazışma",
  report: "Rapor",
  other: "Diğer",
};

const LINK_KIND_TR: Record<string, string> = {
  supporting: "Destekleyici belge",
  contract: "Sözleşme",
  proof_of_payment: "Ödeme dekontu",
  correspondence: "Yazışma",
  other: "Diğer",
};

const STATUS_TONE: Record<string, Tone> = {
  active: "green",
  archived: "neutral",
  superseded: "amber",
};

const kb = (n: number | null) => (n == null ? "—" : `${Math.max(1, Math.round(n / 1024))} KB`);

export default async function DocumentsPage({
  searchParams,
}: {
  searchParams?: Promise<{ error?: string; result?: string }>;
}) {
  const denied = await requireRouteAccess("/data/documents");
  if (denied) return denied;
  const sp = (await searchParams) ?? {};
  const session = await getRequestUser();
  const canUpload = session
    ? can(session.role, "documents", "insert") && can(session.role, "attachments", "insert")
    : false;

  const pool = getPool();
  const [docs, links, integrity, invoices, payments, checks, bordros, facilities] = await Promise.all([
    listDocuments(pool, 200),
    listRecentDocumentLinks(pool, 40),
    sweepIntegrity(pool, 100),
    pool.query(`select id, invoice_no from public.invoices where status <> 'cancelled' order by created_at desc limit 50`),
    pool.query(`select id, name from public.payments where archived_at is null order by created_at desc limit 50`),
    pool.query(`select id, coalesce(serial_no, counterparty_label, 'Çek') as label from public.checks where archived_at is null order by created_at desc limit 50`),
    pool.query(`select id, bordro_no from public.check_bordros order by created_at desc limit 50`).catch(() => ({ rows: [] })),
    pool.query(`select id, name from public.credit_facilities order by created_at desc limit 30`).catch(() => ({ rows: [] })),
  ]);

  const entityChoices = [
    ...invoices.rows.map((r) => ({
      value: `invoices:${r.id as string}:Fatura ${r.invoice_no as string}`,
      label: `Fatura · ${r.invoice_no as string}`,
    })),
    ...payments.rows.map((r) => ({
      value: `payments:${r.id as string}:Ödeme ${r.name as string}`,
      label: `Ödeme · ${r.name as string}`,
    })),
    ...checks.rows.map((r) => ({
      value: `checks:${r.id as string}:Çek ${r.label as string}`,
      label: `Çek/Senet · ${r.label as string}`,
    })),
    ...bordros.rows.map((r) => ({
      value: `check_bordros:${r.id as string}:Bordro ${r.bordro_no as string}`,
      label: `Çek Bordrosu · ${r.bordro_no as string}`,
    })),
    ...facilities.rows.map((r) => ({
      value: `credit_facilities:${r.id as string}:Limit ${r.name as string}`,
      label: `Kredi Limiti · ${r.name as string}`,
    })),
  ];

  const withoutFile = docs.filter((d) => d.currentVersion == null);
  const broken = integrity.missing.length + integrity.corrupt.length;

  return (
    <>
      <PageHeader
        title="Doküman Merkezi"
        subtitle="Sözleşme, fatura görüntüsü, dekont ve bordro ekleri — içerik adresli SHA-256 kasası"
        meta={
          <Badge tone={broken > 0 ? "red" : "green"} dot>
            {broken > 0 ? `${broken} dosya sorunlu` : "bütünlük tamam"}
          </Badge>
        }
      />

      {sp.error ? (
        <div className="rounded border border-red-800 bg-red-950/60 px-3 py-2 text-xs text-red-200">{sp.error}</div>
      ) : null}
      {sp.result ? (
        <div className="rounded border border-emerald-800 bg-emerald-950/50 px-3 py-2 text-xs text-emerald-200">
          İşlem tamamlandı: {sp.result}
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <KeyStat label="Doküman" value={String(docs.length)} tone="info" sub="kayıtlı" />
        <KeyStat
          label="Dosyası olmayan"
          value={String(withoutFile.length)}
          tone={withoutFile.length > 0 ? "warn" : "neutral"}
          sub="sürüm yüklenmemiş"
        />
        <KeyStat
          label="Diskte bulunamayan"
          value={String(integrity.missing.length)}
          tone={integrity.missing.length > 0 ? "neg" : "pos"}
          sub={`${integrity.checked} dosya denetlendi`}
        />
        <KeyStat
          label="Sağlaması tutmayan"
          value={String(integrity.corrupt.length)}
          tone={integrity.corrupt.length > 0 ? "neg" : "pos"}
          sub="bozulma tespiti"
        />
      </div>

      {canUpload ? (
        <Panel
          title="DOKÜMAN YÜKLE VE FİNANSAL KAYDA BAĞLA"
          subtitle="yalnız PDF, PNG, JPEG ve XLSX (maks. 25 MB) — ham dosya adı diske yazılmaz, SHA-256 ile adreslenir"
        >
          <div className="grid gap-3 lg:grid-cols-2">
            <form action={uploadDocumentAction} className="grid grid-cols-2 gap-2 rounded border border-neutral-800 bg-neutral-950/50 p-3 text-xs">
              <div className="col-span-2 font-medium text-neutral-200">Yeni Doküman veya Yeni Sürüm Yükle</div>
              <select
                name="existingDocumentId"
                className="col-span-2 rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5"
              >
                <option value="">— Yeni doküman oluştur —</option>
                {docs.map((d) => (
                  <option key={d.id} value={d.id}>
                    Yeni sürüm ekle: {d.title} {d.currentVersion ? `(v${d.currentVersion})` : "(dosyasız)"}
                  </option>
                ))}
              </select>
              <input
                name="title"
                placeholder="Doküman başlığı (boşsa dosya adı kullanılır)"
                className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5"
              />
              <select name="docType" className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5">
                {DOC_TYPES.map((t) => (
                  <option key={t} value={t}>{TYPE_LABEL[t] ?? t}</option>
                ))}
              </select>
              <input
                name="file"
                type="file"
                required
                accept=".pdf,.png,.jpg,.jpeg,.xlsx,application/pdf,image/png,image/jpeg,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                className="col-span-2 rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5"
              />
              <select name="entityRef" className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5">
                <option value="">Finansal kayda bağla (opsiyonel)</option>
                {entityChoices.map((c) => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </select>
              <select name="linkKind" className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5">
                {LINK_KINDS.map((k) => (
                  <option key={k} value={k}>{LINK_KIND_TR[k] ?? k}</option>
                ))}
              </select>
              <input
                name="tags"
                placeholder="Etiketler (virgülle: kira, 2026)"
                className="col-span-2 rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5"
              />
              <button className="col-span-2 rounded bg-sky-700 px-3 py-1.5 font-medium text-white">
                Kasaya yükle ve doğrula
              </button>
            </form>

            {docs.length > 0 && entityChoices.length > 0 ? (
              <form action={attachToEntityAction} className="grid grid-cols-2 gap-2 rounded border border-neutral-800 bg-neutral-950/50 p-3 text-xs">
                <div className="col-span-2 font-medium text-neutral-200">Mevcut Dokümanı Fatura / Ödeme / Çek / Bordroya Bağla</div>
                <select
                  name="documentId"
                  required
                  className="col-span-2 rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5"
                >
                  {docs.map((d) => (
                    <option key={d.id} value={d.id}>{d.title}</option>
                  ))}
                </select>
                <select
                  name="entityRef"
                  required
                  className="col-span-2 rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5"
                >
                  {entityChoices.map((c) => (
                    <option key={c.value} value={c.value}>{c.label}</option>
                  ))}
                </select>
                <select name="linkKind" className="col-span-2 rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5">
                  {LINK_KINDS.map((k) => (
                    <option key={k} value={k}>{LINK_KIND_TR[k] ?? k}</option>
                  ))}
                </select>
                <button className="col-span-2 rounded bg-emerald-700 px-3 py-1.5 font-medium text-white">
                  Kayda ekle (attachToEntity)
                </button>
              </form>
            ) : null}
          </div>
        </Panel>
      ) : null}

      <Panel title="DEPOLAMA">
        <p className="font-mono text-[11px] leading-relaxed text-tone-2">
          Dosyalar <strong>yerel diskte</strong> tutulur; veritabanı yalnız yolu ve sha256
          sağlamasını taşır. Kök dizin: <code className="text-tone-1">{documentRoot()}</code>
        </p>
      </Panel>

      {broken > 0 ? (
        <Panel title="BÜTÜNLÜK UYARILARI">
          <TableShell>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left font-mono text-[10px] uppercase text-tone-4">
                  <th className="py-1">Depolama yolu</th>
                  <th>Sorun</th>
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
      ) : null}

      <Panel title="DOKÜMANLAR" right={<span className="font-mono text-[10px] uppercase text-tone-4">{docs.length} kayıt</span>}>
        {docs.length === 0 ? (
          <EmptyState>Henüz doküman yok.</EmptyState>
        ) : (
          <TableShell>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left font-mono text-[10px] uppercase text-tone-4">
                  <th className="py-1">Başlık</th>
                  <th>Tür</th>
                  <th>Durum</th>
                  <th className="text-right">Sürüm</th>
                  <th className="text-right">Boyut</th>
                  <th>SHA-256</th>
                  <th>Yüklendi</th>
                  <th className="text-right">İndir</th>
                </tr>
              </thead>
              <tbody>
                {docs.map((d) => (
                  <tr key={d.id} className="border-t border-line-faint">
                    <td className="max-w-[20rem] truncate py-1.5">
                      {d.title}
                      {d.originalFilename ? (
                        <span className="block font-mono text-[10px] text-neutral-500">{d.originalFilename}</span>
                      ) : null}
                    </td>
                    <td className="text-tone-2">{TYPE_LABEL[d.docType] ?? d.docType}</td>
                    <td>
                      <Badge tone={STATUS_TONE[d.status] ?? "neutral"}>{d.status}</Badge>
                    </td>
                    <td className="text-right font-mono">
                      {d.currentVersion == null ? "—" : `v${d.currentVersion} / ${d.versionCount}`}
                    </td>
                    <td className="text-right font-mono text-tone-3">{kb(d.byteSize)}</td>
                    <td className="font-mono text-[10px] text-tone-4">
                      {d.fileSha256 ? `${d.fileSha256.slice(0, 12)}…` : "—"}
                    </td>
                    <td className="font-mono text-tone-3">{d.uploadedAt ?? "—"}</td>
                    <td className="text-right">
                      {d.currentVersion != null ? (
                        <a
                          href={`/api/documents/${d.id}/download`}
                          className="rounded bg-neutral-800 px-2 py-0.5 text-[11px] text-neutral-200 hover:bg-neutral-700"
                        >
                          İndir
                        </a>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        )}
      </Panel>

      {links.length > 0 ? (
        <Panel title="KAYIT BAĞLANTILARI" subtitle="fatura, ödeme, çek ve bordrolara iliştirilen belgeler">
          <TableShell>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left font-mono text-[10px] uppercase text-tone-4">
                  <th className="py-1">Doküman</th>
                  <th>Hedef Tablo</th>
                  <th>Kayıt</th>
                  <th>Bağlantı Türü</th>
                  <th>Tarih</th>
                </tr>
              </thead>
              <tbody>
                {links.map((l) => (
                  <tr key={l.id} className="border-t border-line-faint">
                    <td className="py-1">{l.documentTitle}</td>
                    <td className="font-mono text-[10px]">{l.entityTable}</td>
                    <td>{l.entityLabel ?? l.entityId.slice(0, 8)}</td>
                    <td>{LINK_KIND_TR[l.linkKind] ?? l.linkKind}</td>
                    <td className="font-mono text-tone-4">{l.createdAt}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        </Panel>
      ) : null}
    </>
  );
}
