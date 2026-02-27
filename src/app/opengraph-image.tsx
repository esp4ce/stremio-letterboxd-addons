import { ImageResponse } from "next/og";

export const runtime = "edge";

export const alt = "Stremboxd – Sync Letterboxd with Stremio";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OgImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#0a0a0a",
          padding: "60px",
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: "24px",
          }}
        >
          <h1
            style={{
              fontSize: "72px",
              fontWeight: 700,
              color: "#ffffff",
              textAlign: "center",
              lineHeight: 1.1,
              margin: 0,
            }}
          >
            Stremboxd
          </h1>

          <p
            style={{
              fontSize: "32px",
              fontWeight: 300,
              color: "#a1a1aa",
              textAlign: "center",
              margin: 0,
            }}
          >
            Sync Letterboxd with Stremio
          </p>

          <div
            style={{
              display: "flex",
              gap: "16px",
              marginTop: "32px",
            }}
          >
            {["Watchlist", "Ratings", "Diary", "Lists"].map((label) => (
              <div
                key={label}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  backgroundColor: "#18181b",
                  border: "1px solid #27272a",
                  borderRadius: "12px",
                  padding: "12px 24px",
                }}
              >
                <span style={{ fontSize: "20px", color: "#d4d4d8" }}>
                  {label}
                </span>
              </div>
            ))}
          </div>
        </div>

        <p
          style={{
            position: "absolute",
            bottom: "40px",
            fontSize: "20px",
            color: "#52525b",
            margin: 0,
          }}
        >
          stremboxd.com
        </p>
      </div>
    ),
    size
  );
}
