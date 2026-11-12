"use client";

import Link from "@/components/ui/app-link";
import { useEffect } from "react";

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[DashboardError]", error);
  }, [error]);

  return (
    <div
      role="alert"
      data-testid="dashboard-error-boundary"
      style={{
        margin: "24px auto",
        maxWidth: "620px",
        background: "var(--surface-1, #fffdf9)",
        border: "1px solid var(--line, #dfd8ca)",
        borderRadius: "var(--radius-lg, 12px)",
        padding: "28px",
        color: "var(--text-1, #1f1d1a)",
      }}
    >
      <div
        style={{
          fontSize: "12px",
          fontWeight: 600,
          letterSpacing: "0.06em",
          color: "var(--warning, #9a6700)",
          textTransform: "uppercase",
        }}
      >
        Modül Hata Sınırı
      </div>
      <h2 style={{ margin: "8px 0 10px", fontSize: "19px", fontWeight: 700 }}>
        Bu ekran yüklenirken bir sorun oluştu
      </h2>
      <p style={{ margin: "0 0 16px", fontSize: "14px", lineHeight: 1.55, color: "var(--text-2, #575249)" }}>
        {error.message && error.message.length < 220
          ? error.message
          : "İstek işlenirken beklenmeyen bir hata meydana geldi. Veritabanı bütünlüğü korunmuştur."}
      </p>
      {error.digest ? (
        <p style={{ margin: "0 0 16px", fontSize: "12px", color: "var(--text-3, #7a7367)", fontFamily: "var(--font-mono, monospace)" }}>
          Hata Kodu: {error.digest}
        </p>
      ) : null}
      <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={() => reset()}
          className="btn btn-primary"
          style={{
            background: "var(--text-1, #1f1d1a)",
            color: "var(--surface-1, #fffdf9)",
            border: "1px solid var(--text-1, #1f1d1a)",
            borderRadius: "var(--radius-md, 8px)",
            padding: "8px 16px",
            fontSize: "13px",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Ekranı Yeniden Yükle
        </button>
        <Link
          href="/"
          style={{
            background: "var(--surface-2, #f3efe6)",
            color: "var(--text-1, #1f1d1a)",
            border: "1px solid var(--line, #dfd8ca)",
            borderRadius: "var(--radius-md, 8px)",
            padding: "8px 16px",
            fontSize: "13px",
            fontWeight: 600,
            textDecoration: "none",
          }}
        >
          Ana Ekrana Dön
        </Link>
      </div>
    </div>
  );
}

