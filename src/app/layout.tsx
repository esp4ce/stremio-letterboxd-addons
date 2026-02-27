import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { Analytics } from "@vercel/analytics/react";
import "./globals.css";
import ConsoleMessage from "./components/ConsoleMessage";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  weight: ["300", "400", "600"],
  display: "swap",
});

const SITE_TITLE = "Stremboxd – Sync Letterboxd with Stremio";
const SITE_DESCRIPTION =
  "Sync your Letterboxd watchlist, ratings, diary and lists with Stremio. Free unofficial addon for all platforms.";

export const metadata: Metadata = {
  metadataBase: new URL("https://stremboxd.com"),
  title: {
    default: `${SITE_TITLE} | Watchlist, Ratings & Lists`,
    template: "%s | Stremboxd",
  },
  description: SITE_DESCRIPTION,
  keywords: [
    "stremboxd",
    "letterboxd",
    "stremio",
    "addon",
    "stremio addon",
    "letterboxd stremio",
    "movies",
    "watchlist",
    "film ratings",
    "diary",
    "sync",
    "streaming",
    "media center",
  ],
  authors: [{ name: "esp4ce", url: "https://github.com/esp4ce" }],
  creator: "esp4ce",
  icons: {
    icon: "/favicon.svg",
    apple: "/favicon.svg",
  },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "https://stremboxd.com",
    siteName: "Stremboxd",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
  },
  alternates: {
    canonical: "/",
  },
};

export const viewport: Viewport = {
  themeColor: "#0a0a0a",
  width: "device-width",
  initialScale: 1,
};

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Stremboxd",
  applicationCategory: "MultimediaApplication",
  operatingSystem: "All",
  description: SITE_DESCRIPTION,
  url: "https://stremboxd.com",
  offers: {
    "@type": "Offer",
    price: "0",
    priceCurrency: "USD",
  },
  author: {
    "@type": "Person",
    name: "esp4ce",
    url: "https://github.com/esp4ce",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${inter.variable} ${inter.className} antialiased`}>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
        <Analytics />
        <ConsoleMessage />
        {children}
      </body>
    </html>
  );
}
