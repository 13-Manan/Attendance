"use client";

import { useEffect } from "react";

/**
 * The last resort: a failure in the root layout itself.
 *
 * This replaces the whole document, so it has to supply its own `<html>` and
 * `<body>` — the layout that would normally provide them is the thing that
 * threw. For the same reason it imports no shared component, uses no font
 * variable and relies on no CSS custom property: every one of those is
 * something the failed layout was responsible for setting up. Inline styles
 * are deliberate here and only here.
 *
 * A full-page reload rather than `reset()` for the same reason — re-rendering
 * a root layout that just failed usually fails again, where a reload gets a
 * fresh server render.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("root layout render failed", error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "1.5rem",
          fontFamily: "system-ui, -apple-system, sans-serif",
          color: "#171717",
          backgroundColor: "#fafafa",
        }}
      >
        <div style={{ maxWidth: "28rem", textAlign: "center" }} role="alert">
          <h1 style={{ fontSize: "1.125rem", fontWeight: 600, margin: "0 0 0.5rem" }}>
            The application failed to load
          </h1>
          <p style={{ fontSize: "0.875rem", color: "#737373", margin: "0 0 1rem" }}>
            Something went wrong before the page could be drawn. Reloading usually
            resolves it. If it does not, contact your institution administrator.
          </p>
          {error.digest ? (
            <p style={{ fontSize: "0.75rem", color: "#a3a3a3", margin: "0 0 1rem" }}>
              Reference: <code>{error.digest}</code>
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => reset()}
            style={{
              cursor: "pointer",
              borderRadius: "0.375rem",
              border: "none",
              backgroundColor: "#171717",
              color: "#ffffff",
              padding: "0.5rem 1rem",
              fontSize: "0.875rem",
              fontWeight: 500,
            }}
          >
            Reload
          </button>
        </div>
      </body>
    </html>
  );
}
