import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_INTERVAL_MINUTES,
  MIN_INTERVAL_MINUTES,
  WATERMARK_OVERLAP_MS,
  canSync,
  describeRun,
  intervalMinutes,
  nextEligibleAt,
  planSync,
  summariseRun,
  type SyncResourceResult,
  type SyncRunResult,
} from "./sync.ts";
import type { IntegrationConnection, IntegrationResource, SyncSchedule } from "./types.ts";

const NOW = new Date("2026-09-16T10:00:00.000Z");
const RESOURCES: IntegrationResource[] = ["students"];

function plan(schedule: SyncSchedule, overrides: Partial<Parameters<typeof planSync>[0]> = {}) {
  return planSync({ schedule, resources: RESOURCES, trigger: "scheduled", now: NOW, ...overrides });
}

function minutesAgo(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString();
}

// ---------------------------------------------------------------------------
// Interval
// ---------------------------------------------------------------------------

test("an unset interval falls back to the documented default", () => {
  assert.equal(intervalMinutes({ mode: "SCHEDULED" }), DEFAULT_INTERVAL_MINUTES);
});

test("an interval below the floor is raised, whatever wrote it", () => {
  // The decoder clamps on read, but a schedule can also be built in memory;
  // the gate itself must not be the one place a one-minute loop gets through.
  assert.equal(intervalMinutes({ mode: "SCHEDULED", intervalMinutes: 1 }), MIN_INTERVAL_MINUTES);
  assert.equal(intervalMinutes({ mode: "SCHEDULED", intervalMinutes: 0 }), MIN_INTERVAL_MINUTES);
  assert.equal(intervalMinutes({ mode: "SCHEDULED", intervalMinutes: -100 }), MIN_INTERVAL_MINUTES);
  assert.equal(intervalMinutes({ mode: "SCHEDULED", intervalMinutes: 90.9 }), 90);
});

// ---------------------------------------------------------------------------
// Next eligible time
// ---------------------------------------------------------------------------

test("a manual connection has no next run, because nothing will trigger one", () => {
  assert.equal(nextEligibleAt({ mode: "MANUAL", intervalMinutes: 15, lastSyncAt: minutesAgo(5) }), null);
});

test("a connection that has never run is eligible now, not at some computed time", () => {
  assert.equal(nextEligibleAt({ mode: "SCHEDULED", intervalMinutes: 60 }), null);
});

test("the next run is one interval after the last attempt", () => {
  const next = nextEligibleAt({ mode: "SCHEDULED", intervalMinutes: 60, lastSyncAt: minutesAgo(10) });
  assert.equal(next, "2026-09-16T10:50:00.000Z");
});

test("an unparseable last-run timestamp does not become an Invalid Date in the UI", () => {
  assert.equal(nextEligibleAt({ mode: "SCHEDULED", lastSyncAt: "yesterday" }), null);
});

// ---------------------------------------------------------------------------
// The interval gate
// ---------------------------------------------------------------------------

test("a scheduled run inside the interval is skipped with the time it is next due", () => {
  const result = plan({ mode: "SCHEDULED", intervalMinutes: 60, lastSyncAt: minutesAgo(10) });
  assert.equal(result.shouldRun, false);
  assert.equal(result.skipReason, "interval_not_elapsed");
  assert.equal(result.nextEligibleAt, "2026-09-16T10:50:00.000Z");
  assert.match(result.reason, /60 minutes/);
});

test("a scheduled run past the interval proceeds", () => {
  const result = plan({ mode: "SCHEDULED", intervalMinutes: 60, lastSyncAt: minutesAgo(61) });
  assert.equal(result.shouldRun, true);
});

test("a run exactly at the due moment proceeds rather than waiting a whole interval", () => {
  // A cron firing on the minute lands here every time; treating it as early
  // would halve the effective sync rate and look like a bug in the cron.
  const result = plan({ mode: "SCHEDULED", intervalMinutes: 60, lastSyncAt: minutesAgo(60) });
  assert.equal(result.shouldRun, true);
});

test("a connection that has never synced runs on the first scheduled call", () => {
  assert.equal(plan({ mode: "SCHEDULED", intervalMinutes: 60 }).shouldRun, true);
});

