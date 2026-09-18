import { test } from "node:test";
import assert from "node:assert/strict";
import {
  IntegrationCenterError,
  commitImport,
  createConnection,
  deleteConnection,
  getIntegrationCenter,
  previewImport,
  runSync,
  saveFieldMappings,
  setConnectionStatus,
  testConnection,
  updateConnection,
  type CenterDeps,
} from "./center-service.ts";
import { ForbiddenError } from "../authorization/types.ts";
import type { SessionUser } from "../auth-tenancy/types.ts";
import type { IntegrationProvider } from "./providers/provider.ts";
import type { IntegrationKind } from "./types.ts";

/**
 * Integration Center tests.
 *
 * Every dependency is injected, so the whole suite runs with no database, no
 * network and no clock. What is being tested here is the part a database
 * could not tell you anyway: who is allowed to do this, what reaches the
 * browser, and whether a preview's numbers match what the commit does.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeAdmin(overrides: { permissions?: string[]; institutionId?: string | null } = {}): SessionUser {
  return {
    userId: "user-admin",
    email: "admin@example.edu",
    name: "Admin",
    institutionId: overrides.institutionId === undefined ? "inst-A" : overrides.institutionId,
    campusId: null,
    roles: [
      {
        key: "INSTITUTION_ADMIN",
        name: "Institution Admin",
        institutionId: "inst-A",
        campusId: null,
        permissions: (overrides.permissions ?? [
          "institution.read",
          "institution.update",
          "student.read",
          "student.create",
          "student.update",
        ]) as SessionUser["roles"][number]["permissions"],
      },
    ],
  };
}

interface Store {
  deps: CenterDeps;
  settings: Record<string, unknown>;
  audits: Array<{ action: string; entityId: string; after?: unknown; before?: unknown }>;
  created: Array<{ studentCode: string; firstName: string; lastName: string }>;
  /** The whole input, not a projection of it — a test that asserts a field is
   *  absent has to be looking at what the service actually passed. */
  updated: Array<Record<string, unknown>>;
  roster: Map<string, { id: string; studentCode: string; firstName: string; lastName: string; email: string | null; phone: string | null; status: string }>;
  testResult: { ok: boolean; message: string };
  pages: Array<Array<Record<string, string>>>;
  failCodes: Set<string>;
}

function makeStore(options: { capabilities?: Partial<IntegrationProvider["capabilities"]> } = {}): Store {
  let settings: Record<string, unknown> = {};
  const audits: Store["audits"] = [];
  const created: Store["created"] = [];
  const updated: Store["updated"] = [];
  const roster: Store["roster"] = new Map();
  const store = {
    testResult: { ok: true, message: "Connected." },
    pages: [] as Array<Array<Record<string, string>>>,
    failCodes: new Set<string>(),
  };
  let idCounter = 0;

  const provider: IntegrationProvider = {
    kind: "rest" as IntegrationKind,
    label: "REST API",
    capabilities: {
      testConnection: true,
      pull: true,
      push: false,
      incremental: true,
      scheduled: true,
      resources: ["students", "classes", "sections", "programs", "subjects", "faculty", "enrollments", "attendance"],
      ...options.capabilities,
    },
    validateConfig: (config) => (config.baseUrl ? [] : ["A base URL is required."]),
    testConnection: async () => store.testResult,
    fetch: async (_config, fetchOptions) => {
      const rows = store.pages.shift() ?? [];
      return { rows, nextCursor: store.pages.length > 0 ? `page-${fetchOptions.limit}` : null };
    },
  };

  const deps: CenterDeps = {
    getSettings: async (institutionId) =>
      institutionId === "inst-A" ? { id: "inst-A", settings } : { id: institutionId, settings: {} },
    writeSettings: async (_institutionId, next) => {
      // Round-tripped through JSON the way a Json column would, so a test
      // cannot pass on an object shape Postgres would not have returned.
      settings = JSON.parse(JSON.stringify(next)) as Record<string, unknown>;
    },
    listStudentsByCodes: async (_institutionId, codes) =>
      codes.flatMap((code) => {
        const row = roster.get(code);
        return row ? [row] : [];
      }),
    createStudent: (async (_actor, input) => {
      if (store.failCodes.has(input.studentCode)) throw new Error("Unique constraint failed");
      created.push({
        studentCode: input.studentCode,
        firstName: input.firstName,
        lastName: input.lastName,
      });
      return { id: `stu-${input.studentCode}` } as never;
    }) as CenterDeps["createStudent"],
    updateStudent: (async (_actor, input) => {
      updated.push({ ...input });
      return { id: input.studentId } as never;
    }) as CenterDeps["updateStudent"],
    audit: (async (input) => {
      audits.push({
        action: input.action,
        entityId: input.entityId,
        after: input.afterJson,
        before: input.beforeJson,
      });
    }) as CenterDeps["audit"],
    provider: () => provider,
    now: () => new Date("2026-09-16T10:00:00.000Z"),
    newId: () => `int_${(idCounter += 1)}`,
  };

  return {
    deps,
    get settings() {
      return settings;
    },
    audits,
    created,
    updated,
    roster,
    get testResult() {
      return store.testResult;
    },
    set testResult(value) {
      store.testResult = value;
    },
    get pages() {
      return store.pages;
    },
    get failCodes() {
      return store.failCodes;
    },
  } as Store;
}

