import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RetentionPolicyError,
  deleteStudentFaceData,
  getRetentionPolicy,
  runRetentionSweep,
  updateRetentionPolicy,
  type PrivacyDeps,
} from "./service.ts";
import { DEFAULT_RETENTION_POLICY, RETENTION_SETTINGS_KEY } from "./types.ts";
import { ForbiddenError } from "../authorization/types.ts";
import type { SessionUser } from "../auth-tenancy/types.ts";
import type { Student } from "../students/types.ts";

/**
 * Retention service tests — authorization, tenant isolation and audit.
 *
 * `policy.test.ts` proves what the policy decides. This file proves who is
 * allowed to ask, whose data is in scope when they do, and what ends up in the
 * audit log afterwards. Every dependency is injected, so the suite runs with no
 * database and no clock.
 *
 * Two properties are asserted repeatedly on purpose, because they are the ones
 * that would make this module a vulnerability rather than a control:
 *
 *   1. Every repository call carries the *caller's* institution id.
 *   2. No embedding vector reaches an audit row.
 */

const NOW = new Date("2026-06-01T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * DAY);
}

type Permissions = SessionUser["roles"][number]["permissions"];

function makeUser(overrides: {
  permissions?: string[];
  institutionId?: string | null;
  userId?: string;
} = {}): SessionUser {
  return {
    userId: overrides.userId ?? "user-admin",
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
          "faceEmbedding.manage",
        ]) as Permissions,
      },
    ],
  };
}

/** A student the roster lookup will return. `inst-B` is the other tenant. */
function makeStudent(overrides: Partial<Student> = {}): Student {
  return {
    id: "stu-1",
    institutionId: "inst-A",
    studentCode: "S1",
    firstName: "Ada",
    lastName: "Lovelace",
    status: "ACTIVE",
    ...overrides,
  } as Student;
}

interface Call {
  fn: string;
  institutionId: string;
  ids?: string[];
}

interface Store {
  deps: PrivacyDeps;
  calls: Call[];
  audits: Array<{ action: string; entityId: string; institutionId?: string | null; after?: unknown; before?: unknown }>;
  settings: Record<string, unknown>;
  templates: Array<{ id: string; studentId: string; isActive: boolean; createdAt: Date; studentStatus: string }>;
  images: Array<{ id: string; capturedAt: Date }>;
  student: Student | null;
}

function makeStore(): Store {
  const store: Store = {
    calls: [],
    audits: [],
    settings: {},
    templates: [],
    images: [],
    student: makeStudent(),
    deps: {},
  };

  store.deps = {
    getSettings: async (institutionId) => ({ id: institutionId, settings: store.settings }),
    writeSettings: async (_institutionId, next) => {
      // Round-tripped through JSON the way a Json column would, so a test
      // cannot pass on an object shape Postgres would not have returned.
      store.settings = JSON.parse(JSON.stringify(next)) as Record<string, unknown>;
    },
    listTemplates: async (institutionId) => {
      store.calls.push({ fn: "listTemplates", institutionId });
      return store.templates;
    },
    deactivateTemplates: async (institutionId, ids) => {
      store.calls.push({ fn: "deactivateTemplates", institutionId, ids: [...ids] });
      for (const row of store.templates) if (ids.includes(row.id)) row.isActive = false;
      return ids.length;
    },
    deleteTemplates: async (institutionId, ids) => {
      store.calls.push({ fn: "deleteTemplates", institutionId, ids: [...ids] });
      store.templates = store.templates.filter((row) => !ids.includes(row.id));
      return ids.length;
    },
    listTemplateIdsForStudent: async (institutionId, studentId) => {
      store.calls.push({ fn: "listTemplateIdsForStudent", institutionId });
      return store.templates.filter((row) => row.studentId === studentId).map((row) => row.id);
    },
    listClassroomImages: async (institutionId) => {
      store.calls.push({ fn: "listClassroomImages", institutionId });
      return store.images;
    },
    deleteClassroomImages: async (institutionId, ids) => {
      store.calls.push({ fn: "deleteClassroomImages", institutionId, ids: [...ids] });
      return ids.length;
    },
    getStudentById: async () => store.student,
    releaseGalleryFaces: async () => ({ removed: 0, pending: 0 }),
    audit: async (input) => {
      store.audits.push({
        action: input.action,
        entityId: input.entityId,
        institutionId: input.institutionId,
        after: input.afterJson,
        before: input.beforeJson,
      });
    },
    now: () => NOW,
  };

  return store;
}

/** Asserts no repository call touched a tenant other than the caller's. */
function assertScopedTo(store: Store, institutionId: string): void {
  for (const call of store.calls) {
    assert.equal(call.institutionId, institutionId, `${call.fn} escaped the caller's institution`);
  }
}

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

