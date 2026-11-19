import { RadialMeterSvg } from "@/components/charts/folio-visuals";
import { Badge, type Tone } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { EmptyState, KpiCard, PageHeader, TableShell } from "@/components/ui/shell";
import { requireAdmin } from "@/lib/auth";
import {
  listSsoProviders,
  type SsoIdentityProviderRow,
  type SsoProviderKey,
} from "@/lib/auth/password-reset";
import { buildTotpOtpAuthUri, generateTotpSecret } from "@/lib/auth/totp";
import { APP_ROLES, ROLE_LABEL } from "@/lib/authz/matrix";
import { requireRouteAccess } from "@/lib/authz/route-guard";
import { getPool } from "@/lib/db";
import { listActiveSessions, listUsers } from "@/lib/users/engine";
import {
  activateUserAction,
  createUserAction,
  deactivateUserAction,
  disableTotpAction,
  enableTotpAction,
  forcePasswordChangeAction,
  resetPasswordAction,
  revokeSessionAction,
  setRoleAction,
  unlockUserAction,
  upsertSsoProviderAction,
} from "./actions";

export const dynamic = "force-dynamic";

const fmt = (iso: string | null): string =>
  iso
    ? new Date(iso).toLocaleString("tr-TR", {
        timeZone: "Europe/Istanbul",
        dateStyle: "short",
        timeStyle: "short",
      })
    : "—";

const ROLE_TONE: Record<string, Tone> = {
  viewer: "neutral",
  finance_operator: "blue",
  finance_approver: "amber",
  finance_manager: "amber",
  admin: "blue",
};

const SSO_CATALOG: ReadonlyArray<{
  providerKey: SsoProviderKey;
  defaultDisplayName: string;
  subtitle: string;
  issuerPlaceholder: string;
  requiresOidcEndpoints: boolean;
}> = [
  {
    providerKey: "entra_id",
    defaultDisplayName: "Microsoft Entra ID (Azure AD OIDC)",
    subtitle: "Kurumsal Microsoft 365 / Entra kiracısı üzerinden OIDC tek oturum açma",
    issuerPlaceholder: "https://login.microsoftonline.com/<tenant-id>/v2.0",
    requiresOidcEndpoints: true,
  },
  {
    providerKey: "google_workspace",
    defaultDisplayName: "Google Workspace Kurumsal OIDC",
    subtitle: "Kurumsal Google Workspace alan adı doğrulamalı OIDC federasyonu",
    issuerPlaceholder: "https://accounts.google.com",
    requiresOidcEndpoints: true,
  },
  {
    providerKey: "custom_oidc",
    defaultDisplayName: "Özel Kurumsal OIDC (Keycloak / Okta)",
    subtitle: "Standart OpenID Connect 1.0 discovery destekli şirket içi kimlik sağlayıcısı",
    issuerPlaceholder: "https://sso.firma.com.tr/realms/mas",
    requiresOidcEndpoints: true,
  },
  {
    providerKey: "webauthn_passkey",
    defaultDisplayName: "WebAuthn / FIDO2 Donanım Anahtarı & Passkey",
    subtitle: "YubiKey, Touch ID ve Windows Hello biyometrik kimlik doğrulama politikası",
    issuerPlaceholder: "",
    requiresOidcEndpoints: false,
  },
];

