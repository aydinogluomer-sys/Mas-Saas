import type { Metadata, Viewport } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { PwaRegister } from "@/components/pwa/pwa-register";
import "./globals.css";

export const viewport: Viewport = {
  themeColor: "#0284c7",
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
};

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
        <PwaRegister />
      </body>
    </html>
  );
}

