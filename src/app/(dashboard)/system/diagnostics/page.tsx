// Faz 16 / Faz 62 — operational diagnostics. A separate sub-page in the pattern of system/security and
// system/backup; it does NOT modify src/app/(dashboard)/system/page.tsx, which keeps its own
// KPI role (app/db/version/decision confidence).
//
// Everything shown here is configuration and identity, never content: no secret values (only
// set/unset), no financial rows, no connection strings, no tokens.
import type { Pool } from "pg";
import { getPool } from "@/lib/db";
import { readExpectedSchemaManifest } from "@/lib/db/schema-parity";
import { Panel } from "@/components/ui/panel";
import { Badge } from "@/components/ui/badge";
import { KpiCard, PageHeader, TableShell } from "@/components/ui/shell";
import { requireAdmin } from "@/lib/auth";
import { requireRouteAccess } from "@/lib/authz/route-guard";
import { env, envPresence } from "@/lib/env";
import {
  importStaleAlert,
  jobsStuckAlert,
  ledgerAlert,
  reconciliationAlert,
  runtimeIdentityAlert,
} from "@/lib/ops/telemetry-alerts";
import {
  formatAlertMessage,
  parseAlertChannels,
  type TelemetryAlert,
} from "@/lib/ops/alert-delivery";
import { refreshDiagnosticsAction } from "./actions";

export const dynamic = "force-dynamic";

interface RoleIdentity {
  current_user: string;
  session_user: string;
  session_rolsuper: boolean | null;
  session_rolbypassrls: boolean | null;
  rolsuper: boolean | null;
  rolbypassrls: boolean | null;
}

type MigrationLedger =
  | {
      readable: true;
      version: string | null;
      applied_at: string | null;
      total: number;
      checksum_digest: string | null;
    }
  | { readable: false; reason: string };

async function readLedgerSummary(pool: Pool): Promise<MigrationLedger> {
  try {
    const rpcRes = await pool.query<{
      migration_count: number;
      latest_version: string | null;
      checksum_digest: string | null;
      last_applied_at: string | null;
    }>(
      `select migration_count,
              latest_version,
              checksum_digest,
              last_applied_at::text as last_applied_at
         from public.get_schema_ledger_summary()`,
    );
    const row = rpcRes.rows[0];
    if (row) {
      return {
        readable: true,
        version: row.latest_version ?? null,
        applied_at: row.last_applied_at ?? null,
        total: Number(row.migration_count ?? 0),
        checksum_digest: row.checksum_digest ?? null,
      };
    }
  } catch {
    // Fallback to direct table read below when RPC is absent (e.g. pre-0122 owner connection).
  }

  try {
    const res = await pool.query<{ version: string | null; applied_at: string | null; total: number }>(
      `select max(version) as version,
              max(applied_at)::text as applied_at,
              count(*)::int as total
         from public.schema_migrations
        where to_regclass('public.schema_migrations') is not null`,
    );
    const row = res.rows[0];
    return {
      readable: true,
      version: row?.version ?? null,
      applied_at: row?.applied_at ?? null,
      total: row?.total ?? 0,
      checksum_digest: null,
    };
  } catch (error) {
    if ((error as { code?: string }).code === "42501") {
      return { readable: false, reason: "uygulama katmanına kapalı (get_schema_ledger_summary eksik)" };
    }
    return { readable: false, reason: "şema defteri sorgusu başarısız oldu" };
  }
}

