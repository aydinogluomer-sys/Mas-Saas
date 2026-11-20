"use client";

import { useCallback, useEffect, useState } from "react";

export type EyeComfortTheme = "washi" | "eink";
export type WorkspaceDensity = "executive" | "analyst";

const THEME_STORAGE_KEY = "mas_theme";
const DENSITY_STORAGE_KEY = "mas_density";

const THEME_COLOR_META: Record<EyeComfortTheme, string> = {
  washi: "#F4F1EA",
  eink: "#EFF0EB",
};

function readInitialDomTheme(): EyeComfortTheme {
  if (typeof document === "undefined") return "washi";
  const ds = document.documentElement.dataset.theme;
  if (ds === "washi" || ds === "eink") return ds;
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "washi" || stored === "eink") return stored;
  } catch {
    // Ignore storage access errors in restricted sandboxes
  }
  return "washi";
}

function readInitialDomDensity(): WorkspaceDensity {
  if (typeof document === "undefined") return "analyst";
  const ds = document.documentElement.dataset.density;
  if (ds === "executive" || ds === "analyst") return ds;
  try {
    const stored = window.localStorage.getItem(DENSITY_STORAGE_KEY);
    if (stored === "executive" || stored === "analyst") return stored;
  } catch {
    // Ignore storage access errors in restricted sandboxes
  }
  return "analyst";
}

function syncThemeColorMeta(theme: EyeComfortTheme) {
  if (typeof document === "undefined") return;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  const targetColor = THEME_COLOR_META[theme];
  if (meta && meta.content !== targetColor) {
    meta.content = targetColor;
  }
}

export function ViewComfortBar() {
  const [theme, setTheme] = useState<EyeComfortTheme>("washi");
  const [density, setDensity] = useState<WorkspaceDensity>("analyst");

  useEffect(() => {
    const currentTheme = readInitialDomTheme();
    const currentDensity = readInitialDomDensity();
    if (document.documentElement.dataset.theme !== currentTheme) {
      document.documentElement.dataset.theme = currentTheme;
    }
    if (document.documentElement.dataset.density !== currentDensity) {
      document.documentElement.dataset.density = currentDensity;
    }
    syncThemeColorMeta(currentTheme);
    setTheme(currentTheme);
    setDensity(currentDensity);

    const onStorage = (event: StorageEvent) => {
      if (event.key === THEME_STORAGE_KEY && (event.newValue === "washi" || event.newValue === "eink")) {
        document.documentElement.dataset.theme = event.newValue;
        syncThemeColorMeta(event.newValue);
        setTheme(event.newValue);
      }
      if (
        event.key === DENSITY_STORAGE_KEY &&
        (event.newValue === "executive" || event.newValue === "analyst")
      ) {
        document.documentElement.dataset.density = event.newValue;
        setDensity(event.newValue);
      }
    };

    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const applyTheme = useCallback((nextTheme: EyeComfortTheme) => {
    if (typeof document !== "undefined") {
      document.documentElement.dataset.theme = nextTheme;
      syncThemeColorMeta(nextTheme);
    }
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
    } catch {
      // Ignore storage quota / sandbox restrictions
    }
    setTheme(nextTheme);
  }, []);

  const applyDensity = useCallback((nextDensity: WorkspaceDensity) => {
    if (typeof document !== "undefined") {
      document.documentElement.dataset.density = nextDensity;
    }
    try {
      window.localStorage.setItem(DENSITY_STORAGE_KEY, nextDensity);
    } catch {
      // Ignore storage quota / sandbox restrictions
    }
    setDensity(nextDensity);
  }, []);

  return (
    <div
      className="inline-flex shrink-0 items-center gap-1.5"
      data-testid="view-comfort-bar"
    >
      {/* 1. Göz Konforu Teması (Sıcak Washi #1 ↔ E-Ink Kireçtaşı #2) */}
      <div
        role="group"
        aria-label="Göz konforu teması"
        className="inline-flex items-center rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-1)] p-0.5"
      >
        <button
          type="button"
          onClick={() => applyTheme("washi")}
          aria-pressed={theme === "washi"}
          title="Japon Washi & Sıcak Kaymaktaşı — Varsayılan Yönetici Kokpiti"
          data-testid="theme-btn-washi"
          className={`inline-flex items-center gap-1 rounded-[4px] px-1.5 py-0.5 text-[10.5px] font-semibold leading-tight tracking-[-0.01em] whitespace-nowrap transition-colors ${
            theme === "washi"
              ? "bg-[var(--surface-3)] text-[var(--ink)] shadow-[var(--shadow-xs)]"
              : "text-[var(--muted)] hover:text-[var(--ink-2)]"
          }`}
        >
          <span
            aria-hidden="true"
            className="inline-block h-2 w-2 shrink-0 rounded-full border"
            style={{ backgroundColor: "#F4F1EA", borderColor: "#B8AA93" }}
          />
          <span>Washi</span>
        </button>
        <button
          type="button"
          onClick={() => applyTheme("eink")}
          aria-pressed={theme === "eink"}
          title="E-Ink Adaçayı-Kireçtaşı — Sıfır Pupil Şoklu Uzun Okuma Modu"
          data-testid="theme-btn-eink"
          className={`inline-flex items-center gap-1 rounded-[4px] px-1.5 py-0.5 text-[10.5px] font-semibold leading-tight tracking-[-0.01em] whitespace-nowrap transition-colors ${
            theme === "eink"
              ? "bg-[var(--surface-3)] text-[var(--ink)] shadow-[var(--shadow-xs)]"
              : "text-[var(--muted)] hover:text-[var(--ink-2)]"
          }`}
        >
          <span
            aria-hidden="true"
            className="inline-block h-2 w-2 shrink-0 rounded-full border"
            style={{ backgroundColor: "#E4E8DF", borderColor: "#7E8E81" }}
          />
          <span>E-Ink</span>
        </button>
      </div>

      {/* 2. Görünüm Yoğunluğu (Yönetici Özeti ↔ Tam Analist Masası) */}
      <div
        role="group"
        aria-label="Görünüm yoğunluğu"
        className="inline-flex items-center rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-1)] p-0.5"
      >
        <button
          type="button"
          onClick={() => applyDensity("executive")}
          aria-pressed={density === "executive"}
          data-density="executive"
          title="Yönetici Özeti — Sade karar görünümü"
          data-testid="density-btn-executive"
          className={`rounded-[4px] px-1.5 py-0.5 text-[10.5px] font-semibold leading-tight tracking-[-0.01em] whitespace-nowrap transition-colors ${
            density === "executive"
              ? "bg-[var(--surface-3)] text-[var(--ink)] shadow-[var(--shadow-xs)]"
              : "text-[var(--muted)] hover:text-[var(--ink-2)]"
          }`}
        >
          Özet
        </button>
        <button
          type="button"
          onClick={() => applyDensity("analyst")}
          aria-pressed={density === "analyst"}
          data-density="analyst"
          title="Tam Analist Masası — Tüm detay tablolar açık"
          data-testid="density-btn-analyst"
          className={`rounded-[4px] px-1.5 py-0.5 text-[10.5px] font-semibold leading-tight tracking-[-0.01em] whitespace-nowrap transition-colors ${
            density === "analyst"
              ? "bg-[var(--surface-3)] text-[var(--ink)] shadow-[var(--shadow-xs)]"
              : "text-[var(--muted)] hover:text-[var(--ink-2)]"
          }`}
        >
          Analist
        </button>
      </div>
    </div>
  );
}
