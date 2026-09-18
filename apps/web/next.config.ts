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
};

export default nextConfig;
