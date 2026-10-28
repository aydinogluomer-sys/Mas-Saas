"use client";

import { useEffect, useState } from "react";
import Image from "next/image";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

export function PwaRegister() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [showInstallBanner, setShowInstallBanner] = useState(false);
  const [isInstalled, setIsInstalled] = useState(false);

  useEffect(() => {
    // 1. Register Service Worker
    if (typeof window !== "undefined" && "serviceWorker" in navigator) {
      window.addEventListener("load", () => {
        navigator.serviceWorker
          .register("/sw.js")
          .then((reg) => {
            console.log("[PWA] Service Worker registered:", reg.scope);
          })
          .catch((err) => {
            console.warn("[PWA] Service Worker registration failed:", err);
          });
      });
    }

    // Check if already in standalone display mode
    if (
      typeof window !== "undefined" &&
      (window.matchMedia("(display-mode: standalone)").matches ||
        ("standalone" in window.navigator && (window.navigator as unknown as { standalone: boolean }).standalone))
    ) {
      setIsInstalled(true);
      return;
    }

    // 2. Listen for install prompt
    const handleBeforeInstall = (e: Event) => {
      e.preventDefault();
      const dismissed = localStorage.getItem("mas_pwa_banner_dismissed");
      if (dismissed && Date.now() - Number(dismissed) < 7 * 24 * 3600 * 1000) {
        // Dismissed within last 7 days
        return;
      }
      setDeferredPrompt(e as BeforeInstallPromptEvent);
      setShowInstallBanner(true);
    };

    const handleAppInstalled = () => {
      setIsInstalled(true);
      setShowInstallBanner(false);
      setDeferredPrompt(null);
      console.log("[PWA] App installed successfully");
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstall);
    window.addEventListener("appinstalled", handleAppInstalled);

    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstall);
      window.removeEventListener("appinstalled", handleAppInstalled);
    };
  }, []);

  const handleInstallClick = async () => {
    if (!deferredPrompt) return;
    await deferredPrompt.prompt();
    const choice = await deferredPrompt.userChoice;
    if (choice.outcome === "accepted") {
      setShowInstallBanner(false);
    }
    setDeferredPrompt(null);
  };

  const handleDismiss = () => {
    setShowInstallBanner(false);
    localStorage.setItem("mas_pwa_banner_dismissed", String(Date.now()));
  };

  if (!showInstallBanner || isInstalled) {
    return null;
  }

  return (
    <div
      id="pwa-install-banner"
      role="banner"
      aria-label="Uygulama Yükleme Bildirimi"
      className="fixed bottom-4 left-4 right-4 z-50 mx-auto max-w-md animate-fade-in-up rounded-2xl border border-sky-500/30 bg-slate-950/90 p-4 shadow-2xl backdrop-blur-xl transition-all"
    >
      <div className="flex items-start gap-3">
        <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl bg-sky-500/10 border border-sky-400/20 text-sky-400">
          <Image src="/icon.svg" alt="MAS Radar" width={28} height={28} className="drop-shadow" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold text-slate-100">MAS Radar Mobil & Masaüstü</h4>
            <button
              onClick={handleDismiss}
              aria-label="Kapat"
              className="text-slate-400 hover:text-slate-200 text-xs px-1.5 py-0.5 rounded transition"
            >
              ✕
            </button>
          </div>
          <p className="mt-1 text-xs text-slate-400 leading-relaxed">
            Hızlı erişim, çevrimdışı destek ve anlık kasa takibi için uygulamayı cihazınıza ekleyin.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <button
              onClick={handleInstallClick}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-gradient-to-r from-sky-500 to-blue-600 px-3.5 py-1.5 text-xs font-medium text-white shadow-md shadow-sky-500/20 hover:from-sky-400 hover:to-blue-500 active:scale-95 transition-all"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              Ana Ekrana Ekle
            </button>
            <button
              onClick={handleDismiss}
              className="rounded-lg border border-slate-700/60 bg-slate-800/40 px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-800 hover:text-white transition"
            >
              Daha Sonra
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
