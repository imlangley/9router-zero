"use client";

import { useEffect } from "react";

export default function GlobalError({ error, reset }) {
  useEffect(() => {
    // Detect chunk load errors (stale JS chunks after deployment)
    const isChunkError =
      error?.name === "ChunkLoadError" ||
      error?.message?.includes("ChunkLoadError") ||
      error?.message?.includes("Loading chunk") ||
      error?.message?.includes("Loading CSS chunk") ||
      error?.message?.includes("ChunkLoadError: Loading chunk") ||
      (typeof error?.message === "string" &&
        /chunk\s+\S+\s+failed/i.test(error.message));

    if (isChunkError) {
      // Auto-reload once to get fresh chunks. Use sessionStorage flag
      // to prevent infinite reload loops.
      const reloadKey = "__chunk_reload_attempted";
      if (!sessionStorage.getItem(reloadKey)) {
        sessionStorage.setItem(reloadKey, "1");
        window.location.reload();
        return;
      }
      // If we already reloaded once, clear the flag and show error
      sessionStorage.removeItem(reloadKey);
    }

    console.error("[GlobalError]", error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100vh",
          margin: 0,
          backgroundColor: "#0a0a0a",
          color: "#e5e5e5",
          fontFamily: "system-ui, -apple-system, sans-serif",
        }}
      >
        <div style={{ textAlign: "center", padding: "2rem" }}>
          <h1 style={{ fontSize: "1.25rem", marginBottom: "0.5rem" }}>
            Something went wrong
          </h1>
          <p style={{ color: "#a3a3a3", marginBottom: "1.5rem", fontSize: "0.875rem" }}>
            {error?.message || "An unexpected error occurred."}
          </p>
          <button
            type="button"
            onClick={() => {
              sessionStorage.removeItem("__chunk_reload_attempted");
              window.location.reload();
            }}
            style={{
              padding: "0.5rem 1.5rem",
              borderRadius: "0.5rem",
              border: "1px solid #404040",
              backgroundColor: "#171717",
              color: "#e5e5e5",
              cursor: "pointer",
              fontSize: "0.875rem",
            }}
          >
            Reload page
          </button>
        </div>
      </body>
    </html>
  );
}
