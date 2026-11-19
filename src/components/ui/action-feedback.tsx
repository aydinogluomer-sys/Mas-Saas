/**
 * AKSİYON GERİ BİLDİRİMİ — bir server action tamamlandığında veya reddettiğinde gösterilen kalıcı şerit.
 * `flash` ve `success` eşanlamlı olarak desteklenir (100% geriye dönük uyumlu).
 */

export function ActionFeedback({
  error,
  flash,
  success,
}: {
  error?: string;
  flash?: string;
  success?: string;
}) {
  const okMessage = flash ?? success;
  if (!error && !okMessage) return null;
  return (
    <div className="space-y-2">
      {error && (
        <p
          role="alert"
          className="rounded-[8px] border px-3 py-2 text-[13px] font-medium"
          style={{
            borderColor: "color-mix(in srgb, var(--neg) 32%, var(--line))",
            background: "var(--neg-dim)",
            color: "var(--neg)",
          }}
          data-action-error
        >
          İşlem tamamlanmadı: {error}
        </p>
      )}
      {okMessage && (
        <p
          role="status"
          className="rounded-[8px] border px-3 py-2 text-[13px] font-medium"
          style={{
            borderColor: "color-mix(in srgb, var(--pos) 32%, var(--line))",
            background: "var(--pos-dim)",
            color: "var(--pos)",
          }}
          data-action-flash
        >
          {okMessage}
        </p>
      )}
    </div>
  );
}
