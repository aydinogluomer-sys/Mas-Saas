"use client";

import Link from "@/components/ui/app-link";
import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[GlobalError]", error);
  }, [error]);

  return (
    <html lang="tr">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#f7f4ee",
          color: "#1f1d1a",
          fontFamily: "system-ui, -apple-system, sans-serif",
          padding: "24px",
        }}
      >
        <div
          role="alert"
          data-testid="global-error-boundary"
          style={{
            maxWidth: "520px",
            width: "100%",
            background: "#fffdf9",
            border: "1px solid #dfd8ca",
            borderRadius: "12px",
            padding: "28px",
            boxShadow: "0 10px 30px rgba(31, 29, 26, 0.06)",
          }}
        >
          <div style={{ fontSize: "12px", fontWeight: 600, letterSpacing: "0.06em", color: "#8a5a2b", textTransform: "uppercase" }}>
            Sistem Hata Sınırı
          </div>
          <h1 style={{ margin: "8px 0 12px", fontSize: "20px", fontWeight: 700 }}>
            Beklenmeyen bir uygulama hatası oluştu
          </h1>
          <p style={{ margin: "0 0 16px", fontSize: "14px", lineHeight: 1.55, color: "#575249" }}>
            Finansal verileriniz güvendedir ve tamamlanmamış veritabanı işlemleri otomatik olarak geri alınmıştır.
            Sayfayı yeniden deneyebilir veya ana ekrana dönebilirsiniz.
          </p>
          {error.digest ? (
            <p style={{ margin: "0 0 16px", fontSize: "12px", color: "#7a7367", fontFamily: "monospace" }}>
              Hata Referansı: {error.digest}
            </p>
          ) : null}
          <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={() => reset()}
              style={{
                background: "#1f1d1a",
                color: "#fffdf9",
                border: "none",
                borderRadius: "8px",
                padding: "9px 16px",
                fontSize: "13px",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Yeniden Dene
            </button>
            <Link
              href="/"
              style={{
                background: "#efeae0",
                color: "#1f1d1a",
                textDecoration: "none",
                border: "1px solid #d5ccbc",
                borderRadius: "8px",
                padding: "9px 16px",
                fontSize: "13px",
                fontWeight: 600,
              }}
            >
              Ana Ekrana Dön
            </Link>
          </div>
        </div>
      </body>
    </html>
  );
}