test("a manual trigger bypasses the gate, because that is what the button is for", () => {
  // "The ERP was fixed, pull now." A button that silently does nothing for
  // another 40 minutes is worse than no button.
  const result = plan({ mode: "SCHEDULED", intervalMinutes: 60, lastSyncAt: minutesAgo(1) }, { trigger: "manual" });
  assert.equal(result.shouldRun, true);
  assert.equal(result.reason, "Manual sync requested.");
});

test("a cron hitting a connection since switched to manual runs rather than erroring", () => {
  // A configuration mismatch, not a fault: running matches the caller's
  // intent and the mode is recorded on the audit row either way.
  const result = plan({ mode: "MANUAL", lastSyncAt: minutesAgo(1) });
  assert.equal(result.shouldRun, true);
  assert.equal(result.mode, "MANUAL");
});

test("a connection with nothing selected is skipped before any gate is considered", () => {
  const result = plan({ mode: "MANUAL" }, { resources: [], trigger: "manual" });
  assert.equal(result.shouldRun, false);
  assert.equal(result.skipReason, "no_resources");
  assert.match(result.reason, /nothing to sync/);
});

// ---------------------------------------------------------------------------
// The incremental window
// ---------------------------------------------------------------------------

test("a scheduled full sync asks for everything", () => {
  const result = plan({ mode: "SCHEDULED", lastSuccessAt: minutesAgo(120), lastSyncAt: minutesAgo(120) });
  assert.equal(result.since, undefined, "undefined means pull everything");
  assert.equal(result.cursor, undefined);
});

test("an incremental sync asks only for what changed since the last success", () => {
  const lastSuccess = minutesAgo(120);
  const result = plan({ mode: "INCREMENTAL", lastSuccessAt: lastSuccess, lastSyncAt: minutesAgo(120) });
  assert.equal(
    result.since,
    new Date(new Date(lastSuccess).getTime() - WATERMARK_OVERLAP_MS).toISOString(),
  );
});

test("the watermark is rewound, because a row committed after its own timestamp is lost forever otherwise", () => {
  // An external system stamps `updated_at` at transaction start and commits
  // later. A record stamped 09:59:59.8 and committed 10:00:00.2 is invisible
  // to a query at 10:00:00.0 and is never offered again. Five minutes of
  // overlap costs redundant rows, which the import pipeline calls `unchanged`.
  const result = plan({ mode: "INCREMENTAL", lastSuccessAt: NOW.toISOString(), lastSyncAt: minutesAgo(120) });
  const since = new Date(result.since ?? "").getTime();
  assert.equal(NOW.getTime() - since, WATERMARK_OVERLAP_MS);
});

test("the rewound watermark never goes below the epoch", () => {
  const result = plan({ mode: "INCREMENTAL", lastSuccessAt: "1970-01-01T00:00:10.000Z", lastSyncAt: minutesAgo(120) });
  assert.equal(result.since, "1970-01-01T00:00:00.000Z");
});

test("an incremental sync that has never succeeded pulls everything", () => {
  // The alternative — refusing to run without a watermark — leaves a new
  // connection permanently unable to take its first pull.
  const result = plan({ mode: "INCREMENTAL", lastSyncAt: minutesAgo(120) });
  assert.equal(result.since, undefined);
});

test("an incremental sync whose watermark is unreadable pulls everything rather than a garbage window", () => {
  const result = plan({ mode: "INCREMENTAL", lastSuccessAt: "not a date", lastSyncAt: minutesAgo(120) });
  assert.equal(result.since, undefined);
});

test("the cursor is carried only on an incremental run", () => {
  assert.equal(plan({ mode: "INCREMENTAL", cursor: "page-4" }).cursor, "page-4");
  assert.equal(plan({ mode: "SCHEDULED", cursor: "page-4" }).cursor, undefined);
});

test("force turns an incremental run into a full one and drops the cursor", () => {
  // The repair path: the watermark is wrong, or the external system back-dated
  // a correction, and the operator needs everything re-read.
  const result = plan(
    { mode: "INCREMENTAL", lastSuccessAt: minutesAgo(10), cursor: "page-4", lastSyncAt: minutesAgo(120) },
    { force: true },
  );
  assert.equal(result.since, undefined);
  assert.equal(result.cursor, undefined);
  assert.equal(result.mode, "INCREMENTAL", "the connection's mode is still reported as configured");
});

