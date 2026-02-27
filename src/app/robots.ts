import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/", "/configure"],
        disallow: ["/dashboard"],
      },
    ],
    sitemap: "https://stremboxd.com/sitemap.xml",
  };
}
