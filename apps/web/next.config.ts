import type { NextConfig } from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * This file's own directory (apps/web), then two levels up to the workspace
 * root. Needed because tracing defaults to the Next.js project directory, and
 * in an npm-workspaces monorepo the dependencies this app actually loads are
 * hoisted to the root `node_modules` — outside that default. Without this the
 * standalone build traces a tree that is missing most of what it imports.
 */
const workspaceRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const nextConfig: NextConfig = {
  /**
   * Emit `.next/standalone`: a self-contained server plus only the traced
   * subset of node_modules. This is what `apps/web/Dockerfile` copies, and it
   * is why the runtime image runs no install step and carries no build
   * toolchain, no dev dependencies and no source.
   *
   * Nothing about the application's behaviour changes — it is purely a
   * different packaging of the same build output.
   */
  output: "standalone",
  outputFileTracingRoot: workspaceRoot,

  experimental: {
    /**
     * Framework-level connectivity handling for navigations, RSC fetches,
     * prefetches, and Server Actions.
     *
     * With this on, a soft navigation or a Server Action that fails because
     * the network dropped is not thrown at the component — Next keeps it
     * pending and replays it when connectivity returns. That is worth having
     * here for a reason specific to this app: `navigator.onLine` reports
     * `true` for a tablet associated with a school access point that has no
     * upstream, which is the exact network a classroom has on a bad day.
     * Next's detection polls a real request instead, so `useOffline()` tells
     * the truth where `navigator.onLine` does not.
     *
     * It is a complement to the offline queue, not a replacement for it.
     * Retrying a request is only useful while the tab is open and the teacher
     * is waiting; attendance has to survive the tab being closed, the device
     * sleeping, and the walk back to the staff room. That is what IndexedDB
     * and `modules/offline-sync` are for. Nothing in the capture flow depends
     * on this flag.
     */
    useOffline: true,
  },

  /**
   * Security response headers.
   *
   * Deliberately the conservative set — the ones that cannot break a page
   * that works today. Each is here for a reason specific to this app:
   *
   *  - `X-Frame-Options` / `frame-ancestors 'none'`: nothing embeds this app,
   *    and a framed attendance register is a clickjacking target — a teacher
   *    could be made to confirm one. `frame-ancestors` is the modern control;
   *    `X-Frame-Options` is kept alongside it for older browsers, which is the
   *    only place it still does anything.
   *  - `nosniff`: the API returns JSON and the app serves user-supplied
   *    filenames in report exports. Content-type sniffing is how one of those
   *    becomes script.
   *  - `Referrer-Policy`: dashboard URLs carry cohort and session ids. Those
   *    are not secrets, but they are an institution's data and have no reason
   *    to travel to another origin in a Referer header.
   *  - `Permissions-Policy`: the camera is granted to `self` because face
   *    capture needs it; microphone and geolocation are denied outright,
   *    because nothing in this product has ever asked for them and a
   *    compromised dependency should not be able to start.
   *
   * Deliberately NOT here: a full Content-Security-Policy. A script-src
   * policy strict enough to be worth having needs per-request nonces threaded
   * through the framework's inline bootstrap, and a half-strict one
   * (`unsafe-inline`) buys nothing while risking a blank production page.
   * That is its own piece of work, not a line in this config.
   *
   * HSTS is environment-specific rather than absent. TLS terminates at Azure
   * Container Apps ingress, so the header is belt-and-braces there — but
   * sending it unconditionally would pin `localhost` to HTTPS in every
   * developer's browser for a year, which is a self-inflicted outage that is
   * awkward to undo. So it is emitted only in a production build, and the
   * condition is written here rather than left to whatever fronts the app,
   * because "someone else will set it" is how a header ends up set nowhere.
   */
  async headers() {
    const headers = [
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      {
        key: "Permissions-Policy",
        value: "camera=(self), microphone=(), geolocation=()",
      },
    ];

    if (process.env.NODE_ENV === "production") {
      headers.push({
        // Two years, subdomains included. No `preload` token: submitting to
        // the preload list is irreversible on a browser timescale and is a
        // decision for whoever owns the domain, not for this file.
        key: "Strict-Transport-Security",
        value: "max-age=63072000; includeSubDomains",
      });
    }

    return [{ source: "/:path*", headers }];
  },
};

export default nextConfig;
