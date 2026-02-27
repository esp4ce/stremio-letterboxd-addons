import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Configure Your Addon",
  description:
    "Connect your Letterboxd account to Stremio in seconds. Configure your watchlist, ratings, diary and custom lists.",
  alternates: { canonical: "/configure" },
};

export default function ConfigureLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return children;
}