test("reading the policy requires institution.read", async () => {
  const store = makeStore();
  await assert.rejects(
    () => getRetentionPolicy(makeUser({ permissions: [] }), store.deps),
    ForbiddenError,
  );
});

test("a teacher who can read the institution cannot change the retention policy", async () => {
  const store = makeStore();
  const teacher = makeUser({ permissions: ["institution.read", "attendanceSession.capture"] });
  await assert.rejects(
    () =>
      updateRetentionPolicy(
        teacher,
        {
          faceTemplateRetentionDays: 1,
          onStudentInactive: "DELETE",
          deactivatedTemplateGraceDays: 0,
          classroomImageStorage: "NEVER",
          classroomImageRetentionDays: 0,
        },
        store.deps,
      ),
    ForbiddenError,
  );
  // And nothing was written on the way to the refusal.
  assert.deepEqual(store.settings, {});
});

test("changing the policy does not imply permission to run the sweep that enforces it", async () => {
  // `institution.update` configures; `faceEmbedding.manage` destroys. An
  // administrator with only the first can set a 30-day period and must still
  // not be able to trigger the deletion themselves.
  const store = makeStore();
  const configurer = makeUser({ permissions: ["institution.read", "institution.update"] });
  await assert.rejects(() => runRetentionSweep(configurer, store.deps), ForbiddenError);
  await assert.rejects(() => deleteStudentFaceData(configurer, "stu-1", store.deps), ForbiddenError);
  assert.equal(store.calls.length, 0);
});

test("a student cannot reach any of it, including their own face data", async () => {
  const store = makeStore();
  const student = makeUser({
    permissions: ["faceEmbedding.enroll.own", "attendanceRecord.read.own"],
    userId: "user-student",
  });
  await assert.rejects(() => getRetentionPolicy(student, store.deps), ForbiddenError);
  await assert.rejects(() => runRetentionSweep(student, store.deps), ForbiddenError);
  await assert.rejects(() => deleteStudentFaceData(student, "stu-1", store.deps), ForbiddenError);
  assert.equal(store.calls.length, 0);
});

test("a platform account with no institution is refused rather than defaulted to a tenant", async () => {
  const store = makeStore();
  const platform = makeUser({ institutionId: null });
  await assert.rejects(() => runRetentionSweep(platform, store.deps), RetentionPolicyError);
  assert.equal(store.calls.length, 0);
});

// ---------------------------------------------------------------------------
// Tenant isolation
// ---------------------------------------------------------------------------

test("an admin cannot delete face data belonging to another institution", async () => {
  const store = makeStore();
  store.student = makeStudent({ id: "stu-B", institutionId: "inst-B" });

  await assert.rejects(
    () => deleteStudentFaceData(makeUser(), "stu-B", store.deps),
    ForbiddenError,
  );
  // Refused before any delete was attempted — not merely reported as zero.
  assert.equal(store.calls.some((call) => call.fn === "deleteTemplates"), false);
  assert.equal(store.audits.length, 0);
});

test("every repository call in a sweep carries the caller's own institution", async () => {
  const store = makeStore();
  store.templates = [
    { id: "e1", studentId: "s1", isActive: true, createdAt: daysAgo(1), studentStatus: "INACTIVE" },
    { id: "e2", studentId: "s2", isActive: false, createdAt: daysAgo(99), studentStatus: "ACTIVE" },
  ];
  store.images = [{ id: "img-1", capturedAt: daysAgo(1) }];

  await runRetentionSweep(makeUser(), store.deps);
  assertScopedTo(store, "inst-A");
});

test("a deletion for a student who no longer exists is refused, not applied blindly", async () => {
  const store = makeStore();
  store.student = null;
  await assert.rejects(() => deleteStudentFaceData(makeUser(), "ghost", store.deps), RetentionPolicyError);
  assert.equal(store.calls.some((call) => call.fn === "deleteTemplates"), false);
});

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

test("a sweep under the shipped defaults changes nothing for an ordinary roster", async () => {
  // The most important test in the file. Enabling this module must not delete
  // anything at any institution that has not configured it.
  const store = makeStore();
  store.templates = [
    { id: "e1", studentId: "s1", isActive: true, createdAt: daysAgo(4000), studentStatus: "ACTIVE" },
    { id: "e2", studentId: "s2", isActive: true, createdAt: daysAgo(10), studentStatus: "ACTIVE" },
  ];

  const summary = await runRetentionSweep(makeUser(), store.deps);
  assert.equal(summary.deletedTemplates, 0);
  assert.equal(summary.deactivatedForAge, 0);
  assert.equal(summary.deactivatedForInactiveStudent, 0);
  assert.equal(store.templates.length, 2);
  assert.deepEqual(summary.policy, DEFAULT_RETENTION_POLICY);
});