const REST_INPUT = {
  name: "College ERP",
  kind: "rest",
  resources: ["students"],
  config: { baseUrl: "https://erp.example.edu", headers: { Authorization: "Bearer secret-token" } },
  syncMode: "SCHEDULED",
  intervalMinutes: 60,
};

function csv(text: string): Buffer {
  return Buffer.from(text, "utf8");
}

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

test("viewing the Integration Center requires institution.read", async () => {
  const store = makeStore();
  const faculty = makeAdmin({ permissions: ["student.read"] });
  await assert.rejects(() => getIntegrationCenter(faculty, store.deps), ForbiddenError);
});

test("a reader cannot create, edit, delete, test or sync a connection", async () => {
  const store = makeStore();
  const reader = makeAdmin({ permissions: ["institution.read", "student.read"] });
  await createConnection(makeAdmin(), REST_INPUT, store.deps);

  await assert.rejects(() => createConnection(reader, REST_INPUT, store.deps), ForbiddenError);
  await assert.rejects(
    () => updateConnection(reader, { connectionId: "int_1", name: "x" }, store.deps),
    ForbiddenError,
  );
  await assert.rejects(() => deleteConnection(reader, "int_1", store.deps), ForbiddenError);
  // Testing makes an outbound request from our server, so it is a write-level
  // action however read-only it looks.
  await assert.rejects(() => testConnection(reader, "int_1", store.deps), ForbiddenError);
  await assert.rejects(() => runSync(reader, { connectionId: "int_1" }, store.deps), ForbiddenError);
});

test("a platform account with no institution is refused rather than defaulted to one", async () => {
  const store = makeStore();
  const platform = makeAdmin({ institutionId: null });
  await assert.rejects(
    () => getIntegrationCenter(platform, store.deps),
    (error: Error) => error instanceof IntegrationCenterError,
  );
});

test("a connection id from another institution is not found", async () => {
  const store = makeStore();
  await createConnection(makeAdmin(), REST_INPUT, store.deps);

  const outsider = makeAdmin();
  outsider.institutionId = "inst-B";
  await assert.rejects(
    () => updateConnection(outsider, { connectionId: "int_1", name: "Stolen" }, store.deps),
    (error: Error) => error instanceof IntegrationCenterError && /no longer exists/.test(error.message),
  );
});

// ---------------------------------------------------------------------------
// Creating a connection
// ---------------------------------------------------------------------------

test("a new connection starts as a draft with the default mapping seeded", async () => {
  const store = makeStore();
  const view = await createConnection(makeAdmin(), REST_INPUT, store.deps);

  // DRAFT, not ACTIVE: saving a form is not evidence that anything works.
  assert.equal(view.status, "DRAFT");
  assert.equal(view.syncMode, "SCHEDULED");
  assert.equal(view.intervalMinutes, 60);
  assert.ok(view.fieldMappings.some((mapping) => mapping.target === "student.externalId"));
  assert.equal(store.audits.at(-1)?.action, "integration.created");
});

test("the credential never reaches the view model", async () => {
  const store = makeStore();
  const view = await createConnection(makeAdmin(), REST_INPUT, store.deps);

  assert.equal(view.config.headers[0].name, "Authorization");
  assert.equal(view.config.headers[0].value, "[redacted]");
  assert.equal(JSON.stringify(view).includes("secret-token"), false);

  const center = await getIntegrationCenter(makeAdmin(), store.deps);
  assert.equal(JSON.stringify(center).includes("secret-token"), false);
});

