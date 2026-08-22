import { getPool } from "@/lib/db";
import { Panel } from "@/components/ui/panel";
import { Badge, type Tone } from "@/components/ui/badge";
import { KpiCard, PageHeader, TableShell } from "@/components/ui/shell";
import { requireAdmin } from "@/lib/auth";
import { listUsers } from "@/lib/users/engine";
import { APP_ROLES, ROLE_LABEL } from "@/lib/authz/matrix";
import {
  activateUserAction,
  createUserAction,
  deactivateUserAction,
  resetPasswordAction,
  setRoleAction,
  unlockUserAction,
} from "./actions";

export const dynamic = "force-dynamic";

const fmt = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleString("tr-TR", { timeZone: "Europe/Istanbul", dateStyle: "short", timeStyle: "short" }) : "—";


// Tier colouring: the two tiers that can change money or accounts are visually distinct from
// the ones that cannot, so a wrong assignment is noticeable in the list rather than only in
// an audit log.
const ROLE_TONE: Record<string, Tone> = {
  viewer: "neutral",
  finance_operator: "blue",
  finance_approver: "amber",
  finance_manager: "amber",
  admin: "violet",
};

export default async function SecurityPage() {
  // Admin-only: an operator reaching this URL is redirected before any user data is read.
  const admin = await requireAdmin();
  const pool = getPool();
  const [counts, users] = await Promise.all([
    pool.query<{ active_users: number; admin_users: number }>(
      `select count(*) filter (where is_active)::int as active_users,
              count(*) filter (where is_active and role = 'admin')::int as admin_users
         from public.users`,
    ),
    listUsers(pool),
  ]);
  const { active_users, admin_users } = counts.rows[0];

  return (
    <>
      <PageHeader title="Erişim ve Güvenlik" subtitle="Hesaplar, oturumlar ve uygulamanın güvenlik sınırları" />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <KpiCard label="Aktif kullanıcı" value={active_users} tone="pos" />
        <KpiCard label="Admin" value={admin_users} tone={admin_users > 0 ? "pos" : "warn"} />
        <KpiCard label="Açık oturum" value={users.reduce((n, u) => n + u.activeSessions, 0)} />
      </div>

      <Panel title="Kullanıcılar">
        <TableShell>
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className="text-left">Kullanıcı</th>
                <th className="text-left">Rol</th>
                <th className="text-left">Durum</th>
                <th className="text-left">Son görülme</th>
                <th className="text-left">İşlem</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const locked = u.lockedUntil != null && new Date(u.lockedUntil).getTime() > Date.now();
                const isSelf = u.id === admin.id;
                return (
                  <tr key={u.id}>
                    <td>
                      <div className="text-tone-1">{u.displayName}</div>
                      <div className="font-mono text-[10px] text-tone-3">
                        {u.username}
                        {isSelf && " · siz"}
                      </div>
                    </td>
                    <td>
                      <Badge tone={ROLE_TONE[u.role] ?? "neutral"}>{ROLE_LABEL[u.role] ?? u.role}</Badge>
                    </td>
                    <td>
                      <span className="flex flex-wrap gap-1">
                        <Badge tone={u.isActive ? "green" : "neutral"}>{u.isActive ? "aktif" : "pasif"}</Badge>
                        {locked && <Badge tone="red">kilitli</Badge>}
                        {u.activeSessions > 0 && <Badge tone="blue">{u.activeSessions} oturum</Badge>}
                      </span>
                    </td>
                    <td className="font-mono text-[11px] tabular-nums text-tone-2">{fmt(u.lastSeenAt)}</td>
                    <td>
                      <div className="flex flex-wrap items-center gap-2">
                        <form action={resetPasswordAction} className="flex items-center gap-1">
                          <input type="hidden" name="id" value={u.id} />
                          <input
                            required
                            type="password"
                            name="password"
                            minLength={12}
                            autoComplete="new-password"
                            placeholder="yeni parola"
                            className="field-control w-32 px-2 py-1 font-mono text-[11px]"
                          />
                          <button className="button-ghost px-2 py-1">sıfırla</button>
                        </form>

                        {/* Faz 24B: five tiers cannot be a two-way toggle any more — the
                            operator picks the tier explicitly and submits it. */}
                        {!isSelf && (
                          <form action={setRoleAction} className="flex items-center gap-1">
                            <input type="hidden" name="id" value={u.id} />
                            <select name="role" defaultValue={u.role} className="field-control px-1 py-0.5 text-[10px]">
                              {APP_ROLES.map((r) => (
                                <option key={r} value={r}>{ROLE_LABEL[r]}</option>
                              ))}
                            </select>
                            <button className="button-ghost px-2 py-1">rolü değiştir</button>
                          </form>
                        )}

                        {locked && (
                          <form action={unlockUserAction}>
                            <input type="hidden" name="id" value={u.id} />
                            <button className="button-ghost px-2 py-1">kilidi aç</button>
                          </form>
                        )}

                        {u.isActive ? (
                          !isSelf && (
                            <form action={deactivateUserAction}>
                              <input type="hidden" name="id" value={u.id} />
                              <button className="button-ghost px-2 py-1 text-neg">pasifleştir</button>
                            </form>
                          )
                        ) : (
                          <form action={activateUserAction}>
                            <input type="hidden" name="id" value={u.id} />
                            <button className="button-ghost px-2 py-1">aktifleştir</button>
                          </form>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableShell>
        <p className="mt-2 font-mono text-[10px] text-tone-4">
          Sistem tarafından ayrılmış hesaplar (otomatik araçların denetim kimliği) bu listede gösterilmez.
        </p>
      </Panel>

      <Panel title="Yeni kullanıcı">
        <form action={createUserAction} className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-wider text-tone-3">Kullanıcı adı</span>
            <input
              required
              name="username"
              pattern="[a-z0-9_.\-]{3,32}"
              autoComplete="off"
              placeholder="ör. mehmet"
              className="field-control px-2 py-1.5 font-mono text-xs"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-wider text-tone-3">Görünen ad</span>
            <input required name="displayName" placeholder="ör. Mehmet Yılmaz" className="field-control px-2 py-1.5 text-xs" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-wider text-tone-3">Rol</span>
            {/* Least privilege by default: a new account starts as izleyici and is raised
                deliberately, matching the column default set in migration 0056. */}
            <select name="role" defaultValue="viewer" className="field-control px-2 py-1.5 text-xs">
              {APP_ROLES.map((r) => (
                <option key={r} value={r}>{ROLE_LABEL[r]}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-wider text-tone-3">Parola (en az 12)</span>
            <input
              required
              type="password"
              name="password"
              minLength={12}
              autoComplete="new-password"
              className="field-control px-2 py-1.5 font-mono text-xs"
            />
          </label>
          <div className="sm:col-span-2 lg:col-span-4">
            <button className="button-accent px-3 py-2">kullanıcı oluştur</button>
          </div>
        </form>
        <p className="mt-2 text-[11px] text-tone-3">
          Parola yalnız argon2id özeti olarak saklanır; hiçbir yerde düz metin tutulmaz ve denetim kaydına yazılmaz.
          Parolayı kullanıcıya ayrı bir kanaldan iletin.
        </p>
      </Panel>

      <Panel title="Güvenlik sınırları">
        <ul className="list-disc space-y-2 pl-5 text-sm text-tone-3">
          <li>Her hesabın kendi parolası argon2id ile hash&apos;lenmiş olarak saklanır — düz metin hiçbir yerde tutulmaz.</li>
          <li>Oturumlar veritabanında tutulur (rastgele, tahmin edilemeyen token); çıkış yapmak veya parola sıfırlamak oturumu gerçekten geçersiz kılar.</li>
          <li>5 başarısız girişten sonra hesap 15 dakika kilitlenir.</li>
          <li>Roller: admin (kullanıcı yönetimi + tüm erişim) ve operatör (yalnız dashboard erişimi).</li>
          <li>En az bir aktif admin kalmalı — bu kural veritabanı seviyesinde zorunlu tutulur, arayüzde değil.</li>
          <li>Her mutasyon gerçek kullanıcı kimliğiyle denetim kaydına (audit_logs) yazılır.</li>
          <li>/health ve /version izleme amacıyla sır paylaşmadan çalışır.</li>
        </ul>
      </Panel>
    </>
  );
}