test("the sweep separates why each template was deactivated", async () => {
  const store = makeStore();
  store.settings = {
    [RETENTION_SETTINGS_KEY]: { ...DEFAULT_RETENTION_POLICY, faceTemplateRetentionDays: 30 },
  };
  store.templates = [
    { id: "left", studentId: "s1", isActive: true, createdAt: daysAgo(1), studentStatus: "TRANSFERRED" },
    { id: "old", studentId: "s2", isActive: true, createdAt: daysAgo(31), studentStatus: "ACTIVE" },
    { id: "fine", studentId: "s3", isActive: true, createdAt: daysAgo(2), studentStatus: "ACTIVE" },
  ];

  const summary = await runRetentionSweep(makeUser(), store.deps);
  assert.equal(summary.deactivatedForInactiveStudent, 1);
  assert.equal(summary.deactivatedForAge, 1);
  assert.equal(summary.deletedTemplates, 0);

  const deactivations = store.calls.filter((call) => call.fn === "deactivateTemplates");
  assert.deepEqual(deactivations[0]?.ids, ["left"]);
  assert.deepEqual(deactivations[1]?.ids, ["old"]);
});

test("running the sweep twice over an unchanged database is a no-op the second time", async () => {
  const store = makeStore();
  store.settings = {
    [RETENTION_SETTINGS_KEY]: { ...DEFAULT_RETENTION_POLICY, faceTemplateRetentionDays: 30 },
  };
  store.templates = [
    { id: "old", studentId: "s1", isActive: true, createdAt: daysAgo(31), studentStatus: "ACTIVE" },
  ];

  const first = await runRetentionSweep(makeUser(), store.deps);
  assert.equal(first.deactivatedForAge, 1);

  const second = await runRetentionSweep(makeUser(), store.deps);
  assert.equal(second.deactivatedForAge, 0);
  // Now inactive and 31 days old, under a 30-day grace period it is deleted —
  // which is progress through the lifecycle, not a repeat of the first action.
  assert.equal(second.deletedTemplates, 1);

  const third = await runRetentionSweep(makeUser(), store.deps);
  assert.equal(third.deletedTemplates, 0);
  assert.equal(third.deactivatedForAge, 0);
});

test("stored classroom images are removed under the default NEVER policy", async () => {
  const store = makeStore();
  store.images = [
    { id: "img-1", capturedAt: NOW },
    { id: "img-2", capturedAt: daysAgo(400) },
  ];

  const summary = await runRetentionSweep(makeUser(), store.deps);
  assert.equal(summary.deletedClassroomImages, 2);
});

test("an institution that explicitly retains images keeps the ones inside the period", async () => {
  const store = makeStore();
  store.settings = {
    [RETENTION_SETTINGS_KEY]: {
      ...DEFAULT_RETENTION_POLICY,
      classroomImageStorage: "RETAIN_FOR_DAYS",
      classroomImageRetentionDays: 7,
    },
  };
  store.images = [
    { id: "fresh", capturedAt: daysAgo(1) },
    { id: "stale", capturedAt: daysAgo(30) },
  ];

  const summary = await runRetentionSweep(makeUser(), store.deps);
  assert.equal(summary.deletedClassroomImages, 1);
  const call = store.calls.find((c) => c.fn === "deleteClassroomImages");
  assert.deepEqual(call?.ids, ["stale"]);
});

// ---------------------------------------------------------------------------
// Explicit erasure
// ---------------------------------------------------------------------------

test("erasing a student's face data removes every template, active or not", async () => {
  const store = makeStore();
  store.templates = [
    { id: "a", studentId: "stu-1", isActive: true, createdAt: daysAgo(1), studentStatus: "ACTIVE" },
    { id: "b", studentId: "stu-1", isActive: false, createdAt: daysAgo(2), studentStatus: "ACTIVE" },
    { id: "c", studentId: "stu-2", isActive: true, createdAt: daysAgo(3), studentStatus: "ACTIVE" },
  ];

  const summary = await deleteStudentFaceData(makeUser(), "stu-1", store.deps);
  assert.equal(summary.deletedTemplates, 2);
  // The other student's template is untouched.
  assert.deepEqual(store.templates.map((row) => row.id), ["c"]);
});

