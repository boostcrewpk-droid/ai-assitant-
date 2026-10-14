import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Lala Hisab — Bol kar hisab",
  description: "Dukaan ka hisab awaaz se: udhar, naqad sale, stock aur kharcha.",
  manifest: "/manifest.webmanifest",
  applicationName: "Lala Hisab",
  appleWebApp: { capable: true, title: "Lala Hisab", statusBarStyle: "black-translucent" },
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180" }],
  },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  themeColor: "#073b2b",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ur-PK">
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
