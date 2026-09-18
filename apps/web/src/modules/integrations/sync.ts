import type { IntegrationConnection, IntegrationResource, SyncMode, SyncSchedule } from "./types";

/**
 * Sync planning.
 *
 * ## What this module is honest about
 *
 * Nothing in this application runs a scheduler. There is no daemon, no job
 * queue, no `setInterval` that survives a deploy. "Scheduled sync" here means:
 * an external cron (or the host's scheduler) calls
 * `POST /api/v1/integrations/{id}/sync` on whatever cadence it likes, and this
 * module decides whether that call should actually do work or return
 * `skipped`.
 *
 * That is a deliberate choice, not a shortcut. A scheduler living inside a
 * Next.js server that may be running as several instances behind a load
 * balancer would fire N times per interval, and the instance that happens to
 * serve no traffic is the one that gets frozen. Putting the *decision* here as
 * a pure function and the *trigger* outside means the behaviour is identical
 * whether the caller is a cron, a human clicking "Sync now", or a future job
 * runner — and it is testable without a clock.
 *
 * ## The three modes
 *
 * - `MANUAL` — runs whenever asked. A human pressed a button; never skip.
 * - `SCHEDULED` — runs a full pull if `intervalMinutes` has elapsed since
 *   `lastSyncAt`, otherwise skips. Full pull every time: correct, expensive.
 * - `INCREMENTAL` — same interval gate, but asks the provider only for records
 *   changed since the watermark. Cheap, and correct only if the external
 *   system's "modified since" filter is trustworthy.
 *
 * Pure module. See sync.test.ts.
 */

export type SyncTrigger = "manual" | "scheduled";

export interface SyncPlanInput {
  schedule: SyncSchedule;
  resources: readonly IntegrationResource[];
  trigger: SyncTrigger;
  now: Date;
  /** Set by an operator to force a full pull past the watermark. */
  force?: boolean;
}

export type SkipReason = "interval_not_elapsed" | "no_resources" | "already_running";

export interface SyncPlan {
  shouldRun: boolean;
  skipReason?: SkipReason;
  /** Human-readable, shown in the Integration Center and the sync response. */
  reason: string;
  mode: SyncMode;
  /** `undefined` means "pull everything" — a full sync. */
  since?: string;
  cursor?: string;
  resources: IntegrationResource[];
  /** When the next scheduled run becomes eligible, for the UI. */
  nextEligibleAt?: string;
}

export const DEFAULT_INTERVAL_MINUTES = 60;
export const MIN_INTERVAL_MINUTES = 5;

/**
 * The watermark is deliberately rewound a little.
 *
 * External systems stamp `updated_at` at the start of a transaction but make
 * the row visible at commit. A record written at 09:59:59.8 and committed at
 * 10:00:00.2 is invisible to a query that runs at 10:00:00.0 and is then never
 * returned again, because the next watermark is already past it. The row is
 * lost silently and forever — the worst failure shape a sync has.
 *
 * Five minutes of overlap costs a handful of redundant rows, and redundant
 * rows are free: the import pipeline classifies an unchanged record as
 * `unchanged`, writing nothing and emitting no webhook.
 */
export const WATERMARK_OVERLAP_MS = 5 * 60 * 1000;

export function intervalMinutes(schedule: SyncSchedule): number {
  const raw = schedule.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES;
  return Math.max(MIN_INTERVAL_MINUTES, Math.floor(raw));
}

function parseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function nextEligibleAt(schedule: SyncSchedule): string | null {
  if (schedule.mode === "MANUAL") return null;
  const last = parseDate(schedule.lastSyncAt);
  if (!last) return null;
  return new Date(last.getTime() + intervalMinutes(schedule) * 60_000).toISOString();
}

/**
 * Decides whether a sync run should proceed, and with what window.
 *
 * A manual trigger bypasses the interval gate on purpose: the button exists
 * precisely for "the ERP was fixed, pull now", and a button that silently does
 * nothing for another 40 minutes is worse than no button.
 */
