"use client";

// Toast layer (sonner) restyled to MAS dark tokens + a flash bridge.
// Mutations stay server-side; a server action redirects to `backTo?flash=<key>` and this
// bridge turns that param into a toast, then cleans the URL. Presentation only.
import { Suspense, useEffect, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { Toaster, toast } from "sonner";

export function AppToaster() {
  return (
    <Toaster
      theme="dark"
      position="bottom-right"
      toastOptions={{
        style: {
          background: "var(--surface-overlay)",
          border: "1px solid var(--line-strong)",
          borderRadius: "var(--radius-md)",
          color: "var(--text-1)",
          boxShadow: "var(--shadow-overlay)",
          fontSize: "13px",
        },
      }}
    />
  );
}

// Curated flash keys → Turkish messages (no free-text injection from the URL).
const FLASH_MESSAGES: Record<string, { text: string; kind: "success" | "error" | "message" }> = {
  archived: { text: "Kayıt arşivlendi.", kind: "success" },
  restored: { text: "Kayıt geri getirildi.", kind: "success" },
  saved: { text: "Kaydedildi.", kind: "success" },
  deleted: { text: "Silindi.", kind: "success" },
  error: { text: "İşlem tamamlanamadı.", kind: "error" },
  user_created: { text: "Kullanıcı oluşturuldu.", kind: "success" },
  password_reset: { text: "Parola sıfırlandı; kullanıcının açık oturumları kapatıldı.", kind: "success" },
  user_deactivated: { text: "Kullanıcı pasifleştirildi; oturumları kapatıldı.", kind: "success" },
  user_activated: { text: "Kullanıcı yeniden aktifleştirildi.", kind: "success" },
  role_changed: { text: "Rol güncellendi.", kind: "success" },
  user_unlocked: { text: "Hesap kilidi kaldırıldı.", kind: "success" },
  user_self: { text: "Kendi hesabınızın erişimini kaldıramazsınız.", kind: "error" },
  user_error: { text: "Kullanıcı işlemi tamamlanamadı. Girilen bilgileri kontrol edin.", kind: "error" },
};

function FlashBridge() {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const shown = useRef<string | null>(null);
  const flash = searchParams.get("flash");

  useEffect(() => {
    if (!flash) return;
    const token = `${pathname}?flash=${flash}`;
    if (shown.current === token) return;
    shown.current = token;
    const entry = FLASH_MESSAGES[flash];
    if (entry) {
      if (entry.kind === "success") toast.success(entry.text);
      else if (entry.kind === "error") toast.error(entry.text);
      else toast(entry.text);
    }
    // Strip the flash param so a refresh does not re-fire (replaceState → no route change).
    const url = new URL(window.location.href);
    url.searchParams.delete("flash");
    window.history.replaceState(window.history.state, "", url);
  }, [flash, pathname]);

  return null;
}

/** Wrap the flash bridge in Suspense — it reads useSearchParams. */
export function FlashToaster() {
  return (
    <Suspense fallback={null}>
      <FlashBridge />
    </Suspense>
  );
}