test("the credential never reaches the audit log either", async () => {
  const store = makeStore();
  await createConnection(makeAdmin(), REST_INPUT, store.deps);
  assert.equal(JSON.stringify(store.audits).includes("secret-token"), false);
});

test("the credential is stored, though — the server still has to call the ERP", async () => {
  const store = makeStore();
  await createConnection(makeAdmin(), REST_INPUT, store.deps);
  assert.equal(JSON.stringify(store.settings).includes("secret-token"), true);
});

test("invalid configuration is refused before it is stored", async () => {
  const store = makeStore();
  await assert.rejects(
    () => createConnection(makeAdmin(), { ...REST_INPUT, config: {} }, store.deps),
    (error: Error) => error instanceof IntegrationCenterError && /base URL/.test(error.message),
  );
  assert.deepEqual((await getIntegrationCenter(makeAdmin(), store.deps)).connections, []);
});

test("a resource this build cannot import is refused rather than silently ignored", async () => {
  const store = makeStore();
  await assert.rejects(
    () => createConnection(makeAdmin(), { ...REST_INPUT, resources: ["attendance"] }, store.deps),
    (error: Error) => error instanceof IntegrationCenterError && /students only/.test(error.message),
  );
});

test("a sync mode the provider cannot honour is refused", async () => {
  const store = makeStore({ capabilities: { incremental: false } });
  await assert.rejects(
    () => createConnection(makeAdmin(), { ...REST_INPUT, syncMode: "INCREMENTAL" }, store.deps),
    (error: Error) => error instanceof IntegrationCenterError && /incrementally/.test(error.message),
  );
});

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

test("renaming a connection does not wipe its stored credential", async () => {
  const store = makeStore();
  await createConnection(makeAdmin(), REST_INPUT, store.deps);

  // The form posts a blank Authorization because it could not render the real
  // one. That must not be read as "clear it".
  await updateConnection(
    makeAdmin(),
    {
      connectionId: "int_1",
      name: "College ERP (prod)",
      config: { baseUrl: "https://erp.example.edu", headers: { Authorization: "" } },
    },
    store.deps,
  );

  assert.equal(JSON.stringify(store.settings).includes("secret-token"), true);
  const view = await getIntegrationCenter(makeAdmin(), store.deps);
  assert.equal(view.connections[0].name, "College ERP (prod)");
});

test("pausing is recorded with a before and after an operator can read", async () => {
  const store = makeStore();
  await createConnection(makeAdmin(), REST_INPUT, store.deps);
  const paused = await setConnectionStatus(makeAdmin(), "int_1", "PAUSED", store.deps);

  assert.equal(paused.status, "PAUSED");
  assert.equal(paused.canSyncNow, false);
  assert.match(paused.syncBlockedReason ?? "", /paused/i);
  assert.deepEqual(store.audits.at(-1)?.after, { status: "PAUSED" });
});

test("deleting keeps the redacted configuration in the audit trail", async () => {
  const store = makeStore();
  await createConnection(makeAdmin(), REST_INPUT, store.deps);
  await deleteConnection(makeAdmin(), "int_1", store.deps);

  assert.deepEqual((await getIntegrationCenter(makeAdmin(), store.deps)).connections, []);
  const row = store.audits.at(-1);
  assert.equal(row?.action, "integration.deleted");
  assert.equal(JSON.stringify(row?.before).includes("erp.example.edu"), true);
});

// ---------------------------------------------------------------------------
// Field mapping
// ---------------------------------------------------------------------------

test("a mapping missing a required target is refused whole", async () => {
  const store = makeStore();
  await createConnection(makeAdmin(), REST_INPUT, store.deps);

  await assert.rejects(
    () =>
      saveFieldMappings(
        makeAdmin(),
        {
          connectionId: "int_1",
          resource: "students",
          mappings: [{ source: "name", target: "student.name" }],
        },
        store.deps,
      ),
    (error: Error) => error instanceof IntegrationCenterError && /required/.test(error.message),
  );

  // The previous mapping survives: a rejected save must not leave the
  // connection half-configured.
  const view = await getIntegrationCenter(makeAdmin(), store.deps);
  assert.ok(view.connections[0].fieldMappings.some((m) => m.target === "student.externalId"));
});

