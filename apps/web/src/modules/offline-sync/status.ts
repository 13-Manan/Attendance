/**
 * The one place that decides what the sync indicator says.
 *
 * Pure, and deliberately not inside a component. The brief names five states —
 * Offline, Pending Sync, Syncing, Synced, Sync Failed — and the interesting
 * question is not how to render them but which one wins when several are true
 * at once: a device that is offline, has three queued registers, one of which
 * failed permanently, and a conflict waiting on a human. Answering that inside
 * a JSX ternary is how an indicator ends up reassuring somebody that everything
 * is synced while a register sits unsent.
 */

export type SyncIndicator =
  | "OFFLINE"
  | "SYNCING"
  | "PENDING"
  | "CONFLICT"
  | "FAILED"
  | "SYNCED";

export interface IndicatorInput {
  isOffline: boolean;
  pending: number;
  syncing: number;
  failed: number;
  conflicts: number;
}

/**
 * Severity order, most severe first.
 *
 * `CONFLICT` and `FAILED` outrank `OFFLINE` on purpose. Being offline is
 * expected and temporary — it resolves itself when the teacher walks past the
 * office. A conflict and a permanent failure need a person, and they stay
 * unresolved for as long as the badge hides them behind a cloud icon that
 * everyone has learned to ignore.
 *
 * `SYNCED` is last and is the only state that may not be inferred: it requires
 * the queue to be genuinely empty. There is no "probably fine" here.
 */
export function syncIndicator(input: IndicatorInput): SyncIndicator {
  if (input.conflicts > 0) return "CONFLICT";
  if (input.failed > 0) return "FAILED";
  if (input.isOffline) return "OFFLINE";
  if (input.syncing > 0) return "SYNCING";
  if (input.pending > 0) return "PENDING";
  return "SYNCED";
}

export interface IndicatorPresentation {
  label: string;
  /** Longer text for a tooltip or the sync panel's header. */
  detail: string;
  /** Tailwind classes for the badge. */
  className: string;
}

/**
 * Wording rules, applied consistently:
 *
 * - Say the number. "2 pending" is actionable; "Pending sync" is a mood.
 * - Never say "Synced" unless the queue is empty.
 * - Never imply data loss where there is none. A failed sync is attendance
 *   that is *saved on this device and not yet on the server*, which is what
 *   the detail line says — because a teacher who reads "Sync failed" and
 *   assumes the register is gone will re-take it, and now there are two.
 */
export function describeIndicator(
  indicator: SyncIndicator,
  input: IndicatorInput,
): IndicatorPresentation {
  const queued = input.pending + input.syncing + input.failed;
  switch (indicator) {
    case "OFFLINE":
      return {
        label: queued > 0 ? `Offline · ${queued} queued` : "Offline",
        detail:
          queued > 0
            ? "No connection. Attendance is saved on this device and will sync automatically."
            : "No connection. You can still open a class and take attendance.",
        className: "border-amber-300 bg-amber-50 text-amber-900",
      };
    case "SYNCING":
      return {
        label: `Syncing${input.syncing > 1 ? ` ${input.syncing}` : ""}…`,
        detail: "Sending saved attendance to the server.",
        className: "border-blue-300 bg-blue-50 text-blue-900",
      };
    case "PENDING":
      return {
        label: `Pending sync · ${input.pending}`,
        detail: "Saved on this device. Waiting to send.",
        className: "border-neutral-300 bg-neutral-50 text-neutral-700",
      };
    case "CONFLICT":
      return {
        label: `Needs review · ${input.conflicts}`,
        detail:
          "The server already holds a different answer for some students. Nothing was overwritten — choose which to keep.",
        className: "border-purple-300 bg-purple-50 text-purple-900",
      };
    case "FAILED":
      return {
        label: `Sync failed · ${input.failed}`,
        detail:
          "Attendance is still saved on this device. It was not accepted by the server — open the sync panel for the reason.",
        className: "border-red-300 bg-red-50 text-red-900",
      };
    case "SYNCED":
      return {
        label: "Synced",
        detail: "Everything taken on this device is on the server.",
        className: "border-emerald-300 bg-emerald-50 text-emerald-900",
      };
  }
}

/** Human text for the codes the server and the queue put in `lastError`. */
export function describeSyncError(code: string | null): string | null {
  if (!code) return null;
  if (code.startsWith("forbidden:")) {
    return "You no longer have permission to record attendance for this class. Ask an administrator.";
  }
  if (code.startsWith("http_401")) return "Your session expired. Sign in again to finish syncing.";
  if (code.startsWith("http_403")) return "The server refused this operation.";
  if (code.startsWith("http_413")) return "This register is too large to send in one request.";
  if (code.startsWith("http_5")) return "The server had a problem. This will be retried.";
  switch (code) {
    case "network_unreachable":
      return "Could not reach the server. This will be retried automatically.";
    case "malformed_response":
      return "The server's reply could not be read. This will be retried.";
    case "no_outcome":
      return "The server did not answer for this operation. This will be retried.";
    case "cohort_not_found":
      return "That class no longer exists on the server.";
    case "session_cancelled":
      return "That register was cancelled on the server.";
    case "attendance_record_not_found":
      return "That student is no longer on the register.";
    case "empty_roster":
      return "That class has no enrolled students on the server.";
    default:
      return code.replace(/_/g, " ");
  }
}
