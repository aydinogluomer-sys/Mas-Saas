// Faz 16 — operational diagnostics. A separate sub-page in the pattern of system/security and
// system/backup; it does NOT modify src/app/(dashboard)/system/page.tsx, which keeps its own
// KPI role (app/db/version/decision confidence).
//
// Everything shown here is configuration and identity, never content: no secret values (only
// set/unset), no financial rows, no connection strings, no tokens.
import type { Pool } from "pg";
import { getPool } from "@/lib/db";
import { cache } from "@/lib/cache/engine";
import { Panel } from "@/components/ui/panel";
import { Badge } from "@/components/ui/badge";
import { KpiCard, PageHeader, TableShell } from "@/components/ui/shell";
import { requireAdmin } from "@/lib/auth";
import { env, envPresence } from "@/lib/env";
import { refreshDiagnosticsAction } from "./actions";

export const dynamic = "force-dynamic";

interface RoleIdentity {
  current_user: string;
  rolsuper: boolean | null;
  rolbypassrls: boolean | null;
}

/**
 * Migration defteri — okunabiliyorsa değerler, okunamıyorsa NEDEN okunamadığı.
 *
 * NE ÖLÇÜLDÜ. Bu sayfa `public.schema_migrations`'ı doğrudan sorguluyordu ve admin olarak
 * açıldığında ÇÖKÜYORDU:
 *
 *   ⨯ error: permission denied for table schema_migrations
 *     at … app/(dashboard)/system/diagnostics/page.js
 *
 * Bu bir yetki REGRESYONU değil, bilinçli bir tasarım kararı: `src/lib/authz/matrix.ts`
 * defteri "ledger" sınıfına koyar ve yorumu açıkça şunu der — "schema_migrations — owner
 * connection only. No tier has any access at all." `matrix.test.ts` de her rol için erişimin
 * KAPALI olduğunu doğrular. Yani doğru olan politika değil, SAYFAYDI: uygulama katmanının hiçbir
 * zaman okuyamayacağı bir tabloyu koşulsuz okuyordu.
 *
 * Mevcut `to_regclass(...) is not null` koruması yalnız "tablo YOK" hâlini düşünmüştü; "tablo VAR
 * ama bu katmana KAPALI" hâlini değil. İkisi aynı şey değildir ve ekranda da aynı görünmemeli:
 * defteri "defter yok" diye göstermek, 87 migration'ı uygulanmış bir veritabanı için düpedüz
 * yanlış bilgi olurdu. Bu yüzden üçüncü bir durum vardır ve ekrana o yazılır.
 *
 * Yalnız 42501 (insufficient_privilege) yutulur. Başka her hata yükselir — bağlantı kopması ya
 * da bozuk şema, sessizce "okunamadı" diye gösterilmesi gereken şeyler değildir.
 */
type MigrationLedger =
  | { readable: true; version: string | null; applied_at: string | null; total: number }
  | { readable: false; reason: string };

async function readMigrationLedger(pool: Pool): Promise<MigrationLedger> {
  try {
    const res = await pool.query<{ version: string | null; applied_at: string | null; total: number }>(
      // to_regclass keeps this from throwing on a database that predates the ledger (0020).
      `select max(version) as version,
              max(applied_at)::text as applied_at,
              count(*)::int as total
         from public.schema_migrations
        where to_regclass('public.schema_migrations') is not null`,
    );
    const row = res.rows[0];
    return { readable: true, version: row?.version ?? null, applied_at: row?.applied_at ?? null, total: row?.total ?? 0 };
  } catch (error) {
    if ((error as { code?: string }).code === "42501") {
      return { readable: false, reason: "uygulama katmanına kapalı (yalnız owner bağlantısı)" };
    }
    throw error;
  }
}

