import type { Metadata, Viewport } from "next";
import Script from "next/script";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";

export const viewport: Viewport = {
  themeColor: "#F4F1EA",
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
};

const COMFORT_BOOTSTRAP_SCRIPT = `(function(){try{var d=document.documentElement,t=localStorage.getItem("mas_theme"),m=localStorage.getItem("mas_density");if(t==="washi"||t==="eink")d.dataset.theme=t;if(m==="analyst"||m==="executive")d.dataset.density=m;}catch(e){}})();`;

// Geist is bundled locally via the npm package (next/font/local under the hood):
// no Google Fonts egress needed at build time.
//
// The manifest and icon stay (add-to-home-screen on the owner's phone); nothing caches pages
// and no service worker or Cache Storage writer exists anywhere in the application.
export const metadata: Metadata = {
  title: "MAS Nakit Radar",
  description: "Kapalı devre ödeme + nakit akış operasyon paneli",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "MAS Radar",
  },
  icons: {
    icon: "/icon.svg",
    apple: "/icon.svg",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="tr"
      data-theme="washi"
      data-density="analyst"
      suppressHydrationWarning
      className={`${GeistSans.variable} ${GeistMono.variable}`}
    >
      <body className="antialiased">
        <Script id="mas-comfort-bootstrap" strategy="beforeInteractive">
          {COMFORT_BOOTSTRAP_SCRIPT}
        </Script>
        {children}
      </body>
    </html>
  );
}