test("a valid custom mapping replaces the default", async () => {
  const store = makeStore();
  await createConnection(makeAdmin(), REST_INPUT, store.deps);

  const view = await saveFieldMappings(
    makeAdmin(),
    {
      connectionId: "int_1",
      resource: "students",
      mappings: [
        { source: "  ADM_NO ", target: "student.externalId", transform: "trim" },
        { source: "PUPIL_NAME", target: "student.name" },
      ],
    },
    store.deps,
  );

  assert.deepEqual(view.fieldMappings, [
    { source: "ADM_NO", target: "student.externalId", transform: "trim" },
    { source: "PUPIL_NAME", target: "student.name" },
  ]);
  assert.deepEqual(view.mappingProblems, []);
});

// ---------------------------------------------------------------------------
// Test connection
// ---------------------------------------------------------------------------

test("a successful test promotes a draft to active and clears old errors", async () => {
  const store = makeStore();
  await createConnection(makeAdmin(), REST_INPUT, store.deps);
  store.testResult = { ok: false, message: "Connection refused." };
  await testConnection(makeAdmin(), "int_1", store.deps);

  let view = await getIntegrationCenter(makeAdmin(), store.deps);
  assert.equal(view.connections[0].status, "ERROR");
  assert.equal(view.connections[0].recentErrors.length, 1);

  store.testResult = { ok: true, message: "Connected." };
  await testConnection(makeAdmin(), "int_1", store.deps);

  view = await getIntegrationCenter(makeAdmin(), store.deps);
  assert.equal(view.connections[0].status, "ACTIVE");
  // A connection that failed yesterday and works today is working. Leaving
  // the red there trains an admin to ignore the column.
  assert.deepEqual(view.connections[0].recentErrors, []);
});

test("a provider that throws does not take the page down", async () => {
  const store = makeStore();
  await createConnection(makeAdmin(), REST_INPUT, store.deps);
  const throwing: CenterDeps = {
    ...store.deps,
    provider: () => {
      const base = store.deps.provider!("rest");
      return {
        ...base,
        testConnection: async () => {
          throw new Error("socket hang up");
        },
      };
    },
  };

  const result = await testConnection(makeAdmin(), "int_1", throwing);
  assert.equal(result.ok, false);
  assert.match(result.message, /socket hang up/);
});

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

test("a paused connection does not sync, even from the button", async () => {
  const store = makeStore();
  await createConnection(makeAdmin(), REST_INPUT, store.deps);
  await setConnectionStatus(makeAdmin(), "int_1", "PAUSED", store.deps);

  const run = await runSync(makeAdmin(), { connectionId: "int_1" }, store.deps);
  assert.equal(run.status, "SKIPPED");
  assert.match(run.reason, /paused/i);
  assert.equal(store.created.length, 0);
});

test("a manual sync creates the students the provider returned", async () => {
  const store = makeStore();
  await createConnection(makeAdmin(), REST_INPUT, store.deps);
  store.pages.push([
    { student_id: "S001", student_name: "Asha Rao", email: "asha@example.edu" },
    { student_id: "S002", student_name: "Vikram Singh", email: "vikram@example.edu" },
  ]);

  const run = await runSync(makeAdmin(), { connectionId: "int_1" }, store.deps);

  assert.equal(run.status, "SUCCEEDED");
  assert.deepEqual(run.resources[0], {
    resource: "students",
    fetched: 2,
    created: 2,
    updated: 0,
    unchanged: 0,
    errors: 0,
  });
  assert.deepEqual(
    store.created.map((s) => s.studentCode),
    ["S001", "S002"],
  );
  assert.deepEqual(
    store.audits.map((row) => row.action).filter((action) => action.startsWith("integration.sync")),
    ["integration.sync.started", "integration.sync.completed"],
  );
});

test("re-syncing an unchanged roster writes nothing", async () => {
  const store = makeStore();
  await createConnection(makeAdmin(), REST_INPUT, store.deps);
  store.roster.set("S001", {
    id: "stu-1",
    studentCode: "S001",
    firstName: "Asha",
    lastName: "Rao",
    email: "asha@example.edu",
    phone: null,
    status: "ACTIVE",
  });
  store.pages.push([{ student_id: "S001", student_name: "Asha Rao", email: "asha@example.edu" }]);

  const run = await runSync(makeAdmin(), { connectionId: "int_1" }, store.deps);

  assert.equal(run.resources[0].unchanged, 1);
  assert.equal(store.created.length, 0);
  // No write means no audit row and no student.updated webhook for 1,196
  // students who did not change.
  assert.equal(store.updated.length, 0);
});