test("erasure is refused, and deletes nothing, while the provider still holds a face", async () => {
  const store = makeStore();
  store.templates = [
    { id: "a", studentId: "stu-1", isActive: true, createdAt: daysAgo(1), studentStatus: "ACTIVE" },
  ];
  const calls: Array<{ studentIds: readonly string[]; includeActive: boolean }> = [];
  const deps: PrivacyDeps = {
    ...store.deps,
    releaseGalleryFaces: async (_institutionId, studentIds, options) => {
      calls.push({ studentIds, includeActive: options.includeActive });
      return { removed: 1, pending: 2 };
    },
  };
  await assert.rejects(() => deleteStudentFaceData(makeUser(), "stu-1", deps), RetentionPolicyError);
  assert.deepEqual(calls, [{ studentIds: ["stu-1"], includeActive: true }]);
  assert.deepEqual(store.templates.map((row) => row.id), ["a"]);
});

test("erasure is recorded even when the student had no templates to erase", async () => {
  const store = makeStore();
  const summary = await deleteStudentFaceData(makeUser(), "stu-1", store.deps);
  assert.equal(summary.deletedTemplates, 0);
  assert.equal(store.audits.at(-1)?.action, "face_enrollment.deleted");
});

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

test("a sweep that found nothing to do is still logged", async () => {
  const store = makeStore();
  await runRetentionSweep(makeUser(), store.deps);
  const row = store.audits.at(-1);
  assert.equal(row?.action, "face_data.retention_purged");
  assert.equal(row?.institutionId, "inst-A");
});

test("a policy change logs both the old policy and the new one", async () => {
  const store = makeStore();
  store.settings = {
    [RETENTION_SETTINGS_KEY]: { ...DEFAULT_RETENTION_POLICY, faceTemplateRetentionDays: 365 },
  };

  await updateRetentionPolicy(
    makeUser(),
    {
      faceTemplateRetentionDays: 30,
      onStudentInactive: "DELETE",
      deactivatedTemplateGraceDays: 7,
      classroomImageStorage: "NEVER",
      classroomImageRetentionDays: 0,
    },
    store.deps,
  );

  const row = store.audits.at(-1);
  assert.equal(row?.action, "face_data.retention_policy_updated");
  assert.equal((row?.before as { faceTemplateRetentionDays: number }).faceTemplateRetentionDays, 365);
  assert.equal((row?.after as { faceTemplateRetentionDays: number }).faceTemplateRetentionDays, 30);
});

test("a rejected policy change writes neither settings nor an audit row", async () => {
  const store = makeStore();
  await assert.rejects(
    () =>
      updateRetentionPolicy(
        makeUser(),
        {
          faceTemplateRetentionDays: 0,
          onStudentInactive: "DEACTIVATE",
          deactivatedTemplateGraceDays: 0,
          classroomImageStorage: "RETAIN_FOR_DAYS",
          classroomImageRetentionDays: 0,
        },
        store.deps,
      ),
    RetentionPolicyError,
  );
  assert.deepEqual(store.settings, {});
  assert.equal(store.audits.length, 0);
});

test("saving a retention policy preserves an integration connection stored beside it", async () => {
  const store = makeStore();
  store.settings = { integrations: { connections: [{ id: "int-1", name: "SIS" }] } };

  await updateRetentionPolicy(
    makeUser(),
    {
      faceTemplateRetentionDays: 90,
      onStudentInactive: "DEACTIVATE",
      deactivatedTemplateGraceDays: 30,
      classroomImageStorage: "NEVER",
      classroomImageRetentionDays: 0,
    },
    store.deps,
  );

  assert.deepEqual(store.settings.integrations, { connections: [{ id: "int-1", name: "SIS" }] });
});

test("no audit payload from this module contains anything resembling an embedding", async () => {
  // The module reads and deletes biometric rows; the audit log is the one
  // artefact it produces that is meant to be read widely and exported. A
  // vector reaching it would undo the rest of the module.
  const store = makeStore();
  store.settings = {
    [RETENTION_SETTINGS_KEY]: { ...DEFAULT_RETENTION_POLICY, faceTemplateRetentionDays: 1 },
  };
  store.templates = [
    { id: "e1", studentId: "stu-1", isActive: true, createdAt: daysAgo(10), studentStatus: "ACTIVE" },
  ];

  await runRetentionSweep(makeUser(), store.deps);
  await deleteStudentFaceData(makeUser(), "stu-1", store.deps);

  for (const row of store.audits) {
    const serialised = JSON.stringify(row);
    assert.equal(/embedding"\s*:\s*\[/.test(serialised), false, "an audit payload carried a vector");
    assert.equal(serialised.includes("vector"), false);
    // No long numeric array of any name — a 512-float template is recognisable
    // by shape whatever the key is called.
    assert.equal(/\[(?:-?\d+\.\d+,){8}/.test(serialised), false);
  }
});
