import type { Metadata, Viewport } from "next";
import Script from "next/script";

export const viewport: Viewport = {
  themeColor: "#0284c7",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export const metadata: Metadata = {
  title: "MAS Nakit Radar · Telegram Mini App",
  description: "Telegram ve mobil cihazlar için optimize edilmiş anlık nakit kokpiti",
};

export default function TelegramMiniAppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 antialiased selection:bg-sky-500 selection:text-white">
      {/* Telegram WebApp JavaScript SDK */}
      <Script
        src="https://telegram.org/js/telegram-web-app.js"
        strategy="beforeInteractive"
      />
      <main className="mx-auto max-w-md min-h-screen flex flex-col pb-8 pt-safe">
        {children}
      </main>
    </div>
  );
}