test("a changed row updates by student id, not by code", async () => {
  const store = makeStore();
  await createConnection(makeAdmin(), REST_INPUT, store.deps);
  store.roster.set("S001", {
    id: "stu-1",
    studentCode: "S001",
    firstName: "Asha",
    lastName: "Rao",
    email: "asha@example.edu",
    phone: null,
    status: "ACTIVE",
  });
  store.pages.push([{ student_id: "S001", student_name: "Asha Raman", email: "asha@example.edu" }]);

  await runSync(makeAdmin(), { connectionId: "int_1" }, store.deps);
  assert.equal(store.updated.length, 1);
  // stu-1, not S001: the code is what the ERP knows, the id is what we write
  // against, and confusing the two writes to whatever row happens to match.
  assert.equal(store.updated[0].studentId, "stu-1");
  assert.equal(store.updated[0].lastName, "Raman");
});

test("a scheduled trigger inside the interval skips without calling the provider", async () => {
  const store = makeStore();
  await createConnection(makeAdmin(), REST_INPUT, store.deps);
  store.pages.push([{ student_id: "S001", student_name: "Asha Rao" }]);
  await runSync(makeAdmin(), { connectionId: "int_1" }, store.deps);
  assert.equal(store.created.length, 1);

  // Same frozen clock, 60-minute interval: the cron's second call in the same
  // minute must not re-pull.
  store.pages.push([{ student_id: "S002", student_name: "Vikram Singh" }]);
  const second = await runSync(makeAdmin(), { connectionId: "int_1", trigger: "scheduled" }, store.deps);

  assert.equal(second.status, "SKIPPED");
  assert.equal(store.created.length, 1);
});

test("a manual trigger runs anyway — that is what the button is for", async () => {
  const store = makeStore();
  await createConnection(makeAdmin(), REST_INPUT, store.deps);
  store.pages.push([{ student_id: "S001", student_name: "Asha Rao" }]);
  await runSync(makeAdmin(), { connectionId: "int_1" }, store.deps);

  store.pages.push([{ student_id: "S002", student_name: "Vikram Singh" }]);
  const second = await runSync(makeAdmin(), { connectionId: "int_1", trigger: "manual" }, store.deps);
  assert.equal(second.status, "SUCCEEDED");
  assert.equal(store.created.length, 2);
});

test("a provider failure marks the connection ERROR and is logged as a failed run", async () => {
  const store = makeStore();
  await createConnection(makeAdmin(), REST_INPUT, store.deps);
  const failing: CenterDeps = {
    ...store.deps,
    provider: () => ({
      ...store.deps.provider!("rest"),
      fetch: async () => {
        throw new Error("502 from upstream");
      },
    }),
  };

  const run = await runSync(makeAdmin(), { connectionId: "int_1" }, failing);
  assert.equal(run.status, "FAILED");

  const view = await getIntegrationCenter(makeAdmin(), store.deps);
  assert.equal(view.connections[0].status, "ERROR");
  assert.equal(view.connections[0].recentErrors[0].message, "502 from upstream");
  assert.equal(store.audits.at(-1)?.action, "integration.sync.failed");
});

// ---------------------------------------------------------------------------
// Import: preview and commit
// ---------------------------------------------------------------------------

const FILE = csv(
  ["student_id,student_name,email", "S001,Asha Rao,asha@example.edu", "S002,Vikram Singh,vikram@example.edu"].join(
    "\n",
  ),
);

test("a preview reports what would happen and writes nothing", async () => {
  const store = makeStore();
  const preview = await previewImport(makeAdmin(), { bytes: FILE, filename: "roster.csv" }, store.deps);

  assert.equal(preview.format, "csv");
  assert.equal(preview.totalRows, 2);
  assert.equal(preview.summary.create, 2);
  assert.equal(preview.summary.error, 0);
  assert.equal(store.created.length, 0);
  assert.equal(store.audits.length, 0);
});

