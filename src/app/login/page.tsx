import { redirect } from "next/navigation";
import { getCurrentUser, isStrictLoopbackRequest, safeRedirectPath } from "@/lib/auth";
import { env } from "@/lib/env";
import {
  completePasswordResetAction,
  loginAction,
  requestPasswordResetAction,
} from "./actions";
import { LocalWorkstationAutoLogin } from "./local-workstation-autologin";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    next?: string;
    autologin?: string;
    mode?: string;
    resetToken?: string;
    token?: string;
    reset?: string;
    resetError?: string;
  }>;
}) {
  const sp = await searchParams;
  const next = safeRedirectPath(sp.next, "/overview");
  if (await getCurrentUser()) redirect(next);

  if (
    !sp.error &&
    sp.autologin === "1" &&
    env.localWorkstationAutologin &&
    (await isStrictLoopbackRequest())
  ) {
    return <LocalWorkstationAutoLogin next={safeRedirectPath(sp.next, "/")} />;
  }

  const activeResetToken = (sp.resetToken ?? sp.token ?? "").trim();
  const openResetDrawer = Boolean(
    activeResetToken ||
      sp.mode === "reset" ||
      sp.reset === "sent" ||
      sp.reset === "rate" ||
      sp.resetError,
  );

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--bg)] px-4 py-10 text-[var(--ink)]">
      <div className="w-full max-w-md space-y-4 animate-rise">
        {/* Warm Archival Vellum Login Card */}
        <div className="folio-corner-mark rounded-[var(--radius-lg)] border border-[var(--border-strong)] bg-[var(--surface-1)] p-6 shadow-[var(--shadow-md)] sm:p-7">
          <div className="border-b border-[var(--border)] pb-4">
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--accent)]">
                KURUMSAL FİNANS DEFTERİ
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--surface-2)] px-2 py-0.5 font-mono text-[10px] text-[var(--ink-2)]">
                <span className="h-1.5 w-1.5 rounded-full bg-[var(--pos)]" />
                RLS · Argon2id
              </span>
            </div>
            <h1 className="mt-2 text-xl font-semibold tracking-[-0.02em] text-[var(--ink)]">
              MAS Nakit Radar
            </h1>
            <p className="mt-0.5 text-[12.5px] text-[var(--muted)]">
              Hazine, nakit akışı, mutabakat ve iç kontrol çalışma alanına giriş yapın.
            </p>
          </div>

          {sp.reset === "completed" ? (
            <div className="mt-4 rounded-[var(--radius-sm)] border border-[var(--pos-border)] bg-[var(--pos-bg)] px-3 py-2 text-[12px] font-medium text-[var(--pos)]">
              Parolanız güncellendi ve önceki oturumlar sonlandırıldı. Yeni parolanızla giriş yapabilirsiniz.
            </div>
          ) : null}

          <form action={loginAction} className="mt-5 space-y-3.5">
            <input type="hidden" name="next" value={next} />
            <label className="block space-y-1">
              <span className="font-mono text-[10.5px] font-medium uppercase tracking-[0.08em] text-[var(--ink-2)]">
                Kullanıcı adı
              </span>
              <input
                name="username"
                type="text"
                autoFocus={!openResetDrawer}
                autoComplete="username"
                className="field-control w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)]/55 px-3 py-2 font-mono text-base text-[var(--ink)] focus:border-[var(--accent)] focus:outline-none sm:text-sm"
              />
            </label>
            <label className="block space-y-1">
              <span className="font-mono text-[10.5px] font-medium uppercase tracking-[0.08em] text-[var(--ink-2)]">
                Parola
              </span>
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                className="field-control w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)]/55 px-3 py-2 font-mono text-base text-[var(--ink)] focus:border-[var(--accent)] focus:outline-none sm:text-sm"
              />
            </label>

            {sp.error === "rate" ? (
              <p className="rounded-[var(--radius-sm)] border border-[var(--neg-border)] bg-[var(--neg-bg)] px-2.5 py-1.5 font-mono text-[11px] text-[var(--neg)]">
                Çok fazla deneme yapıldı. Lütfen bir dakika bekleyip tekrar deneyin.
              </p>
            ) : (
              sp.error && (
                <p className="rounded-[var(--radius-sm)] border border-[var(--neg-border)] bg-[var(--neg-bg)] px-2.5 py-1.5 font-mono text-[11px] text-[var(--neg)]">
                  Kullanıcı adı veya parola hatalı.
                </p>
              )
            )}

            <button
              type="submit"
              className="w-full rounded-[var(--radius-sm)] border border-[var(--ink)] bg-[var(--ink)] px-3.5 py-2.5 font-mono text-[11.5px] font-semibold uppercase tracking-[0.1em] text-[var(--surface-1)] transition-opacity hover:opacity-90"
            >
              Giriş →
            </button>
          </form>

          {/* Self-Service Password Reset Drawer */}
          <details
            open={openResetDrawer}
            className="mt-5 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-2)]/50 p-3.5"
          >
            <summary className="cursor-pointer list-none font-mono text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--ink-2)] hover:text-[var(--ink)] [&::-webkit-details-marker]:hidden">
              Parolamı Unuttum (Self-Servis Sıfırlama) ▾
            </summary>

            <div className="mt-3 space-y-4 border-t border-[var(--border)] pt-3">
              {sp.reset === "sent" ? (
                <div className="rounded-[var(--radius-sm)] border border-[var(--info-border)] bg-[var(--info-bg)] px-3 py-2 text-[11.5px] text-[var(--info)]">
                  Hesap aktifse 30 dakika geçerli sıfırlama kodu tanımlı bildirim kanalına (e-posta / Telegram) iletildi.
                </div>
              ) : null}

              {sp.reset === "rate" ? (
                <div className="rounded-[var(--radius-sm)] border border-[var(--neg-border)] bg-[var(--neg-bg)] px-3 py-2 text-[11.5px] text-[var(--neg)]">
                  Çok fazla sıfırlama isteği gönderildi. Lütfen kısa bir süre bekleyip tekrar deneyin.
                </div>
              ) : null}

              {sp.resetError ? (
                <div className="rounded-[var(--radius-sm)] border border-[var(--neg-border)] bg-[var(--neg-bg)] px-3 py-2 text-[11.5px] text-[var(--neg)]">
                  {sp.resetError}
                </div>
              ) : null}

              {/* Step 1: Request Reset Token */}
              <form action={requestPasswordResetAction} className="space-y-2">
                <input type="hidden" name="next" value={next} />
                <div className="text-[11.5px] font-semibold text-[var(--ink)]">
                  1. Sıfırlama Bağlantısı / Kodu İste
                </div>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <input
                    name="usernameOrEmail"
                    type="text"
                    required
                    placeholder="Kullanıcı adı veya kurumsal e-posta"
                    className="flex-1 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-1)] px-2.5 py-1.5 text-base text-[var(--ink)] placeholder:text-[var(--muted)] focus:border-[var(--accent)] focus:outline-none sm:text-xs"
                  />
                  <button
                    type="submit"
                    className="rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--surface-1)] px-3 py-1.5 font-mono text-[11px] font-semibold text-[var(--ink)] transition-colors hover:bg-[var(--surface-3)]"
                  >
                    Kod Gönder
                  </button>
                </div>
              </form>

              {/* Step 2: Complete Reset with 64-hex CSPRNG Token */}
              <form
                action={completePasswordResetAction}
                className="space-y-2 border-t border-[var(--border)] pt-3"
              >
                <input type="hidden" name="next" value={next} />
                <div className="text-[11.5px] font-semibold text-[var(--ink)]">
                  2. Sıfırlama Kodu ile Yeni Parola Belirle
                </div>
                <input
                  name="token"
                  type="text"
                  required
                  defaultValue={activeResetToken}
                  placeholder="64 karakterlik sıfırlama kodu (hex)"
                  className="w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-1)] px-2.5 py-1.5 font-mono text-base text-[var(--ink)] placeholder:text-[var(--muted)] focus:border-[var(--accent)] focus:outline-none sm:text-xs"
                />
                <div className="grid gap-2 sm:grid-cols-2">
                  <input
                    name="newPassword"
                    type="password"
                    required
                    minLength={12}
                    autoComplete="new-password"
                    placeholder="Yeni parola (en az 12 karakter)"
                    className="w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-1)] px-2.5 py-1.5 font-mono text-base text-[var(--ink)] placeholder:text-[var(--muted)] focus:border-[var(--accent)] focus:outline-none sm:text-xs"
                  />
                  <input
                    name="confirmPassword"
                    type="password"
                    required
                    minLength={12}
                    autoComplete="new-password"
                    placeholder="Yeni parola (tekrar)"
                    className="w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-1)] px-2.5 py-1.5 font-mono text-base text-[var(--ink)] placeholder:text-[var(--muted)] focus:border-[var(--accent)] focus:outline-none sm:text-xs"
                  />
                </div>
                <button
                  type="submit"
                  className="w-full rounded-[var(--radius-sm)] border border-[var(--accent)] bg-[var(--accent-bg)] px-3 py-1.5 font-mono text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--accent)] transition-colors hover:bg-[var(--surface-3)]"
                >
                  Parolayı Sıfırla ve Güncelle
                </button>
              </form>
            </div>
          </details>

          <p className="mt-4 font-mono text-[10px] text-[var(--muted)]">
            Hesabınız yoksa sistem yöneticinizden (admin) yetki tanımlamasını isteyin.
          </p>
        </div>
      </div>
    </div>
  );
}
