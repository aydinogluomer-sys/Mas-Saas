import { requireSession } from "@/lib/auth";
import { logoutAction } from "@/app/login/actions";
import { passwordChangeMessage } from "@/lib/users/password-policy";
import { changePasswordAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function ChangePasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const user = await requireSession({ allowMustChangePassword: true });
  const sp = await searchParams;
  // Only a code the action itself emits turns into text; any other `?error=` value shows nothing.
  // The layer printed the parameter verbatim, so a crafted link could make this screen say
  // whatever its author wanted.
  const errorMessage = passwordChangeMessage(sp.error);

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-0 p-4 text-tone-1">
      <div
        className="command-surface animate-rise w-full max-w-md border p-6"
        style={{ borderRadius: "var(--radius-md)" }}
      >
        <div className="flex items-center justify-between">
          <div className="font-mono text-sm font-bold tracking-[0.2em]">MAS NAKİT RADAR</div>
          <form action={logoutAction}>
            <button
              type="submit"
              className="font-mono text-[10px] uppercase tracking-wider text-tone-3 hover:text-tone-1 transition-colors"
            >
              çıkış yap
            </button>
          </form>
        </div>

        <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.14em] text-tone-3">
          güvenlik · parola yenileme
        </div>

        {user.mustChangePassword ? (
          <div
            className="mt-4 border border-warn bg-warn/10 p-3 text-xs"
            style={{ borderRadius: "var(--radius-sm)" }}
          >
            <div className="font-semibold text-warn">Şifre Değişimi Zorunludur</div>
            <div className="mt-1 text-tone-2">
              Sayın <strong>{user.displayName}</strong> ({user.username}), güvenlik politikası gereği ilk oturumunuzda veya şifre sıfırlama sonrasında sisteme erişmek için yeni bir parola belirlemeniz gerekmektedir.
            </div>
          </div>
        ) : (
          <div className="mt-3 text-xs text-tone-2">
            Sayın <strong>{user.displayName}</strong>, mevcut hesabınız için parolanızı bu ekrandan güvenle güncelleyebilirsiniz.
          </div>
        )}

        <form action={changePasswordAction} className="mt-5 space-y-3">
          <label className="block">
            <span className="font-mono text-[10px] uppercase tracking-wider text-tone-3">Mevcut parola</span>
            <input
              name="oldPassword"
              type="password"
              required
              autoFocus
              autoComplete="current-password"
              placeholder="••••••••••••"
              className="field-control mt-1 px-2 py-1.5 font-mono text-sm"
            />
          </label>

          <label className="block">
            <span className="font-mono text-[10px] uppercase tracking-wider text-tone-3">
              Yeni parola (en az 12 karakter)
            </span>
            <input
              name="newPassword"
              type="password"
              required
              minLength={12}
              autoComplete="new-password"
              placeholder="••••••••••••"
              className="field-control mt-1 px-2 py-1.5 font-mono text-sm"
            />
          </label>

          <label className="block">
            <span className="font-mono text-[10px] uppercase tracking-wider text-tone-3">Yeni parola (tekrar)</span>
            <input
              name="confirmPassword"
              type="password"
              required
              minLength={12}
              autoComplete="new-password"
              placeholder="••••••••••••"
              className="field-control mt-1 px-2 py-1.5 font-mono text-sm"
            />
          </label>

          {errorMessage && (
            <div
              role="alert"
              className="border border-neg bg-neg/10 p-2 font-mono text-[11px] text-neg"
              style={{ borderRadius: "var(--radius-sm)" }}
            >
              {errorMessage}
            </div>
          )}

          <div className="pt-2">
            <button
              type="submit"
              className="w-full border border-pos tint-pos px-3 py-2 font-mono text-[11px] uppercase tracking-wider text-pos transition-colors font-semibold"
              style={{ borderRadius: "var(--radius-sm)" }}
            >
              parolayı güncelle ve devam et →
            </button>
          </div>
        </form>

        <ul className="mt-4 space-y-1 font-mono text-[10px] text-tone-4 border-t border-line-faint pt-3">
          <li>• Parola en az 12 karakter uzunluğunda olmalıdır.</li>
          <li>• Parola kullanıcı adıyla aynı olamaz.</li>
          <li>• Yeni parola mevcut parola ile aynı olamaz.</li>
          <li>• Parola değişince bu oturum açık kalır; diğer cihaz ve tarayıcılardaki oturumlarınız kapatılır.</li>
          <li>• Mevcut parola 5 kez hatalı girilirse hesap 15 dakika kilitlenir (girişteki kuralın aynısı).</li>
        </ul>
      </div>
    </div>
  );
}