export default async function DiagnosticsPage() {
  const denied = await requireRouteAccess("/system/diagnostics");
  if (denied) return denied;
  await requireAdmin();
  const pool = getPool();

  const [roleRes, ledger, policyRes, stuckRes, importAgeRes, reconRes] = await Promise.all([
    pool.query<RoleIdentity>(
      `select current_user,
              session_user,
              (select rolsuper from pg_roles where rolname = session_user) as session_rolsuper,
              (select rolbypassrls from pg_roles where rolname = session_user) as session_rolbypassrls,
              (select rolsuper from pg_roles where rolname = current_user) as rolsuper,
              (select rolbypassrls from pg_roles where rolname = current_user) as rolbypassrls`,
    ),
    readLedgerSummary(pool),
    pool.query<{ tablename: string; policyname: string }>(
      `select tablename, policyname from pg_policies
        where schemaname = 'public' and tablename in ('users','sessions')
        order by tablename, policyname`,
    ),
    pool
      .query<{ cnt: string }>(
        `select count(*)::text as cnt from public.background_jobs
          where status = 'running' and started_at < now() - interval '30 minutes'`,
      )
      .catch(() => ({ rows: [{ cnt: "?" }] })),
    pool
      .query<{ age_days: string | null }>(
        `select floor(extract(epoch from (now() - max(imported_at))) / 86400)::int::text as age_days
           from public.source_workbooks`,
      )
      .catch(() => ({ rows: [{ age_days: "?" }] })),
    pool
      .query<{ cnt: string }>(
        `select count(*)::text as cnt from public.treasury_cashflow_reconciliation
          where abs(coalesce(difference, 0)) > 0.01`,
      )
      .catch(() => ({ rows: [{ cnt: "?" }] })),
  ]);

  const role = roleRes.rows[0];
  const presence = envPresence();
  const expectedManifest = readExpectedSchemaManifest();
  const expectedLedgerStr =
    expectedManifest.expectedCount > 0 && expectedManifest.expectedLatestVersion !== "?"
      ? `${expectedManifest.expectedCount}/${expectedManifest.expectedLatestVersion}`
      : "?";
  const actualLedgerStr = ledger.readable
    ? `${ledger.total}/${ledger.version ?? "yok"}`
    : "?";
  const isSchemaAligned = !ledgerAlert(actualLedgerStr, expectedLedgerStr);

  const isLeastPrivilege =
    role.session_user === "mas_radar_app" &&
    role.session_rolsuper === false &&
    role.session_rolbypassrls === false &&
    role.rolsuper === false &&
    role.rolbypassrls === false;

  const policyNames = new Set(policyRes.rows.map((r) => `${r.tablename}.${r.policyname}`));
  const expectedPolicies = [
    "users.users_deny_all",
    "users.users_app_runtime",
    "sessions.sessions_deny_all",
    "sessions.sessions_app_runtime",
  ];
  const missingPolicies = expectedPolicies.filter((p) => !policyNames.has(p));

  const missingRequired = presence.filter((p) => p.required && !p.set);

  // Evaluate Faz 12 / Aşama 09 / Faz 62 fail-closed telemetry predicates
  const stuckCountStr = stuckRes.rows[0]?.cnt ?? "?";
  const importAgeStr = importAgeRes.rows[0]?.age_days ?? "İÇE AKTARIM YOK";
  const reconMismatchStr = reconRes.rows[0]?.cnt ?? "?";

  const telemetrySignals: Array<{
    signal: string;
    section: string;
    value: string;
    threshold: string;
    severity: "P0" | "P1" | "P2";
    alert: boolean;
    message: string;
  }> = [
    {
      signal: "runtime_db_identity",
      section: "RUNTIME",
      value: `${role.session_user} → ${role.current_user}`,
      threshold: "session=mas_radar_app (NOBYPASSRLS / NOSUPERUSER)",
      severity: "P0",
      alert: runtimeIdentityAlert(role.session_user) || !isLeastPrivilege,
      message: "Fiziksel uygulama bağlantısı (session_user) düşük yetkili mas_radar_app rolü olmalı.",
    },
    {
      signal: "schema_ledger_parity",
      section: "DB",
      value: actualLedgerStr,
      threshold: expectedLedgerStr,
      severity: "P0",
      alert: !isSchemaAligned,
      message: "Veritabanı migration defteri diskteki supabase/migrations manifestiyle birebir örtüşmeli.",
    },
    {
      signal: "jobs_stuck_running",
      section: "APP",
      value: stuckCountStr,
      threshold: "0 takılı iş (>30dk)",
      severity: "P1",
      alert: jobsStuckAlert(stuckCountStr),
      message: "30 dakikadan uzun süredir 'running' durumunda kalan arka plan işi (? = sorgu hatası).",
    },
    {
      signal: "workbook_import_age_days",
      section: "APP",
      value:
        importAgeStr === "?" || importAgeStr === "İÇE AKTARIM YOK"
          ? importAgeStr
          : `${importAgeStr} gün`,
      threshold: "≤ 14 gün",
      severity: "P2",
      alert: importStaleAlert(importAgeStr, 14),
      message: "Son çalışma kitabı içe aktarımının üzerinden geçen gün sayısı (? = sorgu hatası).",
    },
    {
      signal: "treasury_cashflow_reconciliation",
      section: "APP",
      value: reconMismatchStr === "?" ? "? (okunamadı)" : `${reconMismatchStr} fark satırı`,
      threshold: "0 mutabakat farkı",
      severity: "P1",
      alert: reconciliationAlert(reconMismatchStr),
      message: "Hazine ve nakit akışı mutabakat görünümünde fark bulunan dönem sayısı (? = sorgu hatası, 0 sayılmaz).",
    },
  ];

  const activeAlerts: TelemetryAlert[] = telemetrySignals
    .filter((s) => s.alert)
    .map(({ signal, section, value, threshold, severity, message }) => ({
      signal,
      section,
      value,
      threshold,
      severity,
      message,
    }));
  const channelConfig = parseAlertChannels(undefined);
  const formattedWireMessage = formatAlertMessage("ui-diagnostics", activeAlerts);

  return (
    <>
      <PageHeader
        title="Tanılama"
        subtitle="Ortam değişkenleri, migration defteri, veritabanı rol kimliği ve fail-closed telemetri alarmları"
        action={
          <form action={refreshDiagnosticsAction}>
            <button className="button-accent px-3 py-2">Yenile</button>
          </form>
        }
      />

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <KpiCard
          label="DB rolü"
          value={role.session_user}
          note={`aktif: ${role.current_user}`}
          tone={isLeastPrivilege ? "pos" : "neg"}
        />
        <KpiCard
          label="Yetki"
          value={isLeastPrivilege ? "düşük yetkili" : "YÜKSEK YETKİLİ"}
          tone={isLeastPrivilege ? "pos" : "neg"}
        />
        <KpiCard
          label="Migration"
          value={ledger.readable ? actualLedgerStr : "okunamıyor"}
          note={`beklenen: ${expectedLedgerStr}`}
          tone={isSchemaAligned ? "pos" : "neg"}
        />
        <KpiCard
          label="Zorunlu env"
          value={missingRequired.length === 0 ? "tam" : `${missingRequired.length} eksik`}
          tone={missingRequired.length === 0 ? "pos" : "neg"}
        />
      </div>

      {!isLeastPrivilege && (
        <p className="border border-neg bg-neg/10 p-2 text-sm text-neg">
          Uygulama `mas_radar_app` dışı, superuser veya BYPASSRLS yetkili bir rolle bağlı
          (`session_user={role.session_user}`). Bu durumda RLS politikaları fiilen devre dışıdır.
          Faz 15 adımları (`pnpm db:app-role:password`, `pnpm db:migrate`, `.env.local` içinde
          DATABASE_URL) tamamlanmamış olabilir.
        </p>
      )}

      <Panel
        title="FAIL-CLOSED TELEMETRİ ALARMLARI & TESLİMAT KANALLARI (FAZ 12 / AŞAMA 09)"
        subtitle={`Aktif kanallar: ${channelConfig.channels.join(", ")} · "Bilinmiyor" (?) değeri her zaman alarm üretir`}
      >
        <TableShell>
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-line text-left font-mono text-[10px] uppercase text-tone-3">
                <th className="py-1.5 pr-2">Bölüm</th>
                <th className="py-1.5 pr-2">Sinyal</th>
                <th className="py-1.5 pr-2">Ölçülen Değer</th>
                <th className="py-1.5 pr-2">Eşik</th>
                <th className="py-1.5 pr-2">Seviye</th>
                <th className="py-1.5 pr-2">Durum</th>
                <th className="py-1.5">Açıklama</th>
              </tr>
            </thead>
            <tbody>
              {telemetrySignals.map((s) => (
                <tr key={s.signal} className="border-b border-line-faint">
                  <td className="py-1.5 pr-2 font-mono text-tone-3">{s.section}</td>
                  <td className="py-1.5 pr-2 font-mono text-tone-1">{s.signal}</td>
                  <td className="py-1.5 pr-2 font-mono text-tone-2">{s.value}</td>
                  <td className="py-1.5 pr-2 font-mono text-tone-3">{s.threshold}</td>
                  <td className="py-1.5 pr-2">
                    <Badge tone={s.severity === "P0" ? "red" : s.severity === "P1" ? "amber" : "neutral"}>
                      {s.severity}
                    </Badge>
                  </td>
                  <td className="py-1.5 pr-2">
                    <Badge tone={s.alert ? "red" : "green"}>{s.alert ? "ALARM" : "TEMİZ"}</Badge>
                  </td>
                  <td className="py-1.5 text-tone-2">{s.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableShell>
        <div className="mt-2.5 border border-line bg-[var(--surface-2)] p-2 font-mono text-[11px] text-tone-2">
          <div className="mb-1 text-[10px] uppercase text-tone-3">Operatör Kanalı Önizlemesi (alert-delivery.ts):</div>
          <pre className="whitespace-pre-wrap">{formattedWireMessage}</pre>
        </div>
      </Panel>

      <Panel title="Veritabanı rol kimliği">
        <div className="grid gap-1 text-sm">
          <Row
            label="session_user"
            value={role.session_user}
            bad={role.session_user !== "mas_radar_app"}
          />
          <Row label="current_user" value={role.current_user} />
          <Row
            label="session_rolsuper"
            value={String(role.session_rolsuper)}
            bad={role.session_rolsuper !== false}
          />
          <Row
            label="session_rolbypassrls"
            value={String(role.session_rolbypassrls)}
            bad={role.session_rolbypassrls !== false}
          />
          <Row label="rolsuper" value={String(role.rolsuper)} bad={role.rolsuper !== false} />
          <Row label="rolbypassrls" value={String(role.rolbypassrls)} bad={role.rolbypassrls !== false} />
        </div>
        <div className="mt-3">
          <div className="font-mono text-[10px] uppercase text-tone-3">users / sessions RLS politikaları</div>
          {missingPolicies.length === 0 ? (
            <p className="mt-1 text-sm text-pos">Dördü de yerinde (deny_all + app_runtime).</p>
          ) : (
            <p className="mt-1 text-sm text-neg">Eksik: {missingPolicies.join(", ")}</p>
          )}
        </div>
      </Panel>

      <Panel title="Migration defteri">
        {ledger.readable ? (
          <div className="grid gap-1 text-sm">
            <Row
              label="Şema defteri (gerçek / beklenen)"
              value={`${actualLedgerStr} (beklenen: ${expectedLedgerStr})`}
              bad={!isSchemaAligned}
            />
            <Row label="Son sürüm" value={ledger.version ?? "—"} />
            <Row label="Kayıtlı migration" value={String(ledger.total)} />
            <Row label="Son uygulama" value={ledger.applied_at ?? "—"} />
            {ledger.checksum_digest ? (
              <Row label="Defter özeti (SHA-256)" value={`${ledger.checksum_digest.slice(0, 24)}…`} />
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-neg">
            Migration defteri okunamadı ({ledger.reason}). Şema doğrulaması için{" "}
            <span className="font-mono">pnpm db:migrate</span> ve{" "}
            <span className="font-mono">pnpm db:migrate:verify</span> çalıştırın.
          </p>
        )}
      </Panel>

      <Panel
        title="Ortam değişkenleri"
        subtitle="Yalnız tanımlı/tanımsız bilgisi gösterilir — değerler hiçbir şekilde okunmaz"
      >
        <TableShell>
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className="text-left">Değişken</th>
                <th className="text-left">Durum</th>
                <th className="text-left">Zorunlu</th>
                <th className="text-left">Not</th>
              </tr>
            </thead>
            <tbody>
              {presence.map((p) => (
                <tr key={p.name} className="border-b border-line-faint">
                  <td className="py-2 pr-2 font-mono text-xs">{p.name}</td>
                  <td className="py-2 pr-2">
                    <Badge tone={p.set ? "green" : p.required ? "red" : "neutral"}>
                      {p.set ? "tanımlı" : "tanımsız"}
                    </Badge>
                  </td>
                  <td className="py-2 pr-2 text-xs">{p.required ? "evet" : "hayır"}</td>
                  <td className="py-2 text-xs text-tone-3">{p.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableShell>
      </Panel>

      <Panel title="Sürüm ve CI">
        <div className="grid gap-1 text-sm">
          <Row label="APP_COMMIT_SHA" value={env.appCommitSha} />
          <Row label="APP_BUILD_TIME" value={env.appBuildTime} />
        </div>
        <p className="mt-2 text-xs text-tone-3">
          CI çalışma durumu buradan sorgulanmaz (panel dışarıya ağ isteği yapmaz). Workflow:{" "}
          <span className="font-mono">.github/workflows/ci.yml</span> — sonuçlar GitHub Actions
          sekmesindedir. Yukarıdaki commit, bu derlemenin hangi kaynaktan üretildiğini gösterir
          (ortam değişkeni verilmemişse &quot;unknown&quot;).
        </p>
      </Panel>
    </>
  );
}

function Row({ label, value, bad }: { label: string; value: string; bad?: boolean }) {
  return (
    <div className="grid grid-cols-[200px_1fr] gap-2 border-b border-line-faint py-1">
      <span className="font-mono text-[10px] uppercase text-tone-3">{label}</span>
      <span className={`font-mono text-xs ${bad ? "text-neg" : ""}`}>{value}</span>
    </div>
  );
}