export function planSync(input: SyncPlanInput): SyncPlan {
  const { schedule, trigger, now, force } = input;
  const mode = schedule.mode;
  const resources = [...input.resources];
  const eligible = nextEligibleAt(schedule) ?? undefined;

  if (resources.length === 0) {
    return {
      shouldRun: false,
      skipReason: "no_resources",
      reason: "This integration has no resources selected, so there is nothing to sync.",
      mode,
      resources,
      nextEligibleAt: eligible,
    };
  }

  const gated = trigger === "scheduled" && mode !== "MANUAL";
  if (gated) {
    const last = parseDate(schedule.lastSyncAt);
    if (last) {
      const dueAt = last.getTime() + intervalMinutes(schedule) * 60_000;
      if (now.getTime() < dueAt) {
        return {
          shouldRun: false,
          skipReason: "interval_not_elapsed",
          reason: `Last run was less than ${intervalMinutes(schedule)} minutes ago; next run is due at ${new Date(dueAt).toISOString()}.`,
          mode,
          resources,
          nextEligibleAt: new Date(dueAt).toISOString(),
        };
      }
    }
  }

  // A scheduled trigger against a MANUAL connection is a configuration
  // mismatch, not an error: the cron is hitting a connection an administrator
  // has since switched to manual. Running it is harmless and matches the
  // caller's intent, so it runs — the mode is recorded in the audit row.

  const incremental = mode === "INCREMENTAL" && !force;
  const watermark = incremental ? parseDate(schedule.lastSuccessAt) : null;

  return {
    shouldRun: true,
    reason:
      trigger === "manual"
        ? "Manual sync requested."
        : `Scheduled ${mode.toLowerCase()} sync is due.`,
    mode,
    since: watermark
      ? new Date(Math.max(0, watermark.getTime() - WATERMARK_OVERLAP_MS)).toISOString()
      : undefined,
    cursor: incremental ? schedule.cursor : undefined,
    resources,
    nextEligibleAt: eligible,
  };
}

/**
 * Whether a connection is in a state that permits syncing at all.
 *
 * `PAUSED` is the administrator saying "stop calling this system" — usually
 * because the far end asked them to. Honouring that even for a manual trigger
 * is the point of the button.
 */
export function canSync(connection: IntegrationConnection): { ok: boolean; reason?: string } {
  if (connection.status === "PAUSED") {
    return { ok: false, reason: "This integration is paused. Resume it before syncing." };
  }
  if (connection.resources.length === 0) {
    return { ok: false, reason: "Select at least one resource to sync." };
  }
  return { ok: true };
}

export interface SyncResourceResult {
  resource: IntegrationResource;
  fetched: number;
  created: number;
  updated: number;
  unchanged: number;
  errors: number;
}

export interface SyncRunResult {
  connectionId: string;
  startedAt: string;
  finishedAt: string;
  mode: SyncMode;
  trigger: SyncTrigger;
  status: "SUCCEEDED" | "PARTIAL" | "FAILED" | "SKIPPED";
  reason: string;
  resources: SyncResourceResult[];
  cursor?: string;
}

/**
 * `PARTIAL` exists because "succeeded with 300 errors" is a lie an operator
 * will believe. A run that imported most rows and rejected some is neither a
 * success nor a failure, and collapsing it into either one means either the
 * error report never gets opened or a working integration looks broken.
 */
export function summariseRun(resources: readonly SyncResourceResult[]): SyncRunResult["status"] {
  if (resources.length === 0) return "SKIPPED";
  const touched = resources.reduce((sum, r) => sum + r.fetched, 0);
  const errors = resources.reduce((sum, r) => sum + r.errors, 0);
  if (errors === 0) return "SUCCEEDED";
  if (touched === errors) return "FAILED";
  return "PARTIAL";
}

export function describeRun(result: SyncRunResult): string {
  const totals = result.resources.reduce(
    (acc, r) => ({
      created: acc.created + r.created,
      updated: acc.updated + r.updated,
      unchanged: acc.unchanged + r.unchanged,
      errors: acc.errors + r.errors,
    }),
    { created: 0, updated: 0, unchanged: 0, errors: 0 },
  );
  const parts = [
    `${totals.created} created`,
    `${totals.updated} updated`,
    `${totals.unchanged} unchanged`,
  ];
  if (totals.errors > 0) parts.push(`${totals.errors} failed`);
  return parts.join(", ");
}
