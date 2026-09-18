import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodeConnection,
  describeConfig,
  findConnection,
  mergeConfig,
  listConnections,
  readIntegrationSettings,
  recordConnectionError,
  recordConnectionSuccess,
  removeConnection,
  upsertConnection,
  writeIntegrationSettings,
} from "./connections.ts";
import { INTEGRATION_SETTINGS_KEY, type IntegrationConnection } from "./types.ts";

function connection(overrides: Partial<IntegrationConnection> = {}): IntegrationConnection {
  return {
    id: "conn_1",
    kind: "rest",
    name: "College ERP",
    status: "ACTIVE",
    resources: ["students"],
    config: { baseUrl: "https://erp.example.edu" },
    fieldMappings: [{ source: "student_id", target: "student.externalId" }],
    schedule: { mode: "SCHEDULED", intervalMinutes: 60 },
    recentErrors: [],
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function settingsWith(...connections: unknown[]): Record<string, unknown> {
  return { [INTEGRATION_SETTINGS_KEY]: { connections } };
}

// ---------------------------------------------------------------------------
// Decoding what a previous build wrote
// ---------------------------------------------------------------------------

test("a connection this build wrote decodes back to itself", () => {
  assert.deepEqual(decodeConnection(connection()), connection());
});

test("nothing that is not an object is a connection", () => {
  for (const value of [null, undefined, 7, "conn_1", true, [], [{ id: "conn_1" }]]) {
    assert.equal(decodeConnection(value), null, `${JSON.stringify(value)} should not decode`);
  }
});

test("a connection with no id is dropped, because nothing can address it", () => {
  assert.equal(decodeConnection({ kind: "rest" }), null);
  assert.equal(decodeConnection({ id: "   ", kind: "rest" }), null);
  assert.equal(decodeConnection({ id: 7, kind: "rest" }), null);
});

test("a kind no provider is registered for is dropped, not defaulted", () => {
  // Defaulting to `rest` would make a downgraded webhook connection start
  // calling an external URL it was never configured to call.
  assert.equal(decodeConnection({ id: "conn_1", kind: "graphql" }), null);
  assert.equal(decodeConnection({ id: "conn_1" }), null);
});

test("a malformed field inside a valid connection falls back rather than dropping it", () => {
  // Taking a working integration offline to punish one corrupt field is a
  // worse outcome than showing it with a safe default.
  const decoded = decodeConnection({ id: "conn_1", kind: "rest", name: 42, status: "EXPLODED" });
  assert.equal(decoded?.name, "conn_1", "the id stands in for a missing name");
  assert.equal(decoded?.status, "DRAFT");
  assert.deepEqual(decoded?.resources, []);
  assert.deepEqual(decoded?.config, {});
  assert.deepEqual(decoded?.fieldMappings, []);
  assert.deepEqual(decoded?.recentErrors, []);
  assert.equal(decoded?.schedule.mode, "MANUAL");
});

test("a resource this build does not know is filtered out of the list", () => {
  const decoded = decodeConnection({
    id: "conn_1",
    kind: "rest",
    resources: ["students", "timetables", 7, null],
  });
  assert.deepEqual(decoded?.resources, ["students"]);
});

test("config keeps only the fields it recognises, with the types it expects", () => {
  const decoded = decodeConnection({
    id: "conn_1",
    kind: "rest",
    config: {
      baseUrl: "https://erp.example.edu",
      testPath: 7,
      headers: { "X-Api-Key": "abc", "X-Bad": 9 },
      resourcePaths: { students: "/api/students", timetables: "/api/tt", subjects: 3 },
      extra: { tenant: "north-campus" },
      unknownKey: "ignored",
    },
  });
  assert.deepEqual(decoded?.config, {
    baseUrl: "https://erp.example.edu",
    headers: { "X-Api-Key": "abc" },
    resourcePaths: { students: "/api/students" },
    extra: { tenant: "north-campus" },
  });
});

test("a mapping whose target this build no longer defines is dropped", () => {
  // Keeping it would show the administrator a mapping row that writes into a
  // field nothing reads.
  const decoded = decodeConnection({
    id: "conn_1",
    kind: "rest",
    fieldMappings: [
      { source: "student_id", target: "student.externalId" },
      { source: "nick", target: "student.nickname" },
      { source: "", target: "student.email" },
      "not a mapping",
    ],
  });
  assert.deepEqual(decoded?.fieldMappings, [{ source: "student_id", target: "student.externalId" }]);
});

test("a mapping's transform survives only if this build implements it", () => {
  const decoded = decodeConnection({
    id: "conn_1",
    kind: "rest",
    fieldMappings: [
      { source: "dob", target: "attendance.date", transform: "date_dmy", fallback: "" },
      { source: "code", target: "student.externalId", transform: "rot13" },
    ],
  });
  assert.equal(decoded?.fieldMappings[0].transform, "date_dmy");
  assert.equal(decoded?.fieldMappings[1].transform, undefined);
});

test("an interval below the floor is raised to it", () => {
  // A one-minute schedule against an external system is a denial-of-service
  // wearing a cron hat, and no roster changes that fast.
  assert.equal(decodeConnection({ id: "c", kind: "rest", schedule: { intervalMinutes: 1 } })?.schedule.intervalMinutes, 5);
  assert.equal(decodeConnection({ id: "c", kind: "rest", schedule: { intervalMinutes: 0 } })?.schedule.intervalMinutes, 5);
  assert.equal(decodeConnection({ id: "c", kind: "rest", schedule: { intervalMinutes: -60 } })?.schedule.intervalMinutes, 5);
  assert.equal(decodeConnection({ id: "c", kind: "rest", schedule: { intervalMinutes: 90.7 } })?.schedule.intervalMinutes, 90);
});

test("a non-finite interval is left unset rather than becoming NaN minutes", () => {
  const decoded = decodeConnection({
    id: "c",
    kind: "rest",
    schedule: { mode: "SCHEDULED", intervalMinutes: Number.NaN },
  });
  assert.equal(decoded?.schedule.intervalMinutes, undefined);
});

test("an unknown sync mode falls back to manual, the mode that does nothing on its own", () => {
  assert.equal(decodeConnection({ id: "c", kind: "rest", schedule: { mode: "REALTIME" } })?.schedule.mode, "MANUAL");
});

test("error entries missing a timestamp or a message are dropped", () => {
  const decoded = decodeConnection({
    id: "c",
    kind: "rest",
    recentErrors: [
      { at: "2026-09-01T00:00:00.000Z", message: "401 from the ERP", resource: "students" },
      { at: "2026-09-01T00:00:00.000Z" },
      { message: "no timestamp" },
      null,
    ],
  });
  assert.equal(decoded?.recentErrors.length, 1);
  assert.equal(decoded?.recentErrors[0].resource, "students");
});

test("a stored error list longer than the cap is truncated on read", () => {
  const decoded = decodeConnection({
    id: "c",
    kind: "rest",
    recentErrors: Array.from({ length: 40 }, (_, i) => ({ at: "2026-09-01T00:00:00.000Z", message: `e${i}` })),
  });
  assert.equal(decoded?.recentErrors.length, 10);
});

// ---------------------------------------------------------------------------
// Reading the bucket
// ---------------------------------------------------------------------------

test("settings with no integrations bucket read as no connections", () => {
  for (const value of [null, undefined, {}, { academicUnitLabels: {} }, "nonsense", 7, []]) {
    assert.deepEqual(listConnections(value), [], `${JSON.stringify(value)}`);
  }
});

test("one corrupt connection does not take the others offline", () => {
  const connections = listConnections(settingsWith(connection(), { id: "" }, connection({ id: "conn_2" })));
  assert.deepEqual(connections.map((c) => c.id), ["conn_1", "conn_2"]);
});

test("a connections value that is not an array reads as empty rather than throwing", () => {
  assert.deepEqual(listConnections({ [INTEGRATION_SETTINGS_KEY]: { connections: "conn_1" } }), []);
});

test("per-key rate limit overrides are read and clamped to sane integers", () => {
  const read = readIntegrationSettings({
    [INTEGRATION_SETTINGS_KEY]: {
      connections: [],
      rateLimits: {
        key_1: { burst: 120.9, refillPerMinute: 60 },
        key_2: { burst: 0, refillPerMinute: -5 },
        key_3: { burst: "lots", refillPerMinute: 60 },
        key_4: "nonsense",
      },
    },
  });
  assert.deepEqual(read.rateLimits, {
    key_1: { burst: 120, refillPerMinute: 60 },
    key_2: { burst: 1, refillPerMinute: 1 },
  });
});

test("a connection is found by id and missing ids are null, not undefined", () => {
  const settings = settingsWith(connection(), connection({ id: "conn_2" }));
  assert.equal(findConnection(settings, "conn_2")?.id, "conn_2");
  assert.equal(findConnection(settings, "conn_9"), null);
  assert.equal(findConnection(null, "conn_1"), null);
});

// ---------------------------------------------------------------------------
// Writing the bucket
// ---------------------------------------------------------------------------

test("writing integrations preserves every other setting in the column", () => {
  // `Institution.settings` is shared. Replacing the column wholesale would
  // erase an institution's attendance thresholds the first time anyone saved
  // an integration — silently, and with no visible connection to the cause.
  const existing = {
    academicUnitLabels: { GRADE: "Class" },
    confidenceThresholds: { present: 0.82 },
    attendanceMode: "PHOTO",
    lowAttendanceThreshold: 75,
  };
  const written = upsertConnection(existing, connection());

  assert.deepEqual(written.academicUnitLabels, { GRADE: "Class" });
  assert.deepEqual(written.confidenceThresholds, { present: 0.82 });
  assert.equal(written.attendanceMode, "PHOTO");
  assert.equal(written.lowAttendanceThreshold, 75);
  assert.equal(listConnections(written).length, 1);
});

test("writing never mutates the settings object it was handed", () => {
  const existing = { attendanceMode: "PHOTO" };
  const snapshot = structuredClone(existing);
  upsertConnection(existing, connection());
  removeConnection(existing, "conn_1");
  writeIntegrationSettings(existing, { connections: [] });
  assert.deepEqual(existing, snapshot);
});

test("writing onto settings that are not an object starts from an empty object", () => {
  const written = writeIntegrationSettings("corrupt", { connections: [] });
  assert.deepEqual(written, { [INTEGRATION_SETTINGS_KEY]: { connections: [] } });
});

test("upserting an existing id replaces it in place rather than appending a twin", () => {
  const first = upsertConnection({}, connection());
  const second = upsertConnection(first, connection({ name: "Renamed ERP" }));
  const connections = listConnections(second);

  assert.equal(connections.length, 1);
  assert.equal(connections[0].name, "Renamed ERP");
});

test("upserting preserves the order of the other connections", () => {
  let settings: unknown = {};
  for (const id of ["a", "b", "c"]) settings = upsertConnection(settings, connection({ id }));
  settings = upsertConnection(settings, connection({ id: "b", name: "Changed" }));

  assert.deepEqual(listConnections(settings).map((c) => c.id), ["a", "b", "c"]);
});

test("removing a connection leaves the rest, and removing a missing one is a no-op", () => {
  const settings = upsertConnection(upsertConnection({}, connection()), connection({ id: "conn_2" }));
  assert.deepEqual(listConnections(removeConnection(settings, "conn_1")).map((c) => c.id), ["conn_2"]);
  assert.equal(listConnections(removeConnection(settings, "conn_9")).length, 2);
});

test("removing a connection keeps the rate-limit overrides", () => {
  const settings = writeIntegrationSettings({}, {
    connections: [connection()],
    rateLimits: { key_1: { burst: 60, refillPerMinute: 60 } },
  });
  const after = removeConnection(settings, "conn_1");
  assert.deepEqual(readIntegrationSettings(after).rateLimits, { key_1: { burst: 60, refillPerMinute: 60 } });
});

// ---------------------------------------------------------------------------
// Recording outcomes
// ---------------------------------------------------------------------------

const FAILURE = { at: "2026-09-16T10:00:00.000Z", message: "401 Unauthorized from the ERP" };

test("a failure flips the connection to ERROR and is visible on the status column", () => {
  const after = recordConnectionError(connection(), FAILURE);
  assert.equal(after.status, "ERROR");
  assert.deepEqual(after.recentErrors, [FAILURE]);
  assert.equal(after.updatedAt, FAILURE.at);
});

test("the newest failure is first, because that is the one being investigated", () => {
  const older = { at: "2026-09-15T10:00:00.000Z", message: "older" };
  const after = recordConnectionError(connection({ recentErrors: [older] }), FAILURE);
  assert.deepEqual(after.recentErrors.map((e) => e.message), [FAILURE.message, "older"]);
});

test("the error list is capped, because it rides in a column read on every page load", () => {
  let current = connection();
  for (let i = 0; i < 25; i += 1) {
    current = recordConnectionError(current, { at: FAILURE.at, message: `failure ${i}` });
  }
  assert.equal(current.recentErrors.length, 10);
  assert.equal(current.recentErrors[0].message, "failure 24");
});

test("recording a failure does not mutate the connection it was given", () => {
  const original = connection();
  const snapshot = structuredClone(original);
  recordConnectionError(original, FAILURE);
  assert.deepEqual(original, snapshot);
});

test("a success clears the wall of red, so the error column stays worth reading", () => {
  const failing = recordConnectionError(connection(), FAILURE);
  const after = recordConnectionSuccess(failing, "2026-09-16T11:00:00.000Z");

  assert.equal(after.status, "ACTIVE");
  assert.deepEqual(after.recentErrors, []);
});

test("a success moves both the attempt and the watermark", () => {
  const at = "2026-09-16T11:00:00.000Z";
  const after = recordConnectionSuccess(connection(), at);
  assert.equal(after.schedule.lastSyncAt, at);
  assert.equal(after.schedule.lastSuccessAt, at);
  assert.equal(after.updatedAt, at);
});

test("a success keeps the schedule's configuration and only moves its timestamps", () => {
  const after = recordConnectionSuccess(
    connection({ schedule: { mode: "INCREMENTAL", intervalMinutes: 15 } }),
    "2026-09-16T11:00:00.000Z",
    "page-4",
  );
  assert.equal(after.schedule.mode, "INCREMENTAL");
  assert.equal(after.schedule.intervalMinutes, 15);
  assert.equal(after.schedule.cursor, "page-4");
});

test("a success with no cursor clears a stale one rather than replaying an old page", () => {
  const after = recordConnectionSuccess(
    connection({ schedule: { mode: "INCREMENTAL", cursor: "page-4" } }),
    "2026-09-16T11:00:00.000Z",
  );
  assert.equal(after.schedule.cursor, undefined);
});

test("a success on a paused connection reactivates it only through this explicit path", () => {
  // Worth pinning: `recordConnectionSuccess` is the one function that can
  // un-pause, and it only runs after a sync the pause should have prevented.
  const after = recordConnectionSuccess(connection({ status: "PAUSED" }), "2026-09-16T11:00:00.000Z");
  assert.equal(after.status, "ACTIVE");
});

test("an outcome survives a round trip through the settings column", () => {
  const failed = recordConnectionError(connection(), FAILURE);
  const stored = JSON.parse(JSON.stringify(upsertConnection({}, failed)));
  const read = findConnection(stored, "conn_1");

  assert.equal(read?.status, "ERROR");
  assert.deepEqual(read?.recentErrors, [FAILURE]);
});

// ---------------------------------------------------------------------------
// Describing configuration without leaking it
// ---------------------------------------------------------------------------

test("a credential header is masked, an ordinary one is shown", () => {
  const summary = describeConfig({
    baseUrl: "https://erp.example.edu",
    headers: { Authorization: "Bearer abc123", Accept: "application/json" },
  });

  assert.deepEqual(summary.headers, [
    { name: "Authorization", value: "[redacted]" },
    { name: "Accept", value: "application/json" },
  ]);
  assert.equal(summary.hasCredentials, true);
  assert.equal(summary.baseUrl, "https://erp.example.edu");
});

test("a credential in an innocently-named header is still masked", () => {
  // The header name is the vendor's choice, not ours. `X-Campus-Key` does not
  // contain "token", "secret" or "authorization" — the value is what gives it
  // away.
  const summary = describeConfig({
    headers: { "X-Campus-Key": "Bearer ey.long.value", "X-Tenant": "stmarys" },
  });
  assert.deepEqual(summary.headers, [
    { name: "X-Campus-Key", value: "[redacted]" },
    { name: "X-Tenant", value: "stmarys" },
  ]);
});

test("the mask is the same string regardless of the secret's length", () => {
  const short = describeConfig({ headers: { Authorization: "a" } });
  const long = describeConfig({ headers: { Authorization: "a".repeat(200) } });
  assert.equal(short.headers[0].value, long.headers[0].value);
});

test("a blank submitted secret leaves the stored one alone", () => {
  // The form cannot render the stored token, so an admin renaming the
  // connection posts an empty Authorization field. Wiping the credential on
  // every unrelated edit would be the bug this merge exists to prevent.
  const merged = mergeConfig(
    { baseUrl: "https://old.example.edu", headers: { Authorization: "Bearer stored" } },
    { baseUrl: "https://new.example.edu", headers: { Authorization: "   " } },
  );
  assert.equal(merged.baseUrl, "https://new.example.edu");
  assert.equal(merged.headers?.Authorization, "Bearer stored");
});

test("a non-blank submitted secret replaces the stored one", () => {
  const merged = mergeConfig(
    { headers: { Authorization: "Bearer stored" } },
    { headers: { Authorization: "Bearer rotated" } },
  );
  assert.equal(merged.headers?.Authorization, "Bearer rotated");
});

test("removing a header is possible, but only by asking explicitly", () => {
  const merged = mergeConfig(
    { headers: { Authorization: "Bearer stored", Accept: "application/json" } },
    {},
    ["Authorization"],
  );
  assert.deepEqual(merged.headers, { Accept: "application/json" });
});

test("removing the last header drops the key rather than storing an empty object", () => {
  const merged = mergeConfig({ headers: { Authorization: "Bearer stored" } }, {}, ["Authorization"]);
  assert.equal(merged.headers, undefined);
});
