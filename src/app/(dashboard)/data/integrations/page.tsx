import { StackedRibbonSvg } from "@/components/charts/folio-visuals";
import { getRequestUser } from "@/lib/auth";
import { can } from "@/lib/authz/matrix";
import { requireRouteAccess } from "@/lib/authz/route-guard";
import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { EmptyState, KeyStat, PageHeader, TableShell } from "@/components/ui/shell";
import { getPool } from "@/lib/db";
import { decimal, money, moneyOrNull } from "@/lib/money";
import { formatMoney } from "@/lib/money-format";
import { listConnections } from "@/lib/integrations/engine";
import {
  createIntegrationConnectionAction,
  importHybridBankStatementAction,
  importPosSettlementBatchAction,
  importUblTrInvoiceAction,
  resolveStagedPartyAction,
  runClosedLoopSyncAction,
  saveAccountMappingAction,
  toggleIntegrationStatusAction,
  triggerIntegrationSyncAction,
} from "./actions";

export const dynamic = "force-dynamic";

export default async function DataIntegrationsPage({
  searchParams,
}: {
  searchParams?: Promise<{ error?: string; result?: string }>;
}) {
  const denied = await requireRouteAccess("/data/integrations");
  if (denied) return denied;
  const session = await getRequestUser();
  const sp = (await searchParams) ?? {};
  const pool = getPool();

  const canManageConnections = session ? can(session.role, "integration_connections", "insert") : false;
  const canTriggerSync = session ? can(session.role, "background_jobs", "insert") : false;
  const canMapAccounts = session ? can(session.role, "integration_account_mappings", "insert") : false;
  const canResolveParties = session ? can(session.role, "integration_staged_parties", "update") : false;
  const canCreateParties = session ? can(session.role, "parties", "insert") : false;
  const canImportBank = session ? can(session.role, "bank_transactions", "insert") : false;
  const canImportInvoices = session ? can(session.role, "invoices", "insert") : false;
  const canImportPos = session ? can(session.role, "pos_settlement_batches", "insert") : false;

  const [
    connections,
    syncRunsRes,
    rawCountRes,
    mappingsRes,
    stagedPartiesRes,
    bankAccountsRes,
    partiesRes,
    productsCountRes,
    productsRes,
    posBatchesRes,
  ] = await Promise.all([
    listConnections(pool),
    pool
      .query<{
        id: string;
        integration_name: string;
        started_at: string;
        finished_at: string | null;
        watermark_from: string | null;
        watermark_to: string | null;
        status: string;
        fetched_count: number;
        upserted_count: number;
        staged_party_count: number;
        error_summary: string | null;
      }>(
        `select r.id::text,
                c.name as integration_name,
                to_char(r.started_at, 'YYYY-MM-DD HH24:MI:SS') as started_at,
                to_char(r.finished_at, 'YYYY-MM-DD HH24:MI:SS') as finished_at,
                to_char(r.watermark_from, 'YYYY-MM-DD HH24:MI') as watermark_from,
                to_char(r.watermark_to, 'YYYY-MM-DD HH24:MI') as watermark_to,
                r.status,
                r.fetched_count,
                r.upserted_count,
                r.staged_party_count,
                r.error_summary
           from public.integration_sync_runs r
           join public.integration_connections c on c.id = r.integration_id
          order by r.started_at desc
          limit 25`,
      )
      .catch(() => ({ rows: [] })),
    pool
      .query<{ n: number }>(`select count(*)::int as n from public.integration_raw_payloads`)
      .catch(() => ({ rows: [{ n: 0 }] })),
    pool
      .query<{
        id: string;
        provider: string;
        external_account_id: string;
        external_account_name: string | null;
        external_iban: string | null;
        external_currency: string;
        cash_account_name: string | null;
        bank_iban: string | null;
      }>(
        `select m.id::text,
                m.provider,
                m.external_account_id,
                m.external_account_name,
                m.external_iban,
                m.external_currency,
                ca.name as cash_account_name,
                ba.iban as bank_iban
           from public.integration_account_mappings m
           left join public.cash_accounts ca on ca.id = coalesce(m.cash_account_id, m.bank_account_id)
           left join public.bank_accounts ba on ba.cash_account_id = m.bank_account_id
          order by m.provider, m.external_account_id`,
      )
      .catch(() => ({ rows: [] })),
    pool
      .query<{
        id: string;
        provider: string;
        external_contact_id: string;
        raw_name: string;
        tax_id: string | null;
        iban: string | null;
        account_type: string | null;
        status: string;
        resolved_party_name: string | null;
      }>(
        `select sp.id::text,
                sp.provider,
                sp.external_contact_id,
                sp.raw_name,
                sp.tax_id,
                sp.iban,
                sp.account_type,
                sp.status,
                p.name as resolved_party_name
           from public.integration_staged_parties sp
           left join public.parties p on p.id = sp.resolved_party_id
          order by (sp.status = 'pending') desc, sp.created_at desc
          limit 50`,
      )
      .catch(() => ({ rows: [] })),
    pool.query<{ id: string; name: string; currency: string; iban: string | null }>(
      `select ca.id::text as id, ca.name, ca.currency, ba.iban
         from public.bank_accounts ba
         join public.cash_accounts ca on ca.id = ba.cash_account_id
        where ca.is_active = true
        order by ca.name`,
    ),
    pool.query<{ id: string; name: string; party_type: string }>(
      `select id::text, name, party_type
         from public.parties
        where is_active = true
        order by name
        limit 200`,
    ),
    pool
      .query<{ total: number; active_count: number }>(
        `select count(*)::int as total,
                count(*) filter (where is_active)::int as active_count
           from public.products`,
      )
      .catch(() => ({ rows: [{ total: 0, active_count: 0 }] })),
    pool
      .query<{
        id: string;
        code: string;
        name: string;
        unit: string | null;
        is_active: boolean;
        notes: string | null;
        latest_price: string | null;
        latest_currency: string | null;
        line_count: number;
      }>(
        `select p.id::text,
                p.code,
                p.name,
                p.unit,
                p.is_active,
                p.notes,
                latest_line.unit_price::text as latest_price,
                latest_line.currency as latest_currency,
                coalesce(line_stats.line_count, 0)::int as line_count
           from public.products p
           left join lateral (
             select il.unit_price, inv.currency
               from public.invoice_lines il
               join public.invoices inv on inv.id = il.invoice_id
              where il.product_id = p.id and inv.status <> 'cancelled'
              order by inv.issue_date desc, il.created_at desc
              limit 1
           ) latest_line on true
           left join lateral (
             select count(*)::int as line_count
               from public.invoice_lines il2
              where il2.product_id = p.id
           ) line_stats on true
          order by p.is_active desc, p.updated_at desc, p.code asc
          limit 25`,
      )
      .catch(() => ({ rows: [] })),
    pool
      .query<{
        id: string;
        pos_terminal_label: string;
        cash_account_name: string | null;
        sale_date: string;
        expected_value_date: string;
        gross_amount: string;
        commission_rate: string;
        commission_amount: string;
        net_settlement_amount: string;
        currency: string;
        is_settled: boolean;
        provider: string | null;
        payload_json: Record<string, unknown> | null;
      }>(
        `select psb.id::text,
                psb.pos_terminal_label,
                ca.name as cash_account_name,
                to_char(psb.sale_date, 'YYYY-MM-DD') as sale_date,
                to_char(psb.expected_value_date, 'YYYY-MM-DD') as expected_value_date,
                psb.gross_amount::text as gross_amount,
                psb.commission_rate::text as commission_rate,
                psb.commission_amount::text as commission_amount,
                psb.net_settlement_amount::text as net_settlement_amount,
                psb.currency,
                psb.is_settled,
                iel.provider,
                irp.payload_json
           from public.pos_settlement_batches psb
           left join public.cash_accounts ca on ca.id = psb.cash_account_id
           left join public.integration_entity_links iel
             on iel.entity_table = 'pos_settlement_batches' and iel.entity_id = psb.id
           left join public.integration_raw_payloads irp
             on irp.id = iel.last_payload_id
          order by psb.sale_date desc, psb.created_at desc
          limit 40`,
      )
      .catch(() => ({ rows: [] })),
  ]);

  const pendingStagedCount = stagedPartiesRes.rows.filter((r) => r.status === "pending").length;
  const enabledConnCount = connections.filter((c) => c.status === "enabled").length;
  const rawPayloadCount = rawCountRes.rows[0]?.n ?? 0;
  const totalProductsCount = productsCountRes.rows[0]?.total ?? 0;
  const activeProductsCount = productsCountRes.rows[0]?.active_count ?? 0;

  // Exact @/lib/money reconciliation of POS settlement batches (TDHP 108)
  const posRows = posBatchesRes.rows.map((row) => {
    const gross = money(row.gross_amount);
    const comm = money(row.commission_amount);
    const rawJson = row.payload_json ?? {};
    const rawBsmvCandidate =
      rawJson.bsmv_amount ??
      rawJson.bsmvAmount ??
      rawJson.taxAmount ??
      rawJson.bsmvTutari ??
      rawJson.bsmv_tutari;
    const bsmv =
      typeof rawBsmvCandidate === "string" || typeof rawBsmvCandidate === "number"
        ? (moneyOrNull(String(rawBsmvCandidate).replace(",", ".")) ?? 0)
        : 0;
    const commPlusBsmv = money(decimal(comm).plus(bsmv));
    const net = money(row.net_settlement_amount);
    const expectedNetDec = decimal(gross).minus(commPlusBsmv);
    const discrepancyDec = decimal(net).minus(expectedNetDec);
    const discrepancy = money(discrepancyDec);
    const hasDiscrepancy = !discrepancyDec.eq(0);
    return {
      ...row,
      gross,
      comm,
      bsmv,
      commPlusBsmv,
      net,
      discrepancy,
      hasDiscrepancy,
    };
  });

  const posTryRows = posRows.filter((r) => r.currency === "TRY");
  const hasPosTry = posTryRows.length > 0;
  const posGrossTry = hasPosTry
    ? money(posTryRows.reduce((acc, r) => acc.plus(r.gross), decimal(0)))
    : null;
  const posCommBsmvTry = hasPosTry
    ? money(posTryRows.reduce((acc, r) => acc.plus(r.commPlusBsmv), decimal(0)))
    : null;
  const posNetTry = hasPosTry
    ? money(posTryRows.reduce((acc, r) => acc.plus(r.net), decimal(0)))
    : null;
  const posDiscrepancyCount = posRows.filter((r) => r.hasDiscrepancy).length;

  const channelRibbonSegments = [
    {
      key: "raw_evidence",
      label: "SHA-256 Ham JSON Kanıtı",
      value: rawPayloadCount,
      formattedValue: `${rawPayloadCount}`,
      tone: "info" as const,
    },
    {
      key: "pos_batches",
      label: "POS 108 Hakediş Yığını",
      value: posRows.length,
      formattedValue: `${posRows.length}`,
      tone: "accent" as const,
    },
    {
      key: "mapped_accounts",
      label: "Eşlenen Banka/Kasa",
      value: mappingsRes.rows.length,
      formattedValue: `${mappingsRes.rows.length}`,
      tone: "pos" as const,
    },
    {
      key: "products",
      label: "Ürün Kataloğu",
      value: activeProductsCount,
      formattedValue: `${activeProductsCount}`,
      tone: "neutral" as const,
    },
    {
      key: "staged_parties",
      label: "Cari Aday Havuzu",
      value: stagedPartiesRes.rows.length,
      formattedValue: `${stagedPartiesRes.rows.length}`,
      tone: pendingStagedCount > 0 ? ("warn" as const) : ("pos" as const),
    },
  ];

  const inputClass =
    "rounded border px-2 py-1.5 text-base sm:text-xs focus:outline-none";
  const inputStyle = {
    background: "var(--surface-1)",
    borderColor: "var(--line)",
    color: "var(--text-1)",
  } as const;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Kurumsal Entegrasyon Merkezi — Türk Açık Bankacılık, GİB e-Fatura & POS 108"
        subtitle="Garanti BBVA · İş Bankası · Yapı Kredi · Akbank · QNB açık bankacılık (CAMT.053 & BKM JSON), Foriba/FitBulut · Uyumsoft · İzibiz · QNB eFinans UBL-TR 1.2, iyzico/PayTR POS 108 gün sonu mutabakatı ve Paraşüt API v4."
        meta={
          <Badge tone={pendingStagedCount > 0 || posDiscrepancyCount > 0 ? "amber" : "green"} dot>
            {enabledConnCount} aktif bağlantı · {posRows.length} POS yığını · {pendingStagedCount} bekleyen cari aday
          </Badge>
        }
        action={
          canTriggerSync ? (
            <form action={runClosedLoopSyncAction}>
              <button
                type="submit"
                className="button-accent px-3 py-2 font-mono text-xs uppercase tracking-wider"
              >
                Kapalı Çevrim Tam Senkron (TCMB + Banka + e-Fatura + POS + 13H)
              </button>
            </form>
          ) : null
        }
      />

      {sp.error ? (
        <div
          className="rounded border px-3 py-2 text-xs font-medium"
          style={{
            background: "color-mix(in srgb, var(--neg) 10%, var(--surface-1))",
            borderColor: "color-mix(in srgb, var(--neg) 35%, var(--line))",
            color: "var(--neg)",
          }}
        >
          {sp.error}
        </div>
      ) : null}
      {sp.result ? (
        <div
          className="rounded border px-3 py-2 text-xs font-medium"
          style={{
            background: "color-mix(in srgb, var(--pos) 10%, var(--surface-1))",
            borderColor: "color-mix(in srgb, var(--pos) 35%, var(--line))",
            color: "var(--pos)",
          }}
        >
          İşlem tamamlandı: {sp.result}
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-6">
        <KeyStat label="Aktif Bağlantı" value={enabledConnCount} tone={enabledConnCount > 0 ? "pos" : "neutral"} />
        <KeyStat label="Senkron Koşusu" value={syncRunsRes.rows.length} tone="info" />
        <KeyStat label="SHA-256 Ham JSON Kanıtı" value={rawPayloadCount} tone="pos" />
        <KeyStat label="POS 108 Yığını" value={posRows.length} tone={posDiscrepancyCount > 0 ? "warn" : "info"} sub={posDiscrepancyCount > 0 ? `${posDiscrepancyCount} uyuşmazlık` : "mutabık"} />
        <KeyStat
          label="Bekleyen Cari Aday"
          value={pendingStagedCount}
          tone={pendingStagedCount > 0 ? "warn" : "pos"}
        />
        <KeyStat
          label="Ürün / Hizmet Kataloğu"
          value={totalProductsCount}
          tone={totalProductsCount > 0 ? "info" : "neutral"}
          sub={`${activeProductsCount} aktif kalem`}
        />
      </div>

      {/* Kanal Bazlı Aktif/Senkron Kayıt Dağılımı + 3 Kurumsal Türkiye Konnektör Koridoru */}
      <div className="folio-corner-mark rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-1)] p-4 shadow-[var(--shadow-xs)]">
        <StackedRibbonSvg
          title="Entegrasyon Kanalları Arası Senkronize Kayıt Dağılımı"
          segments={channelRibbonSegments}
          emptyLabel="Henüz entegrasyon kanallarından çekilmiş kayıt yok — bağlantı ekleyip ilk senkronu tetikleyin veya dosya aktarın."
        />
        <div className="mt-3.5 grid gap-2.5 border-t border-[var(--border)] pt-3.5 text-xs md:grid-cols-3">
          <div className="rounded border border-[var(--border)] bg-[var(--surface-2)]/60 p-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-tone-1">1. Türk Açık Bankacılık (`bank_api`)</span>
              <Badge tone="blue">CAMT.053 &amp; BKM</Badge>
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-tone-3">
              Garanti BBVA (<code>garanti</code>), İş Bankası (<code>isbank</code>), Yapı Kredi (<code>yapikredi</code>),
              Akbank (<code>akbank</code>), QNB (<code>qnb</code>) ve BKM Açık Bankacılık Geçidi (<code>bkm_tos</code>).
            </p>
          </div>
          <div className="rounded border border-[var(--border)] bg-[var(--surface-2)]/60 p-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-tone-1">2. GİB Özel Entegratör (`einvoice`)</span>
              <Badge tone="green">UBL-TR 1.2</Badge>
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-tone-3">
              Foriba / FitBulut (<code>fitbulut</code>), Uyumsoft (<code>uyumsoft</code>), İzibiz (<code>izibiz</code>)
              ve QNB eFinans (<code>qnb_efinans</code>) — ETTN tekilleştirme ve S-10 cari kalkanı.
            </p>
          </div>
          <div className="rounded border border-[var(--border)] bg-[var(--surface-2)]/60 p-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-tone-1">3. POS Gün Sonu (`108` Hazır Değerler)</span>
              <Badge tone="amber">iyzico · PayTR · Banka</Badge>
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-tone-3">
              <code>iyzico</code>, <code>paytr</code> ve banka üye işyeri (<code>bank_pos</code>) hakedişlerinde{" "}
              <code>Brüt − Komisyon − BSMV = Net</code> kuruş denetimi.
            </p>
          </div>
        </div>
      </div>

      {/* 1) Bağlantılar */}
      <Panel
        title="ENTEGRASYON BAĞLANTILARI VE ZAMANLANMIŞ ÇEKİM"
        subtitle="Kimlik bilgileri veritabanında tutulmaz; yalnız ortam değişkeni adı (PARASUT_*) referans alınır."
      >
        {connections.length > 0 ? (
          <TableShell>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left font-mono text-[10px] uppercase text-tone-4">
                  <th className="py-1.5 pr-2">Tür</th>
                  <th className="py-1.5 pr-2">Ad</th>
                  <th className="py-1.5 pr-2">Sağlayıcı</th>
                  <th className="py-1.5 pr-2">Durum</th>
                  <th className="py-1.5 pr-2">Env Değişkeni</th>
                  <th className="py-1.5 pr-2">Periyot (dk)</th>
                  <th className="py-1.5 pr-2">Son Başarılı Çekim</th>
                  <th className="py-1.5 pr-2">Son Hata</th>
                  <th className="py-1.5">İşlem</th>
                </tr>
              </thead>
              <tbody>
                {connections.map((c) => (
                  <tr key={c.id} className="border-t border-line-faint">
                    <td className="py-1.5 pr-2 font-mono text-xs">{c.integrationKind}</td>
                    <td className="py-1.5 pr-2 font-medium" style={{ color: "var(--text-1)" }}>
                      {c.name}
                    </td>
                    <td className="py-1.5 pr-2 font-mono text-xs">{c.provider ?? "—"}</td>
                    <td className="py-1.5 pr-2">
                      <Badge
                        tone={
                          c.status === "enabled"
                            ? "green"
                            : c.status === "error"
                              ? "red"
                              : "neutral"
                        }
                      >
                        {c.status}
                      </Badge>
                    </td>
                    <td className="py-1.5 pr-2 font-mono text-xs">{c.credentialEnvVar ?? "(PARASUT_* varsayılan)"}</td>
                    <td className="py-1.5 pr-2 font-mono text-xs">{c.syncIntervalMinutes ?? "Manuel"}</td>
                    <td className="py-1.5 pr-2 font-mono text-xs">{c.lastSuccessAt ?? "Henüz yok"}</td>
                    <td className="max-w-xs truncate py-1.5 pr-2 text-xs" style={{ color: c.lastError ? "var(--neg)" : "var(--text-3)" }}>
                      {c.lastError ?? "—"}
                    </td>
                    <td className="py-1.5">
                      <div className="flex flex-wrap gap-1.5">
                        {canTriggerSync && c.status === "enabled" ? (
                          <form action={triggerIntegrationSyncAction}>
                            <input type="hidden" name="connectionId" value={c.id} />
                            <button
                              type="submit"
                              className="button-accent px-2 py-1 text-[11px] font-medium"
                            >
                              Şimdi Çek
                            </button>
                          </form>
                        ) : null}
                        {canManageConnections && c.status !== "revoked" ? (
                          <form action={toggleIntegrationStatusAction}>
                            <input type="hidden" name="connectionId" value={c.id} />
                            <input
                              type="hidden"
                              name="nextStatus"
                              value={c.status === "enabled" ? "disabled" : "enabled"}
                            />
                            <button
                              type="submit"
                              className="button-ghost px-2 py-1 text-[11px]"
                            >
                              {c.status === "enabled" ? "Durdur" : "Etkinleştir"}
                            </button>
                          </form>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        ) : (
          <EmptyState>
            Henüz tanımlı entegrasyon bağlantısı yok — Paraşüt API v4 veya TCMB döviz bülteni bağlantısını aşağıdan ekleyebilirsiniz.
          </EmptyState>
        )}

        {canManageConnections ? (
          <form
            action={createIntegrationConnectionAction}
            className="mt-3 grid grid-cols-1 gap-2 rounded border p-3 text-xs sm:grid-cols-4 lg:grid-cols-8"
            style={{ background: "var(--surface-2)", borderColor: "var(--line)" }}
          >
            <select
              name="integrationKind"
              defaultValue="bank_api"
              className={`sm:col-span-2 ${inputClass}`}
              style={inputStyle}
            >
              <option value="bank_api">
                Türk Açık Bankacılık &amp; POS API (Garanti, İş, YK, Akbank, QNB, iyzico, PayTR)
              </option>
              <option value="einvoice">
                GİB Özel Entegratör API (Foriba/FitBulut, Uyumsoft, İzibiz, QNB eFinans)
              </option>
              <option value="accounting">Muhasebe — Paraşüt API v4 (Canlı)</option>
              <option value="fx_rate">Döviz Kuru — TCMB Bülteni + Arşiv (Canlı)</option>
            </select>
            <input
              name="name"
              required
              placeholder="Bağlantı adı (ör. Garanti BBVA Açık Banka)"
              className={inputClass}
              style={inputStyle}
            />
            <select
              name="provider"
              defaultValue="garanti"
              className={inputClass}
              style={inputStyle}
              aria-label="Entegrasyon sağlayıcısı"
            >
              <optgroup label="Türk Açık Bankacılık (CAMT.053 / BKM JSON)">
                <option value="garanti">Garanti BBVA (garanti)</option>
                <option value="isbank">Türkiye İş Bankası (isbank)</option>
                <option value="yapikredi">Yapı Kredi (yapikredi)</option>
                <option value="akbank">Akbank (akbank)</option>
                <option value="qnb">QNB (qnb)</option>
                <option value="bkm_tos">BKM Açık Bankacılık (bkm_tos)</option>
              </optgroup>
              <optgroup label="GİB Özel Entegratör (UBL-TR 1.2)">
                <option value="fitbulut">Foriba / FitBulut (fitbulut)</option>
                <option value="uyumsoft">Uyumsoft (uyumsoft)</option>
                <option value="izibiz">İzibiz (izibiz)</option>
                <option value="qnb_efinans">QNB eFinans (qnb_efinans)</option>
              </optgroup>
              <optgroup label="POS Gün Sonu Hakediş (108)">
                <option value="iyzico">iyzico Hakediş (iyzico)</option>
                <option value="paytr">PayTR Hakediş (paytr)</option>
                <option value="bank_pos">Banka Üye İşyeri POS (bank_pos)</option>
              </optgroup>
              <optgroup label="Muhasebe & Merkez Bankası">
                <option value="parasut">Paraşüt API v4 (parasut)</option>
                <option value="tcmb">TCMB Döviz Bülteni (tcmb)</option>
              </optgroup>
            </select>
            <input
              name="baseUrl"
              placeholder="API Uç Noktası (https://...)"
              className={inputClass}
              style={inputStyle}
            />
            <input
              name="ownTaxNumber"
              placeholder="VKN / Firma No (opsiyonel)"
              className={`font-mono ${inputClass}`}
              style={inputStyle}
            />
            <input
              name="credentialEnvVar"
              defaultValue="OPEN_BANKING_TOKEN"
              placeholder="Env adı (ör. GARANTI_API_TOKEN)"
              className={`font-mono ${inputClass}`}
              style={inputStyle}
            />
            <button
              type="submit"
              className="button-accent px-3 py-1.5 font-medium"
            >
              Bağlantı Ekle
            </button>
          </form>
        ) : null}
      </Panel>

      {/* 2) Yeni Cari Aday İnceleme Kuyruğu (S-10) */}
      <Panel
        title="YENİ CARİ ADAY İNCELEME KUYRUĞU (S-10 KALKANI)"
        subtitle="Paraşüt'ten gelen ve kanonik cari listesinde bulunmayan karşı taraflar otomatik yaratılmaz; operatör onayıyla createCounterparty kapısından açılır veya mevcut cariye bağlanır ve ertelenen faturalar anında içeri alınır."
      >
        {stagedPartiesRes.rows.length > 0 ? (
          <TableShell>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left font-mono text-[10px] uppercase text-tone-4">
                  <th className="py-1.5 pr-2">Paraşüt Cari ID</th>
                  <th className="py-1.5 pr-2">Ham Ünvan</th>
                  <th className="py-1.5 pr-2">VKN / TCKN</th>
                  <th className="py-1.5 pr-2">IBAN</th>
                  <th className="py-1.5 pr-2">Tür</th>
                  <th className="py-1.5 pr-2">Durum</th>
                  <th className="py-1.5 pr-2">Çözümlenen Cari</th>
                  <th className="py-1.5">İşlem</th>
                </tr>
              </thead>
              <tbody>
                {stagedPartiesRes.rows.map((spRow) => (
                  <tr key={spRow.id} className="border-t border-line-faint">
                    <td className="py-1.5 pr-2 font-mono text-xs">{spRow.external_contact_id}</td>
                    <td className="py-1.5 pr-2 font-medium" style={{ color: "var(--text-1)" }}>
                      {spRow.raw_name}
                    </td>
                    <td className="py-1.5 pr-2 font-mono text-xs">{spRow.tax_id ?? "—"}</td>
                    <td className="py-1.5 pr-2 font-mono text-xs">{spRow.iban ?? "—"}</td>
                    <td className="py-1.5 pr-2 text-xs">{spRow.account_type ?? "company"}</td>
                    <td className="py-1.5 pr-2">
                      <Badge
                        tone={
                          spRow.status === "pending"
                            ? "amber"
                            : spRow.status === "ignored"
                              ? "neutral"
                              : "green"
                        }
                      >
                        {spRow.status}
                      </Badge>
                    </td>
                    <td className="py-1.5 pr-2 text-xs">{spRow.resolved_party_name ?? "—"}</td>
                    <td className="py-1.5">
                      {spRow.status === "pending" && canResolveParties ? (
                        <div className="flex flex-wrap items-center gap-1.5">
                          {canCreateParties ? (
                            <form action={resolveStagedPartyAction}>
                              <input type="hidden" name="stagedId" value={spRow.id} />
                              <input type="hidden" name="decision" value="create" />
                              <button
                                type="submit"
                                className="button-accent px-2 py-1 text-[11px] font-medium"
                              >
                                Yeni Cari Aç
                              </button>
                            </form>
                          ) : null}
                          {partiesRes.rows.length > 0 ? (
                            <form action={resolveStagedPartyAction} className="flex items-center gap-1">
                              <input type="hidden" name="stagedId" value={spRow.id} />
                              <input type="hidden" name="decision" value="link" />
                              <select
                                name="partyId"
                                className="rounded border px-1.5 py-1 text-[11px]"
                                style={inputStyle}
                              >
                                {partiesRes.rows.map((p) => (
                                  <option key={p.id} value={p.id}>
                                    {p.name}
                                  </option>
                                ))}
                              </select>
                              <button
                                type="submit"
                                className="button-ghost px-2 py-1 text-[11px]"
                              >
                                Bağla
                              </button>
                            </form>
                          ) : null}
                          <form action={resolveStagedPartyAction}>
                            <input type="hidden" name="stagedId" value={spRow.id} />
                            <input type="hidden" name="decision" value="ignore" />
                            <button
                              type="submit"
                              className="button-ghost px-2 py-1 text-[11px]"
                            >
                              Yoksay
                            </button>
                          </form>
                        </div>
                      ) : (
                        <span className="text-xs text-tone-4">Tamamlandı</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        ) : (
          <EmptyState>
            Bekleyen cari adayı yok — Paraşüt senkronizasyonunda yeni bir müşteri/tedarikçi tespit edildiğinde burada listelenir.
          </EmptyState>
        )}
      </Panel>

      {/* 3) Hesap Eşleme & Hibrit Banka İçe Aktarma */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          title="PARAŞÜT HESABI ↔ MAS BANKA/KASA EŞLEME"
          subtitle="Kendi hesaplarımız arası virmanların (own_transfer) doğru yakalanması ve doğru banka hesabına yazılması için eşleme tablosu."
        >
          {mappingsRes.rows.length > 0 ? (
            <TableShell>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left font-mono text-[10px] uppercase text-tone-4">
                    <th className="py-1.5 pr-2">Paraşüt Hesap ID</th>
                    <th className="py-1.5 pr-2">Ad / IBAN</th>
                    <th className="py-1.5 pr-2">Döviz</th>
                    <th className="py-1.5">MAS Hesabı</th>
                  </tr>
                </thead>
                <tbody>
                  {mappingsRes.rows.map((m) => (
                    <tr key={m.id} className="border-t border-line-faint">
                      <td className="py-1.5 pr-2 font-mono text-xs">{m.external_account_id}</td>
                      <td className="py-1.5 pr-2 text-xs">
                        <div style={{ color: "var(--text-1)" }}>{m.external_account_name ?? "—"}</div>
                        <div className="font-mono text-[11px] text-tone-3">{m.external_iban ?? ""}</div>
                      </td>
                      <td className="py-1.5 pr-2 font-mono text-xs">{m.external_currency}</td>
                      <td className="py-1.5 text-xs">{m.cash_account_name ?? "Eşlenmedi"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableShell>
          ) : (
            <p className="text-xs text-tone-3">Henüz kayıtlı hesap eşlemesi yok.</p>
          )}

          {canMapAccounts && bankAccountsRes.rows.length > 0 ? (
            <form
              action={saveAccountMappingAction}
              className="mt-3 grid grid-cols-2 gap-2 rounded border p-3 text-xs"
              style={{ background: "var(--surface-2)", borderColor: "var(--line)" }}
            >
              <input type="hidden" name="provider" value="parasut" />
              <input
                name="externalAccountId"
                required
                placeholder="Paraşüt Hesap ID (ör. 1042)"
                className={inputClass}
                style={inputStyle}
              />
              <input
                name="externalAccountName"
                placeholder="Paraşüt Hesap Adı"
                className={inputClass}
                style={inputStyle}
              />
              <input
                name="externalIban"
                placeholder="TR IBAN (opsiyonel)"
                className={inputClass}
                style={inputStyle}
              />
              <select
                name="externalCurrency"
                defaultValue="TRY"
                className={inputClass}
                style={inputStyle}
              >
                <option value="TRY">TRY</option>
                <option value="USD">USD</option>
                <option value="EUR">EUR</option>
                <option value="GBP">GBP</option>
              </select>
              <select
                name="bankAccountId"
                required
                className={`col-span-2 ${inputClass}`}
                style={inputStyle}
              >
                {bankAccountsRes.rows.map((ba) => (
                  <option key={ba.id} value={ba.id}>
                    {ba.name} ({ba.currency}) {ba.iban ? `— ${ba.iban}` : ""}
                  </option>
                ))}
              </select>
              <button
                type="submit"
                className="button-accent col-span-2 px-3 py-1.5 font-medium"
              >
                Hesap Eşlemesini Kaydet
              </button>
            </form>
          ) : null}
        </Panel>

        <Panel
          title="HİBRİT BANKA HATTI (MT940 / ISO 20022 camt.053 / PARAŞÜT EXCEL)"
          subtitle="Paraşüt'te henüz mutabakatı yapılmadığı için API'ye düşmeyen banka hareketlerini MT940, camt.053 XML veya Excel ile yükleyin; sonradan API'den geldiğinde cross_channel_dedupe_hash çift kaydı önler."
        >
          {canImportBank && bankAccountsRes.rows.length > 0 ? (
            <form
              action={importHybridBankStatementAction}
              className="grid gap-2 rounded border p-3 text-xs"
              style={{ background: "var(--surface-2)", borderColor: "var(--line)" }}
            >
              <label style={{ color: "var(--text-2)" }}>Hedef MAS Banka Hesabı</label>
              <select
                name="bankAccountId"
                required
                className={inputClass}
                style={inputStyle}
              >
                {bankAccountsRes.rows.map((ba) => (
                  <option key={ba.id} value={ba.id}>
                    {ba.name} ({ba.currency}) {ba.iban ? `— ${ba.iban}` : ""}
                  </option>
                ))}
              </select>
              <label style={{ color: "var(--text-2)" }}>
                Ekstre Dosyası (`.mt940`, `.sta`, `.xml` camt.053, `.xlsx`, `.csv`)
              </label>
              <input
                type="file"
                name="file"
                required
                accept=".mt940,.sta,.940,.xml,.xlsx,.csv,.txt"
                className={inputClass}
                style={inputStyle}
              />
              <button
                type="submit"
                className="button-accent px-3 py-1.5 font-medium"
              >
                Hibrit Ekstreyi İçe Aktar ve Tekilleştir
              </button>
            </form>
          ) : (
            <EmptyState>
              Banka ekstresi yüklemek için aktif banka hesabı ve yetki gerekli — önce Finans &gt; Banka ekranından banka hesabınızı tanımlayın.
            </EmptyState>
          )}
        </Panel>
      </div>

      {/* 3B) GİB UBL-TR 1.2 e-Fatura / e-Arşiv (.xml / .zip) İçe Aktarma Masası (M-64) */}
      <Panel
        title="GİB UBL-TR 1.2 E-FATURA / E-ARŞİV (.XML VE .ZIP) ATOMİK İÇE AKTARMA MASASI"
        subtitle="GİB UBL-TR 1.2 standart XML veya toplu ZIP paketlerini ayrıştırır; ETTN (ubl_uuid) ile mükerrer kaydı önler, tanınmayan VKN'leri S-10 cari aday kuyruğuna düşürür ve eşleşen faturaları SHA-256 doküman kanıtı + TDHP yönetim yevmiyesiyle birlikte kaydeder."
        right={<Badge tone="green">UBL-TR 1.2 · XML / ZIP Aktif</Badge>}
      >
        {canImportInvoices ? (
          <form
            action={importUblTrInvoiceAction}
            className="grid grid-cols-1 gap-2 rounded border p-3 text-xs sm:grid-cols-4"
            style={{ background: "var(--surface-2)", borderColor: "var(--line)" }}
          >
            <div>
              <label className="mb-1 block text-[11px]" style={{ color: "var(--text-2)" }}>
                Varsayılan Fatura Yönü
              </label>
              <select
                name="defaultDirection"
                defaultValue="purchase"
                className={`w-full ${inputClass}`}
                style={inputStyle}
              >
                <option value="purchase">Gelen e-Fatura (Alış / Gider)</option>
                <option value="sales">Giden e-Fatura / e-Arşiv (Satış)</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-[11px]" style={{ color: "var(--text-2)" }}>
                Kendi VKN / TCKN (Otomatik Yön Tespiti İçin)
              </label>
              <input
                name="ownTaxNumber"
                placeholder="Ör. 1234567890 (opsiyonel)"
                className={`w-full font-mono ${inputClass}`}
                style={inputStyle}
              />
            </div>
            <div>
              <label className="mb-1 block text-[11px]" style={{ color: "var(--text-2)" }}>
                UBL-TR Dosyası (`.xml` veya `.zip`)
              </label>
              <input
                type="file"
                name="file"
                required
                accept=".xml,.zip"
                className={`w-full ${inputClass}`}
                style={inputStyle}
              />
            </div>
            <div className="flex items-end">
              <button
                type="submit"
                className="button-accent w-full px-3 py-1.5 font-medium"
              >
                UBL-TR e-Fatura Paketi İçe Aktar
              </button>
            </div>
          </form>
        ) : (
          <EmptyState>
            UBL-TR e-Fatura içe aktarmak için fatura oluşturma yetkisi gereklidir.
          </EmptyState>
        )}
      </Panel>

      {/* 3C) POS Gün Sonu Mutabakatı (TDHP 108 Hazır Değerler / Kredi Kartı Alacakları) */}
      <Panel
        title="POS GÜN SONU MUTABAKATI (TDHP 108 HAZIR DEĞERLER / KREDİ KARTI ALACAKLARI)"
        subtitle="iyzico, PayTR ve banka üye işyeri gün sonu CSV/JSON dosyalarını idempotent olarak pos_settlement_batches tablosuna kaydeder; Brüt Satış − (Komisyon + BSMV) = Net Hakediş denklemini kuruş hassasiyetiyle denetler."
        right={
          <Badge tone={posDiscrepancyCount > 0 ? "amber" : "green"} dot>
            {posDiscrepancyCount > 0
              ? `${posDiscrepancyCount} komisyon uyuşmazlık uyarısı`
              : "108 POS mutabakatı temiz"}
          </Badge>
        }
      >
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <KeyStat
            label="Brüt Satış (TRY)"
            value={formatMoney(posGrossTry, "TRY")}
            tone="info"
            sub={hasPosTry ? `${posTryRows.length} TRY yığını` : "henüz POS yığını yok"}
          />
          <KeyStat
            label="Komisyon + BSMV (TRY)"
            value={formatMoney(posCommBsmvTry, "TRY")}
            tone="neutral"
            sub="kesinti toplamı"
          />
          <KeyStat
            label="Net Hakediş (TRY)"
            value={formatMoney(posNetTry, "TRY")}
            tone="pos"
            sub="valörde hesaba geçecek"
          />
          <KeyStat
            label="Komisyon Uyuşmazlık Uyarısı"
            value={posDiscrepancyCount}
            tone={posDiscrepancyCount > 0 ? "warn" : "pos"}
            sub="Brüt − Kesinti ≠ Net"
          />
        </div>

        {canImportPos ? (
          <form
            action={importPosSettlementBatchAction}
            className="mt-3 grid grid-cols-1 gap-2 rounded border p-3 text-xs sm:grid-cols-4"
            style={{ background: "var(--surface-2)", borderColor: "var(--line)" }}
          >
            <div>
              <label className="mb-1 block text-[11px]" style={{ color: "var(--text-2)" }}>
                POS Sağlayıcısı / Kanal
              </label>
              <select
                name="provider"
                defaultValue="iyzico"
                className={`w-full ${inputClass}`}
                style={inputStyle}
              >
                <option value="iyzico">iyzico Gün Sonu Hakediş (JSON / CSV)</option>
                <option value="paytr">PayTR Hakediş Raporu (JSON / CSV)</option>
                <option value="bank_pos">Banka Üye İşyeri POS Gün Sonu (CSV / JSON)</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-[11px]" style={{ color: "var(--text-2)" }}>
                Hedef Valör Hesabı (Opsiyonel)
              </label>
              <select
                name="cashAccountId"
                defaultValue=""
                className={`w-full ${inputClass}`}
                style={inputStyle}
              >
                <option value="">Otomatik eşlenen / aktif banka hesabı</option>
                {bankAccountsRes.rows.map((ba) => (
                  <option key={ba.id} value={ba.id}>
                    {ba.name} ({ba.currency}) {ba.iban ? `— ${ba.iban}` : ""}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-[11px]" style={{ color: "var(--text-2)" }}>
                POS Hakediş Dosyası (`.csv` veya `.json`)
              </label>
              <input
                type="file"
                name="file"
                required
                accept=".csv,.json,text/csv,application/json"
                className={`w-full ${inputClass}`}
                style={inputStyle}
              />
            </div>
            <div className="flex items-end">
              <button
                type="submit"
                className="button-accent w-full px-3 py-1.5 font-medium"
              >
                POS Gün Sonu Yığınını Aktar
              </button>
            </div>
          </form>
        ) : null}

        <div className="mt-3">
          {posRows.length > 0 ? (
            <TableShell>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left font-mono text-[10px] uppercase text-tone-4">
                    <th className="py-1.5 pr-2">Terminal / Sağlayıcı</th>
                    <th className="py-1.5 pr-2">Satış Tarihi</th>
                    <th className="py-1.5 pr-2">Beklenen Valör</th>
                    <th className="py-1.5 pr-2 text-right">Brüt Satış</th>
                    <th className="py-1.5 pr-2 text-right">Komisyon + BSMV</th>
                    <th className="py-1.5 pr-2 text-right">Net Hakediş</th>
                    <th className="py-1.5 pr-2">Valör Hesabı</th>
                    <th className="py-1.5">Mutabakat Durumu</th>
                  </tr>
                </thead>
                <tbody>
                  {posRows.map((row) => (
                    <tr key={row.id} className="border-t border-line-faint">
                      <td className="py-1.5 pr-2 font-medium" style={{ color: "var(--text-1)" }}>
                        <div>{row.pos_terminal_label}</div>
                        {row.provider ? (
                          <span className="font-mono text-[10px] text-tone-3">{row.provider}</span>
                        ) : null}
                      </td>
                      <td className="py-1.5 pr-2 font-mono text-xs tabular-nums">{row.sale_date}</td>
                      <td className="py-1.5 pr-2 font-mono text-xs tabular-nums">
                        {row.expected_value_date}
                      </td>
                      <td className="py-1.5 pr-2 text-right font-mono text-xs tabular-nums">
                        {formatMoney(row.gross, row.currency)}
                      </td>
                      <td className="py-1.5 pr-2 text-right font-mono text-xs tabular-nums">
                        {formatMoney(row.commPlusBsmv, row.currency)}
                      </td>
                      <td className="py-1.5 pr-2 text-right font-mono text-xs font-semibold tabular-nums">
                        {formatMoney(row.net, row.currency)}
                      </td>
                      <td className="py-1.5 pr-2 text-xs text-tone-2">
                        {row.cash_account_name ?? "—"}
                      </td>
                      <td className="py-1.5">
                        <div className="flex flex-wrap items-center gap-1.5">
                          {row.hasDiscrepancy ? (
                            <Badge tone="amber" dot>
                              Komisyon Uyuşmazlık ({formatMoney(row.discrepancy, row.currency)})
                            </Badge>
                          ) : (
                            <Badge tone={row.is_settled ? "green" : "blue"}>
                              {row.is_settled ? "Hesaba Geçti" : "108 Valör Bekliyor"}
                            </Badge>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableShell>
          ) : (
            <EmptyState>
              Henüz kayıtlı POS gün sonu hakediş yığını yok — iyzico, PayTR veya banka üye işyeri CSV/JSON dosyasını yukarıdan aktarabilirsiniz.
            </EmptyState>
          )}
        </div>
      </Panel>

      {/* 4) Entegre Ürün / Hizmet Kataloğu (F-41) */}
      <Panel
        title="ENTEGRE ÜRÜN / HİZMET KATALOĞU"
        subtitle="Fatura satırlarında ve bütçe boyutlarında referans alınan ürün/hizmet ana verileri ve son gözlenen birim fiyatları."
        right={
          <span className="font-mono text-[10px] uppercase text-tone-4">
            {totalProductsCount} toplam · {activeProductsCount} aktif
          </span>
        }
      >
        {productsRes.rows.length > 0 ? (
          <TableShell>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left font-mono text-[10px] uppercase text-tone-4">
                  <th className="py-1.5 pr-2">Kod</th>
                  <th className="py-1.5 pr-2">Ürün / Hizmet Adı</th>
                  <th className="py-1.5 pr-2">Birim</th>
                  <th className="py-1.5 pr-2 text-right">Son Birim Fiyat</th>
                  <th className="py-1.5 pr-2">Döviz</th>
                  <th className="py-1.5 pr-2 text-right">Fatura Satırı</th>
                  <th className="py-1.5">Durum</th>
                </tr>
              </thead>
              <tbody>
                {productsRes.rows.map((prod) => {
                  const currency = prod.latest_currency ?? "TRY";
                  const numericPrice = prod.latest_price != null ? Number(prod.latest_price) : null;
                  return (
                    <tr key={prod.id} className="border-t border-line-faint">
                      <td className="py-1.5 pr-2 font-mono text-xs">{prod.code}</td>
                      <td className="py-1.5 pr-2 font-medium" style={{ color: "var(--text-1)" }}>
                        <div>{prod.name}</div>
                        {prod.notes ? (
                          <div className="truncate text-[11px] font-normal text-tone-3">{prod.notes}</div>
                        ) : null}
                      </td>
                      <td className="py-1.5 pr-2 font-mono text-xs">{prod.unit ?? "adet"}</td>
                      <td className="py-1.5 pr-2 text-right font-mono text-xs tabular-nums">
                        {numericPrice != null && Number.isFinite(numericPrice)
                          ? formatMoney(numericPrice, currency)
                          : "—"}
                      </td>
                      <td className="py-1.5 pr-2 font-mono text-xs">{prod.latest_currency ?? "—"}</td>
                      <td className="py-1.5 pr-2 text-right font-mono text-xs tabular-nums">{prod.line_count}</td>
                      <td className="py-1.5">
                        <Badge tone={prod.is_active ? "green" : "neutral"}>
                          {prod.is_active ? "Aktif" : "Pasif"}
                        </Badge>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableShell>
        ) : (
          <EmptyState>
            Henüz senkronize veya tanımlı ürün / hizmet kalemi bulunmuyor — fatura satırları ve organizasyon boyutlarıyla birlikte katalog kalemleri burada listelenir.
          </EmptyState>
        )}
      </Panel>

      {/* 5) Son Senkronizasyon Koşuları */}
      <Panel
        title="SON SENKRONİZASYON KOŞULARI VE SHA-256 KANIT SOYKÜTÜĞÜ"
        subtitle="Her senkron koşusu yüksek su izi (watermark - 24 saat örtüşme penceresi) ve ham JSON SHA-256 özetleriyle kaydedilir."
      >
        {syncRunsRes.rows.length > 0 ? (
          <TableShell>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left font-mono text-[10px] uppercase text-tone-4">
                  <th className="py-1.5 pr-2">Bağlantı</th>
                  <th className="py-1.5 pr-2">Başlangıç</th>
                  <th className="py-1.5 pr-2">Bitiş</th>
                  <th className="py-1.5 pr-2">Watermark Penceresi</th>
                  <th className="py-1.5 pr-2">Durum</th>
                  <th className="py-1.5 pr-2 text-right">Çekilen</th>
                  <th className="py-1.5 pr-2 text-right">Upsert</th>
                  <th className="py-1.5 pr-2 text-right">Cari Aday</th>
                  <th className="py-1.5">Hata Özeti</th>
                </tr>
              </thead>
              <tbody>
                {syncRunsRes.rows.map((r) => (
                  <tr key={r.id} className="border-t border-line-faint">
                    <td className="py-1.5 pr-2 font-medium" style={{ color: "var(--text-1)" }}>
                      {r.integration_name}
                    </td>
                    <td className="py-1.5 pr-2 font-mono text-xs">{r.started_at}</td>
                    <td className="py-1.5 pr-2 font-mono text-xs">{r.finished_at ?? "—"}</td>
                    <td className="py-1.5 pr-2 font-mono text-xs">
                      {r.watermark_from ?? "—"} → {r.watermark_to ?? "—"}
                    </td>
                    <td className="py-1.5 pr-2">
                      <Badge
                        tone={
                          r.status === "succeeded"
                            ? "green"
                            : r.status === "failed"
                              ? "red"
                              : "amber"
                        }
                      >
                        {r.status}
                      </Badge>
                    </td>
                    <td className="py-1.5 pr-2 text-right font-mono text-xs">{r.fetched_count}</td>
                    <td className="py-1.5 pr-2 text-right font-mono text-xs">{r.upserted_count}</td>
                    <td className="py-1.5 pr-2 text-right font-mono text-xs">{r.staged_party_count}</td>
                    <td
                      className="max-w-xs truncate py-1.5 text-xs"
                      style={{ color: r.error_summary ? "var(--neg)" : "var(--text-3)" }}
                    >
                      {r.error_summary ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        ) : (
          <EmptyState>
            Henüz senkronizasyon koşusu kaydı yok — Paraşüt API v4 senkronizasyonu çalıştığında koşu makbuzları burada listelenir.
          </EmptyState>
        )}
      </Panel>
    </div>
  );
}
