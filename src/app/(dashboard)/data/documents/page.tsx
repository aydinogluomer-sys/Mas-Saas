import { StackedRibbonSvg } from "@/components/charts/folio-visuals";
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
import { moneyOrNull } from "@/lib/money";
import { formatMoney } from "@/lib/money-format";
import {
  attachToEntityAction,
  createDraftPaymentFromDocumentAction,
  extractDocumentMetadataAction,
  uploadDocumentAction,
} from "./actions";

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

interface NormalizedDocExtraction {
  vknOrTckn: string | null;
  iban: string | null;
  documentNumber: string | null;
  detectedDateIso: string | null;
  detectedAmount: number | null;
  currency: string | null;
  supplierName: string | null;
  confidence: "high" | "medium" | "low" | null;
  confidencePct: number | null;
}

function readNormalizedExtraction(
  meta: Record<string, unknown> | null,
): NormalizedDocExtraction {
  if (!meta) {
    return {
      vknOrTckn: null,
      iban: null,
      documentNumber: null,
      detectedDateIso: null,
      detectedAmount: null,
      currency: null,
      supplierName: null,
      confidence: null,
      confidencePct: null,
    };
  }
  const smart =
    meta.smartExtraction && typeof meta.smartExtraction === "object"
      ? (meta.smartExtraction as Record<string, unknown>)
      : {};

  const strOrNull = (...candidates: unknown[]): string | null => {
    for (const c of candidates) {
      if (typeof c === "string" && c.trim().length > 0) return c.trim();
    }
    return null;
  };

  const rawAmt = meta.detectedAmount ?? smart.detectedAmount ?? meta.payableAmount ?? null;
  const detectedAmount =
    rawAmt !== null && rawAmt !== undefined && rawAmt !== ""
      ? moneyOrNull(String(rawAmt).replace(",", "."))
      : null;

  const rawConf = strOrNull(meta.confidence, smart.confidence);
  const confidence: "high" | "medium" | "low" | null =
    rawConf === "high" || rawConf === "medium" || rawConf === "low" ? rawConf : null;
  const confidencePct =
    confidence === "high" ? 95 : confidence === "medium" ? 70 : confidence === "low" ? 35 : null;

  return {
    vknOrTckn: strOrNull(meta.vknOrTckn, smart.vknOrTckn),
    iban: strOrNull(meta.iban, smart.iban),
    documentNumber: strOrNull(meta.documentNumber, smart.documentNumber, meta.invoiceNo),
    detectedDateIso: strOrNull(meta.detectedDateIso, smart.detectedDateIso, meta.issueDate),
    detectedAmount,
    currency: strOrNull(meta.currency, smart.currency),
    supplierName: strOrNull(meta.supplierName, smart.supplierName),
    confidence,
    confidencePct,
  };
}

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
  const canExtract = session ? can(session.role, "documents", "update") : false;
  const canCreatePayment = session ? can(session.role, "payments", "insert") : false;

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

  const docExtractions = new Map(
    docs.map((d) => [d.id, readNormalizedExtraction(d.extractedMetadata)]),
  );

  let highConfCount = 0;
  let mediumConfCount = 0;
  let lowConfCount = 0;
  let unextractedWithFileCount = 0;
  for (const d of docs) {
    if (d.currentVersion == null) continue;
    const ex = docExtractions.get(d.id);
    if (ex?.confidence === "high") highConfCount += 1;
    else if (ex?.confidence === "medium") mediumConfCount += 1;
    else if (ex?.confidence === "low") lowConfCount += 1;
    else unextractedWithFileCount += 1;
  }

  const extractionRibbonSegments = [
    {
      key: "high_conf",
      label: "Yüksek Güvenli Çıkarım (%95)",
      value: highConfCount,
      formattedValue: `${highConfCount}`,
      tone: "pos" as const,
    },
    {
      key: "med_conf",
      label: "Orta Güvenli Çıkarım (%70)",
      value: mediumConfCount,
      formattedValue: `${mediumConfCount}`,
      tone: "info" as const,
    },
    {
      key: "low_conf",
      label: "Düşük Güven / Görüntü (%35)",
      value: lowConfCount,
      formattedValue: `${lowConfCount}`,
      tone: "warn" as const,
    },
    {
      key: "pending_extract",
      label: "Alan Çıkarımı Bekleyen",
      value: unextractedWithFileCount,
      formattedValue: `${unextractedWithFileCount}`,
      tone: "accent" as const,
    },
    {
      key: "without_file",
      label: "Dosyasız Taslak",
      value: withoutFile.length,
      formattedValue: `${withoutFile.length}`,
      tone: "neutral" as const,
    },
  ];

  return (
    <>
      <PageHeader
        title="Doküman Merkezi & Akıllı Alan Çıkarımı (OCR / UBL-TR)"
        subtitle="Sözleşme, e-Fatura XML, PDF dekont ve çek eklerinden deterministik VKN/TCKN, IBAN, Tutar, Tarih çıkarımı ve SHA-256 içerik adresli kasa"
        meta={
          <Badge tone={broken > 0 ? "red" : "green"} dot>
            {broken > 0 ? `${broken} dosya sorunlu` : "bütünlük tamam"}
          </Badge>
        }
      />

      {sp.error ? (
        <div className="rounded border border-neg/40 bg-neg/10 px-3 py-2 text-xs text-neg">{sp.error}</div>
      ) : null}
      {sp.result ? (
        <div className="rounded border border-pos/40 bg-pos/10 px-3 py-2 text-xs text-pos">
          İşlem tamamlandı: {sp.result}
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <KeyStat label="Doküman" value={String(docs.length)} tone="info" sub="kayıtlı" />
        <KeyStat
          label="Akıllı Çıkarımlı"
          value={String(highConfCount + mediumConfCount)}
          tone={highConfCount + mediumConfCount > 0 ? "pos" : "neutral"}
          sub={`${highConfCount} yüksek · ${mediumConfCount} orta güven`}
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

      <div className="folio-corner-mark rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-1)] p-3.5 shadow-[var(--shadow-xs)]">
        <StackedRibbonSvg
          title="Belge Türü ve Akıllı Alan Çıkarım Durum Dağılımı"
          segments={extractionRibbonSegments}
          emptyLabel="Henüz kasaya yüklenmiş doküman bulunmuyor."
        />
      </div>

      {canUpload ? (
        <Panel
          title="DOKÜMAN YÜKLE VE FİNANSAL KAYDA BAĞLA"
          subtitle="PDF, PNG, JPEG, XLSX, UBL-TR XML ve CSV (maks. 25 MB) — ham dosya adı diske yazılmaz, SHA-256 ile adreslenir ve metaverisi otomatik çıkarılır"
        >
          <div className="grid gap-3 lg:grid-cols-2">
            <form
              action={uploadDocumentAction}
              className="grid grid-cols-2 gap-2 rounded border border-[var(--line)] bg-[var(--surface-2)] p-3 text-xs text-[var(--text-1)]"
            >
              <div className="col-span-2 font-medium text-[var(--text-1)]">
                Yeni Doküman veya Yeni Sürüm Yükle
              </div>
              <select
                name="existingDocumentId"
                className="col-span-2 rounded border border-[var(--line)] bg-[var(--surface-1)] px-2 py-1.5 text-[var(--text-1)]"
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
                className="rounded border border-[var(--line)] bg-[var(--surface-1)] px-2 py-1.5 text-[var(--text-1)]"
              />
              <select
                name="docType"
                className="rounded border border-[var(--line)] bg-[var(--surface-1)] px-2 py-1.5 text-[var(--text-1)]"
              >
                {DOC_TYPES.map((t) => (
                  <option key={t} value={t}>{TYPE_LABEL[t] ?? t}</option>
                ))}
              </select>
              <input
                name="file"
                type="file"
                required
                accept=".pdf,.png,.jpg,.jpeg,.xlsx,.xml,.csv,application/pdf,image/png,image/jpeg,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/xml,text/xml,text/csv"
                className="col-span-2 rounded border border-[var(--line)] bg-[var(--surface-1)] px-2 py-1.5 text-[var(--text-1)]"
              />
              <select
                name="entityRef"
                className="rounded border border-[var(--line)] bg-[var(--surface-1)] px-2 py-1.5 text-[var(--text-1)]"
              >
                <option value="">Finansal kayda bağla (opsiyonel)</option>
                {entityChoices.map((c) => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </select>
              <select
                name="linkKind"
                className="rounded border border-[var(--line)] bg-[var(--surface-1)] px-2 py-1.5 text-[var(--text-1)]"
              >
                {LINK_KINDS.map((k) => (
                  <option key={k} value={k}>{LINK_KIND_TR[k] ?? k}</option>
                ))}
              </select>
              <input
                name="tags"
                placeholder="Etiketler (virgülle: kira, 2026)"
                className="col-span-2 rounded border border-[var(--line)] bg-[var(--surface-1)] px-2 py-1.5 text-[var(--text-1)]"
              />
              <button className="button-accent col-span-2 rounded px-3 py-1.5 font-medium">
                Kasaya yükle ve doğrula
              </button>
            </form>

            {docs.length > 0 && entityChoices.length > 0 ? (
              <form
                action={attachToEntityAction}
                className="grid grid-cols-2 gap-2 rounded border border-[var(--line)] bg-[var(--surface-2)] p-3 text-xs text-[var(--text-1)]"
              >
                <div className="col-span-2 font-medium text-[var(--text-1)]">
                  Mevcut Dokümanı Fatura / Ödeme / Çek / Bordroya Bağla
                </div>
                <select
                  name="documentId"
                  required
                  className="col-span-2 rounded border border-[var(--line)] bg-[var(--surface-1)] px-2 py-1.5 text-[var(--text-1)]"
                >
                  {docs.map((d) => (
                    <option key={d.id} value={d.id}>{d.title}</option>
                  ))}
                </select>
                <select
                  name="entityRef"
                  required
                  className="col-span-2 rounded border border-[var(--line)] bg-[var(--surface-1)] px-2 py-1.5 text-[var(--text-1)]"
                >
                  {entityChoices.map((c) => (
                    <option key={c.value} value={c.value}>{c.label}</option>
                  ))}
                </select>
                <select
                  name="linkKind"
                  className="col-span-2 rounded border border-[var(--line)] bg-[var(--surface-1)] px-2 py-1.5 text-[var(--text-1)]"
                >
                  {LINK_KINDS.map((k) => (
                    <option key={k} value={k}>{LINK_KIND_TR[k] ?? k}</option>
                  ))}
                </select>
                <button className="button-accent col-span-2 rounded px-3 py-1.5 font-medium">
                  Kayda ekle (attachToEntity)
                </button>
              </form>
            ) : null}
          </div>
        </Panel>
      ) : null}

      <Panel title="DEPOLAMA KATMANI (CAS / S3-WORM UYUMLU)">
        <p className="font-mono text-[11px] leading-relaxed text-tone-2">
          Dosyalar içerik adresli kasada (<strong>local_cas</strong> veya <code>MAS_S3_WORM_BUCKET</code> ile{" "}
          <strong>s3_worm</strong>) tutulur; veritabanı yalnız yolu, <code>extracted_metadata</code> özetini ve SHA-256
          sağlamasını taşır. Aktif kök dizin: <code className="text-tone-1">{documentRoot()}</code>
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
                  <th className="py-1.5 pr-2">Başlık &amp; Akıllı Alan Çıkarımı (OCR / UBL)</th>
                  <th className="py-1.5 pr-2">Tür</th>
                  <th className="py-1.5 pr-2">Kasa</th>
                  <th className="py-1.5 pr-2">Durum</th>
                  <th className="py-1.5 pr-2 text-right">Sürüm</th>
                  <th className="py-1.5 pr-2 text-right">Boyut</th>
                  <th className="py-1.5 pr-2">SHA-256</th>
                  <th className="py-1.5 pr-2">Yüklendi</th>
                  <th className="py-1.5 text-right">İşlemler &amp; İndir</th>
                </tr>
              </thead>
              <tbody>
                {docs.map((d) => {
                  const ex = docExtractions.get(d.id) ?? readNormalizedExtraction(d.extractedMetadata);
                  const canDraftPayment =
                    canCreatePayment &&
                    (Boolean(ex.detectedDateIso) ||
                      (ex.detectedAmount !== null && ex.detectedAmount > 0));
                  const hasAnyExtractedBadge = Boolean(
                    ex.confidencePct !== null ||
                      ex.vknOrTckn ||
                      ex.iban ||
                      ex.documentNumber ||
                      ex.detectedDateIso ||
                      ex.detectedAmount !== null ||
                      ex.supplierName,
                  );

                  return (
                    <tr key={d.id} className="border-t border-line-faint align-top">
                      <td className="max-w-[28rem] py-2 pr-2">
                        <span className="font-medium text-[var(--text-1)]">{d.title}</span>
                        {d.originalFilename ? (
                          <span className="block truncate font-mono text-[10px] text-tone-3">
                            {d.originalFilename}
                          </span>
                        ) : null}
                        {hasAnyExtractedBadge ? (
                          <div className="mt-1.5 flex flex-wrap items-center gap-1">
                            {ex.confidencePct !== null ? (
                              <Badge
                                tone={
                                  ex.confidence === "high"
                                    ? "green"
                                    : ex.confidence === "medium"
                                      ? "blue"
                                      : "amber"
                                }
                              >
                                Güven %{ex.confidencePct}
                              </Badge>
                            ) : null}
                            {ex.supplierName ? (
                              <Badge tone="neutral">Karşı Taraf: {ex.supplierName}</Badge>
                            ) : null}
                            {ex.vknOrTckn ? (
                              <Badge tone="neutral">
                                <span className="font-mono tabular-nums">VKN: {ex.vknOrTckn}</span>
                              </Badge>
                            ) : null}
                            {ex.documentNumber ? (
                              <Badge tone="neutral">
                                <span className="font-mono">Belge: {ex.documentNumber}</span>
                              </Badge>
                            ) : null}
                            {ex.detectedDateIso ? (
                              <Badge tone="neutral">
                                <span className="font-mono tabular-nums">
                                  Tarih: {ex.detectedDateIso}
                                </span>
                              </Badge>
                            ) : null}
                            {ex.detectedAmount !== null ? (
                              <Badge tone="green">
                                <span className="font-mono tabular-nums">
                                  {formatMoney(ex.detectedAmount, ex.currency ?? "TRY")}
                                </span>
                              </Badge>
                            ) : (
                              <Badge tone="amber">Tutar Yok (BLANK ≠ ZERO)</Badge>
                            )}
                            {ex.iban ? (
                              <Badge tone="blue">
                                <span className="font-mono text-[10px]">
                                  IBAN: {ex.iban.slice(0, 8)}…{ex.iban.slice(-4)}
                                </span>
                              </Badge>
                            ) : null}
                          </div>
                        ) : null}
                      </td>
                      <td className="py-2 pr-2 text-tone-2">{TYPE_LABEL[d.docType] ?? d.docType}</td>
                      <td className="py-2 pr-2 font-mono text-[10px] text-tone-3">{d.storageBackend}</td>
                      <td className="py-2 pr-2">
                        <Badge tone={STATUS_TONE[d.status] ?? "neutral"}>{d.status}</Badge>
                      </td>
                      <td className="py-2 pr-2 text-right font-mono tabular-nums">
                        {d.currentVersion == null ? "—" : `v${d.currentVersion} / ${d.versionCount}`}
                      </td>
                      <td className="py-2 pr-2 text-right font-mono tabular-nums text-tone-3">
                        {kb(d.byteSize)}
                      </td>
                      <td className="py-2 pr-2 font-mono text-[10px] text-tone-4">
                        {d.fileSha256 ? `${d.fileSha256.slice(0, 12)}…` : "—"}
                      </td>
                      <td className="py-2 pr-2 font-mono tabular-nums text-tone-3">
                        {d.uploadedAt ?? "—"}
                      </td>
                      <td className="py-2 text-right">
                        <div className="flex flex-wrap items-center justify-end gap-1.5">
                          {d.currentVersion != null && canExtract ? (
                            <form action={extractDocumentMetadataAction}>
                              <input type="hidden" name="documentId" value={d.id} />
                              <button
                                type="submit"
                                className="button-ghost px-2 py-0.5 text-[11px]"
                              >
                                Akıllı Alan Çıkarımı (OCR/XML)
                              </button>
                            </form>
                          ) : null}
                          {canDraftPayment ? (
                            <form action={createDraftPaymentFromDocumentAction}>
                              <input type="hidden" name="documentId" value={d.id} />
                              <button
                                type="submit"
                                className="button-accent px-2 py-0.5 text-[11px] font-medium"
                              >
                                Çıkarılan Veriyle Taslak Ödeme Oluştur
                              </button>
                            </form>
                          ) : null}
                          {d.currentVersion != null ? (
                            <a
                              href={`/api/documents/${d.id}/download`}
                              download
                              data-no-nav-skeleton="true"
                              className="button-ghost px-2 py-0.5 text-[11px]"
                            >
                              İndir
                            </a>
                          ) : (
                            <span className="text-tone-4">—</span>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
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