export default async function DiagnosticsPage() {
  // Admin-only: an operator reaching this URL is redirected before any query runs.
  await requireAdmin();
  const pool = getPool();

  const [roleRes, ledger, policyRes] = await Promise.all([
    cache.withCache("system:diagnostics:role", () =>
      pool.query<RoleIdentity>(
        `select current_user,
                (select rolsuper from pg_roles where rolname = current_user) as rolsuper,
                (select rolbypassrls from pg_roles where rolname = current_user) as rolbypassrls`,
      ),
    ),
    cache.withCache("system:diagnostics:ledger", () => readMigrationLedger(pool)),
    cache.withCache("system:diagnostics:policies", () =>
      pool.query<{ tablename: string; policyname: string }>(
        `select tablename, policyname from pg_policies
          where schemaname = 'public' and tablename in ('users','sessions')
          order by tablename, policyname`,
      ),
    ),
  ]);

  const role = roleRes.rows[0];
  const presence = envPresence();

  const isLeastPrivilege = role.rolsuper === false && role.rolbypassrls === false;
  const policyNames = new Set(policyRes.rows.map((r) => `${r.tablename}.${r.policyname}`));
  const expectedPolicies = [
    "users.users_deny_all",
    "users.users_app_runtime",
    "sessions.sessions_deny_all",
    "sessions.sessions_app_runtime",
  ];
  const missingPolicies = expectedPolicies.filter((p) => !policyNames.has(p));

  const missingRequired = presence.filter((p) => p.required && !p.set);

  return (
    <>
      <PageHeader
        title="Tanılama"
        subtitle="Ortam değişkenleri, migration defteri, veritabanı rol kimliği"
        action={
          <form action={refreshDiagnosticsAction}>
            <button className="button-accent px-3 py-2">Yenile</button>
          </form>
        }
      />

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <KpiCard
          label="DB rolü"
          value={role.current_user}
          tone={isLeastPrivilege ? "pos" : "neg"}
        />
        <KpiCard
          label="Yetki"
          value={isLeastPrivilege ? "düşük yetkili" : "YÜKSEK YETKİLİ"}
          tone={isLeastPrivilege ? "pos" : "neg"}
        />
        <KpiCard label="Migration" value={ledger.readable ? (ledger.version ?? "defter yok") : "okunamıyor"} />
        <KpiCard
          label="Zorunlu env"
          value={missingRequired.length === 0 ? "tam" : `${missingRequired.length} eksik`}
          tone={missingRequired.length === 0 ? "pos" : "neg"}
        />
      </div>

      {!isLeastPrivilege && (
        <p className="border border-neg bg-neg/10 p-2 text-sm text-neg">
          Uygulama superuser veya BYPASSRLS yetkili bir rolle bağlı. Bu durumda RLS politikaları
          fiilen devre dışıdır. Faz 15 adımları (`pnpm db:app-role:password`, `pnpm db:migrate`,
          `.env.local` içinde DATABASE_URL) tamamlanmamış olabilir.
        </p>
      )}

      <Panel title="Veritabanı rol kimliği">
        <div className="grid gap-1 text-sm">
          <Row label="current_user" value={role.current_user} />
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
            <Row label="Son sürüm" value={ledger.version ?? "—"} />
            <Row label="Kayıtlı migration" value={String(ledger.total)} />
            <Row label="Son uygulama" value={ledger.applied_at ?? "—"} />
          </div>
        ) : (
          // Sessiz başarısızlık YOK: ekran neyin olmadığını, NEDEN olmadığını ve nereden
          // okunabileceğini söyler. "defter yok" demek 87 migration'ı olan bir veritabanı için
          // yanlış bilgi olurdu.
          <p className="text-sm text-tone-2">
            Migration defteri {ledger.reason}. Bu, tasarım gereğidir: uygulama rolünün
            <span className="font-mono"> public.schema_migrations</span> üzerinde hiçbir yetkisi
            yoktur. Defteri görmek için owner bağlantısıyla{" "}
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
        {/* Deliberately not fetched: this panel makes no outbound network call. Showing a live
            GitHub Actions status would mean giving an internal finance panel egress and a
            token, which is a bigger change than the value it adds. The commit above is the
            honest local answer to "which build is this"; the run itself is in the Actions tab. */}
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