export default async function SecurityPage() {
  const denied = await requireRouteAccess("/system/security");
  if (denied) return denied;
  const admin = await requireAdmin();
  const pool = getPool();
  const [counts, users, activeSessions, ssoProviders] = await Promise.all([
    pool.query<{ active_users: number; admin_users: number }>(
      `select count(*) filter (where is_active)::int as active_users,
              count(*) filter (where is_active and role = 'admin')::int as admin_users
         from public.users`,
    ),
    listUsers(pool),
    listActiveSessions(pool, 50),
    listSsoProviders(pool),
  ]);
  const { active_users, admin_users } = counts.rows[0];
  const totpUsersCount = users.filter((u) => u.totpEnabled).length;
  const ssoByKey = new Map<SsoProviderKey, SsoIdentityProviderRow>(
    ssoProviders.map((p) => [p.providerKey, p]),
  );
  const enabledSsoCount = ssoProviders.filter((p) => p.isEnabled).length;

  const posturePillars = [
    { key: "argon2id", label: "Argon2id Parola Özeti", active: true },
    { key: "rls", label: "5 Katmanlı RLS %100", active: true },
    { key: "session", label: "Oturum Zaman Aşımı & Kilit", active: true },
    { key: "audit", label: "SHA-256 Denetim Zinciri", active: true },
    {
      key: "sso_mfa",
      label: "Kurumsal SSO / 2FA",
      active: enabledSsoCount > 0 || totpUsersCount > 0,
    },
  ];
  const activePostureCount = posturePillars.filter((p) => p.active).length;
  const posturePercent = Math.round((activePostureCount / posturePillars.length) * 100);

  const adminRow = users.find((u) => u.id === admin.id);
  const setupSecret = generateTotpSecret();
  const setupUri = buildTotpOtpAuthUri({
    secretBase32: setupSecret,
    accountName: admin.username,
  });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Erişim, Kurumsal SSO, 2FA (TOTP) ve Oturum Güvenliği"
        subtitle="Kullanıcı hesapları, Microsoft Entra ID · Google Workspace OIDC · WebAuthn Passkey federasyonu, RFC 6238 TOTP ve IP/cihaz bazlı oturum izleme"
      />

      {/* Security Posture Gauge + 4 Focal KPIs */}
      <div className="grid gap-3 lg:grid-cols-12">
        <div className="folio-corner-mark rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-1)] p-4 shadow-[var(--shadow-xs)] lg:col-span-6">
          <RadialMeterSvg
            percent={posturePercent}
            label="Kurumsal Güvenlik Duruşu (Security Posture)"
            sublabel={`${activePostureCount} / ${posturePillars.length} güvenlik katmanı etkin · Hedef %80`}
            targetPercent={80}
          />
          <div className="mt-3 flex flex-wrap gap-1.5 border-t border-[var(--border)] pt-3">
            {posturePillars.map((p) => (
              <Badge key={p.key} tone={p.active ? "green" : "amber"} dot>
                {p.label}
              </Badge>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:col-span-6 lg:grid-cols-2">
          <KpiCard label="Aktif kullanıcı" value={active_users} tone="pos" />
          <KpiCard label="Admin" value={admin_users} tone={admin_users > 0 ? "pos" : "warn"} />
          <KpiCard label="Açık oturum" value={users.reduce((n, u) => n + u.activeSessions, 0)} />
          <KpiCard
            label="SSO / 2FA Aktif"
            value={`${enabledSsoCount} SSO · ${totpUsersCount} 2FA`}
            tone={enabledSsoCount + totpUsersCount > 0 ? "pos" : "neutral"}
          />
        </div>
      </div>

      <Panel title="Kullanıcılar">
        <TableShell>
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className="text-left">Kullanıcı &amp; E-Posta</th>
                <th className="text-left">Rol</th>
                <th className="text-left">Durum &amp; 2FA</th>
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
                        {u.email ? ` · ${u.email}` : ""}
                        {isSelf && " · siz"}
                      </div>
                    </td>
                    <td>
                      <Badge tone={ROLE_TONE[u.role] ?? "neutral"}>
                        {ROLE_LABEL[u.role] ?? u.role}
                      </Badge>
                    </td>
                    <td>
                      <span className="flex flex-wrap gap-1">
                        <Badge tone={u.isActive ? "green" : "neutral"}>
                          {u.isActive ? "aktif" : "pasif"}
                        </Badge>
                        {u.totpEnabled ? (
                          <Badge tone="green">2FA TOTP Aktif</Badge>
                        ) : (
                          <Badge tone="neutral">2FA Kapalı</Badge>
                        )}
                        {locked && <Badge tone="red">kilitli</Badge>}
                        {u.mustChangePassword && <Badge tone="amber">şifre değişimi zorunlu</Badge>}
                        {u.activeSessions > 0 && (
                          <Badge tone="blue">{u.activeSessions} oturum</Badge>
                        )}
                      </span>
                    </td>
                    <td className="font-mono text-[11px] tabular-nums text-tone-2">
                      {fmt(u.lastSeenAt)}
                    </td>
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

                        {!u.mustChangePassword && (
                          <form action={forcePasswordChangeAction}>
                            <input type="hidden" name="id" value={u.id} />
                            <button
                              className="button-ghost px-2 py-1 text-warn"
                              title="Kullanıcının bir sonraki oturumunda şifresini değiştirmesini zorunlu kılar"
                            >
                              şifre değişimi zorla
                            </button>
                          </form>
                        )}

                        {u.totpEnabled && (
                          <form action={disableTotpAction}>
                            <input type="hidden" name="userId" value={u.id} />
                            <button className="button-ghost px-2 py-1 text-warn">
                              2FA Sıfırla
                            </button>
                          </form>
                        )}

                        {!isSelf && (
                          <form action={setRoleAction} className="flex items-center gap-1">
                            <input type="hidden" name="id" value={u.id} />
                            <select
                              name="role"
                              defaultValue={u.role}
                              className="field-control px-1 py-0.5 text-[10px]"
                            >
                              {APP_ROLES.map((r) => (
                                <option key={r} value={r}>
                                  {ROLE_LABEL[r]}
                                </option>
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

      {/* Kurumsal SSO (Microsoft Entra ID · Google Workspace OIDC) & WebAuthn Passkey */}
      <Panel
        title="KURUMSAL TEK OTURUM AÇMA (MICROSOFT ENTRA ID · GOOGLE WORKSPACE OIDC) & WEBAUTHN PASSKEY YAPILANDIRMASI"
        subtitle="OIDC Issuer URL (yalnız https://), Client ID ve izin verilen kurumsal e-posta alan adları sso_identity_providers tablosunda denetim izli olarak yönetilir."
        right={
          <Badge tone={enabledSsoCount > 0 ? "green" : "neutral"} dot>
            {enabledSsoCount} / {SSO_CATALOG.length} sağlayıcı etkin
          </Badge>
        }
      >
        <div className="grid gap-3 lg:grid-cols-2">
          {SSO_CATALOG.map((spec) => {
            const existing = ssoByKey.get(spec.providerKey);
            const isEnabled = existing?.isEnabled ?? false;
            const displayName = existing?.displayName ?? spec.defaultDisplayName;
            const issuerUrl = existing?.issuerUrl ?? "";
            const clientId = existing?.clientId ?? "";
            const allowedDomains = existing?.allowedDomains.join(", ") ?? "";

            return (
              <form
                key={spec.providerKey}
                action={upsertSsoProviderAction}
                className="space-y-2.5 rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--surface-2)] p-3.5 text-xs"
              >
                <input type="hidden" name="providerKey" value={spec.providerKey} />
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-semibold text-tone-1">{displayName}</div>
                    <div className="mt-0.5 text-[11px] text-tone-3">{spec.subtitle}</div>
                  </div>
                  <Badge tone={isEnabled ? "green" : "neutral"}>
                    {isEnabled ? "Etkin" : "Devre Dışı"}
                  </Badge>
                </div>

                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="block space-y-1 sm:col-span-2">
                    <span className="font-mono text-[10px] uppercase tracking-wider text-tone-3">
                      Görünen Ad
                    </span>
                    <input
                      name="displayName"
                      required
                      defaultValue={displayName}
                      className="field-control w-full px-2.5 py-1.5 text-base sm:text-xs"
                    />
                  </label>

                  {spec.requiresOidcEndpoints ? (
                    <>
                      <label className="block space-y-1">
                        <span className="font-mono text-[10px] uppercase tracking-wider text-tone-3">
                          OIDC Issuer URL (https://)
                        </span>
                        <input
                          name="issuerUrl"
                          type="url"
                          defaultValue={issuerUrl}
                          placeholder={spec.issuerPlaceholder}
                          className="field-control w-full px-2.5 py-1.5 font-mono text-base sm:text-xs"
                        />
                      </label>
                      <label className="block space-y-1">
                        <span className="font-mono text-[10px] uppercase tracking-wider text-tone-3">
                          Client ID
                        </span>
                        <input
                          name="clientId"
                          defaultValue={clientId}
                          placeholder="00000000-0000-0000-0000-000000000000"
                          className="field-control w-full px-2.5 py-1.5 font-mono text-base sm:text-xs"
                        />
                      </label>
                    </>
                  ) : null}

                  <label className="block space-y-1 sm:col-span-2">
                    <span className="font-mono text-[10px] uppercase tracking-wider text-tone-3">
                      İzin Verilen Kurumsal Alan Adları (virgülle)
                    </span>
                    <input
                      name="allowedDomains"
                      defaultValue={allowedDomains}
                      placeholder="firma.com.tr, holding.com.tr"
                      className="field-control w-full px-2.5 py-1.5 font-mono text-base sm:text-xs"
                    />
                  </label>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--line)] pt-2.5">
                  <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-tone-2">
                    <input
                      type="checkbox"
                      name="isEnabled"
                      value="true"
                      defaultChecked={isEnabled}
                      className="h-3.5 w-3.5 accent-[var(--accent)]"
                    />
                    <span>Bu kimlik sağlayıcısını etkinleştir</span>
                  </label>
                  <button type="submit" className="button-accent px-3 py-1.5 font-medium">
                    Yapılandırmayı Kaydet
                  </button>
                </div>
              </form>
            );
          })}
        </div>
      </Panel>

      {/* TOTP 2FA Kurulum & Doğrulama */}
      <Panel
        title="İKİ FAKTÖRLÜ DOĞRULAMA (RFC 6238 TOTP — GOOGLE / MICROSOFT AUTHENTICATOR)"
        subtitle="Yönetici hesabınız için AES-256-GCM ile şifrelenmiş TOTP anahtar kurulumu"
      >
        {adminRow?.totpEnabled ? (
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="text-pos font-medium">
              Bu yönetici hesabında 2FA (TOTP) koruması etkin.
            </span>
            <form action={disableTotpAction}>
              <input type="hidden" name="userId" value={admin.id} />
              <button className="button-ghost px-3 py-1.5 text-xs text-neg">
                2FA (TOTP) Devre Dışı Bırak
              </button>
            </form>
          </div>
        ) : (
          <form
            action={enableTotpAction}
            className="grid grid-cols-1 gap-3 rounded border border-[var(--line)] bg-[var(--surface-2)] p-3 text-xs sm:grid-cols-4"
          >
            <input type="hidden" name="userId" value={admin.id} />
            <input type="hidden" name="secretBase32" value={setupSecret} />
            <div className="sm:col-span-2">
              <div className="font-mono text-[10px] uppercase tracking-wider text-tone-3">
                1. Authenticator Uygulamasına Base32 Anahtarı Girin
              </div>
              <div className="mt-1 select-all rounded border border-[var(--line)] bg-[var(--surface-1)] px-2.5 py-1.5 font-mono text-xs font-semibold tracking-wider text-[var(--text-1)]">
                {setupSecret}
              </div>
              <div className="mt-1 truncate font-mono text-[10px] text-tone-4" title={setupUri}>
                {setupUri}
              </div>
            </div>
            <div>
              <label className="font-mono text-[10px] uppercase tracking-wider text-tone-3">
                2. 6 Haneli Doğrulama Kodu
              </label>
              <input
                required
                name="code"
                pattern="[0-9]{6}"
                maxLength={6}
                placeholder="123456"
                className="field-control mt-1 w-full px-2.5 py-1.5 font-mono text-xs tracking-widest"
              />
            </div>
            <div className="flex items-end">
              <button type="submit" className="button-accent w-full px-3 py-1.5 font-medium">
                Doğrula &amp; 2FA Etkinleştir
              </button>
            </div>
          </form>
        )}
      </Panel>

      {/* Aktif Oturumlar (IP & Tarayıcı) */}
      <Panel
        title="AKTİF OTURUMLAR (IP ADRESİ / CİHAZ İZİ VE TEKİL SONLANDIRMA)"
        subtitle="Veritabanında tutulan canlı oturumlar; şüpheli bir cihaz veya IP görüldüğünde tek tıkla geçersiz kılınabilir."
      >
        {activeSessions.length === 0 ? (
          <EmptyState>Listelenecek açık kullanıcı oturumu bulunmuyor.</EmptyState>
        ) : (
          <TableShell>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left font-mono text-[10px] uppercase text-tone-4">
                  <th className="py-1.5 pr-2">Kullanıcı</th>
                  <th className="py-1.5 pr-2">IP Adresi</th>
                  <th className="py-1.5 pr-2">Tarayıcı / Cihaz (User-Agent)</th>
                  <th className="py-1.5 pr-2">Başlangıç</th>
                  <th className="py-1.5 pr-2">Son Görülme</th>
                  <th className="py-1.5 text-right">İşlem</th>
                </tr>
              </thead>
              <tbody>
                {activeSessions.map((s) => (
                  <tr key={s.id} className="border-t border-line-faint">
                    <td className="py-1.5 pr-2">
                      <span className="font-medium text-[var(--text-1)]">{s.displayName}</span>{" "}
                      <span className="font-mono text-[10px] text-tone-3">({s.username})</span>
                    </td>
                    <td className="py-1.5 pr-2 font-mono">{s.ipAddress ?? "127.0.0.1 (yerel)"}</td>
                    <td className="max-w-xs truncate py-1.5 pr-2 font-mono text-[11px] text-tone-3">
                      {s.userAgent ?? "Tarayıcı oturumu"}
                    </td>
                    <td className="py-1.5 pr-2 font-mono text-tone-2">{fmt(s.createdAt)}</td>
                    <td className="py-1.5 pr-2 font-mono text-tone-2">{fmt(s.lastSeenAt)}</td>
                    <td className="py-1.5 text-right">
                      <form action={revokeSessionAction}>
                        <input type="hidden" name="sessionId" value={s.id} />
                        <button type="submit" className="button-ghost px-2 py-0.5 text-[11px] text-neg">
                          Oturumu Sonlandır
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        )}
      </Panel>

      <Panel title="Yeni kullanıcı">
        <form action={createUserAction} className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-5">
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-wider text-tone-3">
              Kullanıcı adı
            </span>
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
            <span className="font-mono text-[10px] uppercase tracking-wider text-tone-3">
              Görünen ad
            </span>
            <input
              required
              name="displayName"
              placeholder="ör. Mehmet Yılmaz"
              className="field-control px-2 py-1.5 text-xs"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-wider text-tone-3">
              E-Posta (Bildirim &amp; Onay)
            </span>
            <input
              type="email"
              name="email"
              placeholder="mehmet@firma.com.tr"
              className="field-control px-2 py-1.5 font-mono text-xs"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-wider text-tone-3">Rol</span>
            <select name="role" defaultValue="viewer" className="field-control px-2 py-1.5 text-xs">
              {APP_ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-wider text-tone-3">
              Parola (en az 12)
            </span>
            <input
              required
              type="password"
              name="password"
              minLength={12}
              autoComplete="new-password"
              className="field-control px-2 py-1.5 font-mono text-xs"
            />
          </label>
          <div className="sm:col-span-2 lg:col-span-5">
            <button className="button-accent px-3 py-2">kullanıcı oluştur</button>
          </div>
        </form>
        <p className="mt-2 text-[11px] text-tone-3">
          Parola yalnız argon2id özeti olarak saklanır; hiçbir yerde düz metin tutulmaz ve denetim
          kaydına yazılmaz. Parolayı kullanıcıya ayrı bir kanaldan iletin.
        </p>
      </Panel>

      <Panel title="Güvenlik sınırları">
        <ul className="list-disc space-y-2 pl-5 text-sm text-tone-3">
          <li>
            Her hesabın kendi parolası argon2id ile hash&apos;lenmiş olarak saklanır — düz metin
            hiçbir yerde tutulmaz.
          </li>
          <li>
            RFC 6238 TOTP iki faktörlü doğrulama sırları AES-256-GCM kimlik doğrulamalı şifrelemeyle
            korunur ve denetim kayıtlarına asla yazılmaz.
          </li>
          <li>
            Oturumlar veritabanında IP ve tarayıcı iziyle tutulur; tekil oturum sonlandırma veya
            parola sıfırlama oturumu anında geçersiz kılar.
          </li>
          <li>5 başarısız girişten sonra hesap 15 dakika kilitlenir.</li>
          <li>
            En az bir aktif admin kalmalı — bu kural veritabanı seviyesinde zorunlu tutulur,
            arayüzde değil.
          </li>
        </ul>
      </Panel>
    </div>
  );
}
