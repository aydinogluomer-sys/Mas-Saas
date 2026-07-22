import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";

// Geist is bundled locally via the npm package (next/font/local under the hood):
// no Google Fonts egress needed at build time.
export const metadata: Metadata = {
  title: "MAS Nakit Radar",
  description: "Kapalı devre ödeme + nakit akış operasyon paneli",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="tr" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="antialiased">{children}</body>
    </html>
  );
}
