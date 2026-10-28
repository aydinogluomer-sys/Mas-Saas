import type { Metadata, Viewport } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { ServiceWorkerCleanup } from "@/components/pwa/service-worker-cleanup";
import "./globals.css";

export const viewport: Viewport = {
  themeColor: "#0284c7",
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
};

// Geist is bundled locally via the npm package (next/font/local under the hood):
// no Google Fonts egress needed at build time.
//
// The manifest and icon stay (add-to-home-screen on the owner's phone); nothing caches pages. The
// layer's caching service worker is being retired — see ServiceWorkerCleanup and public/sw.js.
export const metadata: Metadata = {
  title: "MAS Nakit Radar",
  description: "Kapalı devre ödeme + nakit akış operasyon paneli",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "MAS Radar",
  },
  icons: {
    icon: "/icon.svg",
    apple: "/icon.svg",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="tr" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="antialiased">
        {children}
        <ServiceWorkerCleanup />
      </body>
    </html>
  );
}