test("force does not override the interval gate", () => {
  // Forcing changes the *window*, not the *cadence*; a cron firing every
  // minute with force set must still be throttled.
  const result = plan({ mode: "INCREMENTAL", intervalMinutes: 60, lastSyncAt: minutesAgo(1) }, { force: true });
  assert.equal(result.shouldRun, false);
});

test("the plan copies the resource list rather than aliasing the caller's", () => {
  const resources: IntegrationResource[] = ["students", "attendance"];
  const result = plan({ mode: "MANUAL" }, { resources, trigger: "manual" });
  result.resources.push("subjects");
  assert.deepEqual(resources, ["students", "attendance"]);
});

// ---------------------------------------------------------------------------
// Whether a connection may sync at all
// ---------------------------------------------------------------------------

function connection(overrides: Partial<IntegrationConnection> = {}): IntegrationConnection {
  return {
    id: "conn_1",
    kind: "rest",
    name: "College ERP",
    status: "ACTIVE",
    resources: ["students"],
    config: {},
    fieldMappings: [],
    schedule: { mode: "SCHEDULED" },
    recentErrors: [],
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

test("a paused connection may not sync, even manually", () => {
  // Paused is usually the far end having asked to be left alone. Honouring it
  // against the button is the whole point of the pause.
  const result = canSync(connection({ status: "PAUSED" }));
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /paused/i);
});

test("a connection in error may still sync, because retrying is how it recovers", () => {
  assert.equal(canSync(connection({ status: "ERROR" })).ok, true);
});

test("a draft connection may sync, which is how an administrator tests one", () => {
  assert.equal(canSync(connection({ status: "DRAFT" })).ok, true);
});

test("a connection with no resources is told what to fix", () => {
  const result = canSync(connection({ resources: [] }));
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /at least one resource/);
});

// ---------------------------------------------------------------------------
// Summarising a run
// ---------------------------------------------------------------------------

function resource(overrides: Partial<SyncResourceResult> = {}): SyncResourceResult {
  return {
    resource: "students",
    fetched: 100,
    created: 10,
    updated: 5,
    unchanged: 85,
    errors: 0,
    ...overrides,
  };
}

test("a run with no errors succeeded", () => {
  assert.equal(summariseRun([resource()]), "SUCCEEDED");
});

test("a run where some rows failed is PARTIAL, not a success with a footnote", () => {
  // "Succeeded with 300 errors" is a lie an operator will believe, and the
  // error report never gets opened.
  assert.equal(summariseRun([resource({ fetched: 1000, errors: 300 })]), "PARTIAL");
});

test("a run where everything failed is FAILED, not partial", () => {
  assert.equal(summariseRun([resource({ fetched: 100, created: 0, updated: 0, unchanged: 0, errors: 100 })]), "FAILED");
});

test("a run that touched nothing is SKIPPED", () => {
  assert.equal(summariseRun([]), "SKIPPED");
});

test("one clean resource does not launder another's total failure", () => {
  assert.equal(
    summariseRun([resource(), resource({ resource: "attendance", fetched: 40, errors: 40 })]),
    "PARTIAL",
  );
});

test("a resource that fetched nothing and failed nothing does not fake a success", () => {
  assert.equal(
    summariseRun([resource({ fetched: 0, created: 0, updated: 0, unchanged: 0, errors: 0 })]),
    "SUCCEEDED",
  );
});

test("the run description totals every resource and stays quiet about zero failures", () => {
  const result: SyncRunResult = {
    connectionId: "conn_1",
    startedAt: NOW.toISOString(),
    finishedAt: NOW.toISOString(),
    mode: "SCHEDULED",
    trigger: "scheduled",
    status: "SUCCEEDED",
    reason: "Scheduled scheduled sync is due.",
    resources: [resource(), resource({ resource: "attendance", created: 2, updated: 0, unchanged: 8 })],
  };
  assert.equal(describeRun(result), "12 created, 5 updated, 93 unchanged");

  assert.match(
    describeRun({ ...result, resources: [resource({ errors: 3 })] }),
    /3 failed$/,
  );
});

test("a run with no resources still describes itself", () => {
  const described = describeRun({
    connectionId: "conn_1",
    startedAt: NOW.toISOString(),
    finishedAt: NOW.toISOString(),
    mode: "MANUAL",
    trigger: "manual",
    status: "SKIPPED",
    reason: "nothing selected",
    resources: [],
  });
  assert.equal(described, "0 created, 0 updated, 0 unchanged");
});
