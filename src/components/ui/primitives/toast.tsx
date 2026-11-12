"use client";

// Toast layer (sonner) restyled to MAS dark tokens + a flash bridge.
// Mutations stay server-side; a server action redirects to `backTo?flash=<key>` and this
// bridge turns that param into a toast, then cleans the URL. Presentation only.
import { Suspense, useEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { Toaster, toast } from "sonner";

export function AppToaster() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setReady(true), 1200);
    return () => clearTimeout(id);
  }, []);
  if (!ready) return null;
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
  // Forced password change (0095). Both keys were emitted before Wave 0 but missing here, so the
  // success of either action showed nothing at all. tests/flash-keys.test.ts now fails on any key
  // an action emits that this map does not know.
  password_updated: { text: "Parolanız güncellendi; varsa diğer açık oturumlarınız kapatıldı.", kind: "success" },
  password_force_change: {
    text: "Parola değişikliği zorunlu kılındı; kullanıcı yeni parola belirlemeden devam edemez.",
    kind: "success",
  },
  // External assumptions validation (Bulgu #10) — curated error codes, never free text.
  "internet-source-url-required": {
    text: "İnternet kaynaklı varsayımlarda kaynak URL zorunludur.",
    kind: "error",
  },
  "assumption-fields-required": {
    text: "Zorunlu varsayım alanları (başlık, değer, birim, kaynak adı ve kaynak tarihi) eksiksiz doldurulmalıdır.",
    kind: "error",
  },
  "assumption-review-invalid": {
    text: "İnceleme durumu güncellenemedi: geçersiz kayıt kimliği veya inceleme durumu.",
    kind: "error",
  },
};

function FlashBridge() {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const shown = useRef<string | null>(null);
  const flash = searchParams.get("flash");
  const rawError = searchParams.get("error");
  const curatedError = rawError && Object.prototype.hasOwnProperty.call(FLASH_MESSAGES, rawError) ? rawError : null;
  const activeKey = flash ?? curatedError;

  useEffect(() => {
    if (!activeKey) return;
    const paramName = flash ? "flash" : "error";
    const token = `${pathname}?${paramName}=${activeKey}`;
    if (shown.current === token) return;
    shown.current = token;
    const entry = FLASH_MESSAGES[activeKey];
    if (entry) {
      if (entry.kind === "success") toast.success(entry.text);
      else if (entry.kind === "error") toast.error(entry.text);
      else toast(entry.text);
    }
    // Strip the flash param so a refresh does not re-fire (replaceState → no route change).
    if (flash) {
      const url = new URL(window.location.href);
      url.searchParams.delete("flash");
      window.history.replaceState(window.history.state, "", url);
    }
  }, [activeKey, flash, pathname]);

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