test("the preview's numbers are the commit's numbers", async () => {
  const store = makeStore();
  const preview = await previewImport(makeAdmin(), { bytes: FILE, filename: "roster.csv" }, store.deps);
  const result = await commitImport(
    makeAdmin(),
    { bytes: FILE, filename: "roster.csv", mappings: preview.mappings },
    store.deps,
  );

  assert.equal(result.created, preview.summary.create);
  assert.equal(result.updated, preview.summary.update);
  assert.equal(result.summary.unchanged, preview.summary.unchanged);
  assert.equal(result.errorReport, null);
});

test("a duplicate code inside one file is reported, not last-write-wins", async () => {
  const store = makeStore();
  const file = csv(
    ["student_id,student_name", "S001,Asha Rao", "S001,Asha Raman", "S002,Vikram Singh"].join("\n"),
  );
  const preview = await previewImport(makeAdmin(), { bytes: file, filename: "roster.csv" }, store.deps);

  assert.equal(preview.summary.duplicate, 1);
  assert.equal(preview.duplicates[0].line, 3);

  const result = await commitImport(
    makeAdmin(),
    { bytes: file, filename: "roster.csv", mappings: preview.mappings },
    store.deps,
  );
  assert.equal(result.created, 2);
  assert.ok(result.errorReport, "a file with a duplicate produces a downloadable report");
  assert.match(result.errorReport!.filename, /roster-errors/);
});

test("a row that fails to write is counted and lands in the error report", async () => {
  const store = makeStore();
  store.failCodes.add("S002");

  const preview = await previewImport(makeAdmin(), { bytes: FILE, filename: "roster.csv" }, store.deps);
  const result = await commitImport(
    makeAdmin(),
    { bytes: FILE, filename: "roster.csv", mappings: preview.mappings },
    store.deps,
  );

  // Row by row, not one transaction: one collision must not discard the other
  // row's work, and the partial outcome has to be visible.
  assert.equal(result.created, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.summary.error, 1);
  assert.equal(result.failures[0].key, "S002");
  assert.ok(result.errorReport);
  // Never the driver's message — an error report is a file that gets emailed.
  assert.equal(JSON.stringify(result.failures).includes("Unique constraint"), false);
});

test("a blank column never erases a stored value", async () => {
  const store = makeStore();
  store.roster.set("S001", {
    id: "stu-1",
    studentCode: "S001",
    firstName: "Asha",
    lastName: "Rao",
    email: "asha@example.edu",
    phone: "9000000000",
    status: "ACTIVE",
  });
  const file = csv(["student_id,student_name,email", "S001,Asha Raman,"].join("\n"));

  const preview = await previewImport(makeAdmin(), { bytes: file, filename: "roster.csv" }, store.deps);
  await commitImport(
    makeAdmin(),
    { bytes: file, filename: "roster.csv", mappings: preview.mappings },
    store.deps,
  );

  assert.equal(store.updated.length, 1);
  // The changed column is carried through...
  assert.equal(store.updated[0].lastName, "Raman");
  // ...and the empty one is not sent at all. The single most destructive thing
  // a well-meaning import can do is blank a column for every student, and it
  // looks like a success while doing it.
  assert.equal(Object.hasOwn(store.updated[0], "email"), false);
});

test("an unreadable file is a sentence, not a stack trace", async () => {
  const store = makeStore();
  await assert.rejects(
    () => previewImport(makeAdmin(), { bytes: csv(""), filename: "empty.csv" }, store.deps),
    (error: Error) => error instanceof IntegrationCenterError && /no data rows/.test(error.message),
  );
});

test("importing requires student.read as well as institution.read", async () => {
  const store = makeStore();
  const noRoster = makeAdmin({ permissions: ["institution.read", "institution.update"] });
  await assert.rejects(
    () => previewImport(noRoster, { bytes: FILE, filename: "roster.csv" }, store.deps),
    ForbiddenError,
  );
});

test("a commit is audited with a summary and no row data", async () => {
  const store = makeStore();
  const preview = await previewImport(makeAdmin(), { bytes: FILE, filename: "roster.csv" }, store.deps);
  await commitImport(
    makeAdmin(),
    { bytes: FILE, filename: "roster.csv", mappings: preview.mappings },
    store.deps,
  );

  const row = store.audits.at(-1);
  assert.equal(row?.action, "integration.import.completed");
  // The audit row says what happened, not who is in the file — the students
  // service already wrote a row per student it touched.
  assert.equal(JSON.stringify(row?.after).includes("asha@example.edu"), false);
});
