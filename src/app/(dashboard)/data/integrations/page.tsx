import { getRequestUser } from "@/lib/auth";
import { can } from "@/lib/authz/matrix";
import { requireRouteAccess } from "@/lib/authz/route-guard";
import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { EmptyState, KeyStat, PageHeader, TableShell } from "@/components/ui/shell";
import { getPool } from "@/lib/db";
import { listConnections } from "@/lib/integrations/engine";
import {
  createIntegrationConnectionAction,
  importHybridBankStatementAction,
  resolveStagedPartyAction,
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

  const [
    connections,
    syncRunsRes,
    rawCountRes,
    mappingsRes,
    stagedPartiesRes,
    bankAccountsRes,
    partiesRes,
  ] = await Promise.all([
    listConnections(pool),
    pool.query<{
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
    ).catch(() => ({ rows: [] })),
    pool.query<{ n: number }>(`select count(*)::int as n from public.integration_raw_payloads`).catch(() => ({ rows: [{ n: 0 }] })),
    pool.query<{
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
    ).catch(() => ({ rows: [] })),
    pool.query<{
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
    ).catch(() => ({ rows: [] })),
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
  ]);

  const pendingStagedCount = stagedPartiesRes.rows.filter((r) => r.status === "pending").length;
  const enabledConnCount = connections.filter((c) => c.status === "enabled").length;
  const rawPayloadCount = rawCountRes.rows[0]?.n ?? 0;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Entegrasyon Merkezi — Salt-Okunur Paraşüt API v4 & Hibrit Banka Hattı"
        subtitle="Yalnız https://api.parasut.com/v4/... GET uçları üzerinden SHA-256 ham JSON kanıtlı senkronizasyon, cari aday onay kuyruğu ve MT940 / ISO 20022 camt.053 / Excel çapraz-kanal tekilleştirme."
        meta={
          <Badge tone={pendingStagedCount > 0 ? "amber" : "green"} dot>
            {enabledConnCount} aktif bağlantı · {pendingStagedCount} bekleyen cari aday
          </Badge>
        }
      />

      {sp.error ? (
        <div className="rounded border border-red-800 bg-red-950/60 px-3 py-2 text-xs text-red-200">
          {sp.error}
        </div>
      ) : null}
      {sp.result ? (
        <div className="rounded border border-emerald-800 bg-emerald-950/50 px-3 py-2 text-xs text-emerald-200">
          İşlem tamamlandı: {sp.result}
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <KeyStat label="Aktif Bağlantı" value={enabledConnCount} tone={enabledConnCount > 0 ? "pos" : "neutral"} />
        <KeyStat label="Senkron Koşusu" value={syncRunsRes.rows.length} tone="info" />
        <KeyStat label="SHA-256 Ham JSON Kanıtı" value={rawPayloadCount} tone="pos" />
        <KeyStat label="Eşlenen Hesap" value={mappingsRes.rows.length} tone="neutral" />
        <KeyStat
          label="Bekleyen Cari Aday"
          value={pendingStagedCount}
          tone={pendingStagedCount > 0 ? "warn" : "pos"}
        />
      </div>

      {/* 1) Bağlantılar */}
      <Panel
        title="ENTEGRASYON BAĞLANTILARI VE ZAMANLANMIŞ ÇEKİM"
        subtitle="Kimlik bilgileri veritabanında tutulmaz; yalnız ortam değişkeni adı (PARASUT_*) referans alınır."
      >
        {connections.length > 0 ? (
          <TableShell>
            <thead>
              <tr>
                <th>Tür</th>
                <th>Ad</th>
                <th>Sağlayıcı</th>
                <th>Durum</th>
                <th>Env Değişkeni</th>
                <th>Periyot (dk)</th>
                <th>Son Başarılı Çekim</th>
                <th>Son Hata</th>
                <th>İşlem</th>
              </tr>
            </thead>
            <tbody>
              {connections.map((c) => (
                <tr key={c.id}>
                  <td className="font-mono text-xs">{c.integrationKind}</td>
                  <td className="font-medium">{c.name}</td>
                  <td className="font-mono text-xs">{c.provider ?? "—"}</td>
                  <td>
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
                  <td className="font-mono text-xs">{c.credentialEnvVar ?? "(PARASUT_* varsayılan)"}</td>
                  <td className="font-mono text-xs">{c.syncIntervalMinutes ?? "Manuel"}</td>
                  <td className="font-mono text-xs">{c.lastSuccessAt ?? "Henüz yok"}</td>
                  <td className="max-w-xs truncate text-xs text-red-300">{c.lastError ?? "—"}</td>
                  <td>
                    <div className="flex flex-wrap gap-1.5">
                      {canTriggerSync && c.status === "enabled" ? (
                        <form action={triggerIntegrationSyncAction}>
                          <input type="hidden" name="connectionId" value={c.id} />
                          <button
                            type="submit"
                            className="rounded bg-emerald-700 px-2 py-1 text-[11px] font-medium text-white"
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
                            className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-[11px] text-neutral-200"
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
          </TableShell>
        ) : (
          <EmptyState>
            Henüz tanımlı entegrasyon bağlantısı yok — Paraşüt API v4 veya TCMB döviz bülteni bağlantısını aşağıdan ekleyebilirsiniz.
          </EmptyState>
        )}

        {canManageConnections ? (
          <form
            action={createIntegrationConnectionAction}
            className="mt-3 grid grid-cols-2 gap-2 rounded border border-neutral-800 bg-neutral-950/60 p-3 text-xs sm:grid-cols-6"
          >
            <select
              name="integrationKind"
              defaultValue="accounting"
              className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5"
            >
              <option value="accounting">Muhasebe (Paraşüt API v4)</option>
              <option value="fx_rate">Döviz Kuru (TCMB)</option>
              <option value="bank_api">Banka API</option>
              <option value="einvoice">e-Fatura</option>
            </select>
            <input
              name="name"
              required
              placeholder="Bağlantı adı (ör. Paraşüt Ana Firma)"
              className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5"
            />
            <input
              name="provider"
              defaultValue="parasut"
              placeholder="Sağlayıcı (parasut)"
              className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5"
            />
            <input
              name="companyId"
              placeholder="Paraşüt Firma No (company_id)"
              className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5"
            />
            <input
              name="credentialEnvVar"
              defaultValue="PARASUT_PASSWORD"
              placeholder="Env adı (PARASUT_PASSWORD)"
              className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5"
            />
            <button
              type="submit"
              className="rounded bg-sky-700 px-3 py-1.5 font-medium text-white"
            >
              Bağlantı Ekle
            </button>
          </form>
        ) : null}
      </Panel>

      {/* 2) Yeni Cari Aday İnceleme Kuyruğu (S-10) */}
      <Panel
        title="YENİ CARİ ADAY İNCELEME KUYRUĞU (S-10 KALKANI)"
        subtitle="Paraşüt'ten gelen ve kanonik cari listesinde bulunmayan karşı taraflar otomatik yaratılmaz; operatör onayıyla createCounterparty kapısından açılır veya mevcut cariye bağlanır."
      >
        {stagedPartiesRes.rows.length > 0 ? (
          <TableShell>
            <thead>
              <tr>
                <th>Paraşüt Cari ID</th>
                <th>Ham Ünvan</th>
                <th>VKN / TCKN</th>
                <th>IBAN</th>
                <th>Tür</th>
                <th>Durum</th>
                <th>Çözümlenen Cari</th>
                <th>İşlem</th>
              </tr>
            </thead>
            <tbody>
              {stagedPartiesRes.rows.map((spRow) => (
                <tr key={spRow.id}>
                  <td className="font-mono text-xs">{spRow.external_contact_id}</td>
                  <td className="font-medium">{spRow.raw_name}</td>
                  <td className="font-mono text-xs">{spRow.tax_id ?? "—"}</td>
                  <td className="font-mono text-xs">{spRow.iban ?? "—"}</td>
                  <td className="text-xs">{spRow.account_type ?? "company"}</td>
                  <td>
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
                  <td className="text-xs">{spRow.resolved_party_name ?? "—"}</td>
                  <td>
                    {spRow.status === "pending" && canResolveParties ? (
                      <div className="flex flex-wrap items-center gap-1.5">
                        {canCreateParties ? (
                          <form action={resolveStagedPartyAction}>
                            <input type="hidden" name="stagedId" value={spRow.id} />
                            <input type="hidden" name="decision" value="create" />
                            <button
                              type="submit"
                              className="rounded bg-emerald-700 px-2 py-1 text-[11px] font-medium text-white"
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
                              className="rounded border border-neutral-800 bg-neutral-900 px-1.5 py-1 text-[11px]"
                            >
                              {partiesRes.rows.map((p) => (
                                <option key={p.id} value={p.id}>
                                  {p.name}
                                </option>
                              ))}
                            </select>
                            <button
                              type="submit"
                              className="rounded border border-sky-700 bg-sky-950/60 px-2 py-1 text-[11px] text-sky-200"
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
                            className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-[11px] text-neutral-300"
                          >
                            Yoksay
                          </button>
                        </form>
                      </div>
                    ) : (
                      <span className="text-xs text-neutral-500">Tamamlandı</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
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
              <thead>
                <tr>
                  <th>Paraşüt Hesap ID</th>
                  <th>Ad / IBAN</th>
                  <th>Döviz</th>
                  <th>MAS Hesabı</th>
                </tr>
              </thead>
              <tbody>
                {mappingsRes.rows.map((m) => (
                  <tr key={m.id}>
                    <td className="font-mono text-xs">{m.external_account_id}</td>
                    <td className="text-xs">
                      <div>{m.external_account_name ?? "—"}</div>
                      <div className="font-mono text-[11px] text-neutral-400">{m.external_iban ?? ""}</div>
                    </td>
                    <td className="font-mono text-xs">{m.external_currency}</td>
                    <td className="text-xs">{m.cash_account_name ?? "Eşlenmedi"}</td>
                  </tr>
                ))}
              </tbody>
            </TableShell>
          ) : (
            <p className="text-xs text-neutral-400">Henüz kayıtlı hesap eşlemesi yok.</p>
          )}

          {canMapAccounts && bankAccountsRes.rows.length > 0 ? (
            <form
              action={saveAccountMappingAction}
              className="mt-3 grid grid-cols-2 gap-2 rounded border border-neutral-800 bg-neutral-950/60 p-3 text-xs"
            >
              <input type="hidden" name="provider" value="parasut" />
              <input
                name="externalAccountId"
                required
                placeholder="Paraşüt Hesap ID (ör. 1042)"
                className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5"
              />
              <input
                name="externalAccountName"
                placeholder="Paraşüt Hesap Adı"
                className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5"
              />
              <input
                name="externalIban"
                placeholder="TR IBAN (opsiyonel)"
                className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5"
              />
              <select
                name="externalCurrency"
                defaultValue="TRY"
                className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5"
              >
                <option value="TRY">TRY</option>
                <option value="USD">USD</option>
                <option value="EUR">EUR</option>
                <option value="GBP">GBP</option>
              </select>
              <select
                name="bankAccountId"
                required
                className="col-span-2 rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5"
              >
                {bankAccountsRes.rows.map((ba) => (
                  <option key={ba.id} value={ba.id}>
                    {ba.name} ({ba.currency}) {ba.iban ? `— ${ba.iban}` : ""}
                  </option>
                ))}
              </select>
              <button
                type="submit"
                className="col-span-2 rounded bg-sky-700 px-3 py-1.5 font-medium text-white"
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
              className="grid gap-2 rounded border border-neutral-800 bg-neutral-950/60 p-3 text-xs"
            >
              <label className="text-neutral-300">Hedef MAS Banka Hesabı</label>
              <select
                name="bankAccountId"
                required
                className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5"
              >
                {bankAccountsRes.rows.map((ba) => (
                  <option key={ba.id} value={ba.id}>
                    {ba.name} ({ba.currency}) {ba.iban ? `— ${ba.iban}` : ""}
                  </option>
                ))}
              </select>
              <label className="text-neutral-300">
                Ekstre Dosyası (`.mt940`, `.sta`, `.xml` camt.053, `.xlsx`, `.csv`)
              </label>
              <input
                type="file"
                name="file"
                required
                accept=".mt940,.sta,.940,.xml,.xlsx,.csv,.txt"
                className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5"
              />
              <button
                type="submit"
                className="rounded bg-emerald-700 px-3 py-1.5 font-medium text-white"
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

      {/* 4) Son Senkronizasyon Koşuları */}
      <Panel
        title="SON SENKRONİZASYON KOŞULARI VE SHA-256 KANIT SOYKÜTÜĞÜ"
        subtitle="Her senkron koşusu yüksek su izi (watermark - 24 saat örtüşme penceresi) ve ham JSON SHA-256 özetleriyle kaydedilir."
      >
        {syncRunsRes.rows.length > 0 ? (
          <TableShell>
            <thead>
              <tr>
                <th>Bağlantı</th>
                <th>Başlangıç</th>
                <th>Bitiş</th>
                <th>Watermark Penceresi</th>
                <th>Durum</th>
                <th>Çekilen</th>
                <th>Upsert</th>
                <th>Cari Aday</th>
                <th>Hata Özeti</th>
              </tr>
            </thead>
            <tbody>
              {syncRunsRes.rows.map((r) => (
                <tr key={r.id}>
                  <td className="font-medium">{r.integration_name}</td>
                  <td className="font-mono text-xs">{r.started_at}</td>
                  <td className="font-mono text-xs">{r.finished_at ?? "—"}</td>
                  <td className="font-mono text-xs">
                    {r.watermark_from ?? "—"} → {r.watermark_to ?? "—"}
                  </td>
                  <td>
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
                  <td className="font-mono text-xs">{r.fetched_count}</td>
                  <td className="font-mono text-xs">{r.upserted_count}</td>
                  <td className="font-mono text-xs">{r.staged_party_count}</td>
                  <td className="max-w-xs truncate text-xs text-red-300">{r.error_summary ?? "—"}</td>
                </tr>
              ))}
            </tbody>
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
