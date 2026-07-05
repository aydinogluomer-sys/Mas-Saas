import type { Metadata } from "next";
import "./globals.css";

// System font stack on purpose: build environment has no egress to Google Fonts,
// and the panel's design language is system-mono anyway.
export const metadata: Metadata = {
  title: "MAS Nakit Radar",
  description: "Kapalı devre ödeme + nakit akış operasyon paneli",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="tr">
      <body className="antialiased">{children}</body>
    </html>
  );
}
