import { test } from "node:test";
import assert from "node:assert/strict";
import { getAdminSettings, updateAttendanceSettings, updateFacePolicy } from "./service.ts";
import { AdminSettingsError, DEFAULT_FACE_POLICY } from "./types.ts";
import type { RecordAuditLogInput } from "../audit/types.ts";
import type { SessionUser } from "../auth-tenancy/types.ts";
import { ForbiddenError } from "../authorization/types.ts";
import type { Institution } from "../institutions/types.ts";

/**
 * Settings service tests: authorization, tenancy and the audit trail.
 *
 * Every dependency is injected, so these run with no database. What they are
 * really asserting is the three things a configuration surface can get wrong
 * in a way nobody notices until it matters: that a reader cannot write, that
 * an administrator cannot reach another institution, and that a change to the
 * numbers deciding attendance leaves a record naming who made it.
 */

type Permissions = SessionUser["roles"][number]["permissions"];

function makeUser(
  overrides: { permissions?: string[]; institutionId?: string | null; userId?: string } = {},
): SessionUser {
  return {
    userId: overrides.userId ?? "user-admin",
    email: "admin@example.edu",
    name: "Admin",
    institutionId: overrides.institutionId === undefined ? "inst-1" : overrides.institutionId,
    campusId: null,
    roles: [
      {
        key: "INSTITUTION_ADMIN",
        name: "Institution Admin",
        institutionId: "inst-1",
        campusId: null,
        permissions: (overrides.permissions ?? [
          "institution.read",
          "institution.update",
        ]) as Permissions,
      },
    ],
  };
}

const ADMIN = makeUser();
const READER = makeUser({ userId: "user-reader", permissions: ["institution.read"] });
const PLATFORM = makeUser({ userId: "user-platform", institutionId: null });

function institution(settings: unknown): Institution {
  return {
    id: "inst-1",
    name: "Example College",
    type: "COLLEGE",
    settings,
  } as unknown as Institution;
}

interface Harness {
  written: Array<{ institutionId: string; settings: Record<string, unknown> }>;
  audited: RecordAuditLogInput[];
  deps: {
    getSettings: (id: string) => Promise<{ id: string; settings: unknown } | null>;
    writeSettings: (id: string, settings: Record<string, unknown>) => Promise<void>;
    getInstitution: (id: string) => Promise<Institution | null>;
    audit: (input: RecordAuditLogInput) => Promise<void>;
  };
}

function harness(settings: unknown = {}): Harness {
  const written: Harness["written"] = [];
  const audited: RecordAuditLogInput[] = [];
  return {
    written,
    audited,
    deps: {
      getSettings: async (id) => ({ id, settings }),
      writeSettings: async (institutionId, next) => {
        written.push({ institutionId, settings: next });
      },
      getInstitution: async () => institution(settings),
      audit: async (input) => {
        audited.push(input);
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

test("a user with only institution.read cannot change the recognition thresholds", async () => {
  const h = harness();
  await assert.rejects(
    () =>
      updateFacePolicy(
        READER,
        { presentMin: 0.5, reviewMin: 0.3, ambiguityMargin: 0.05, minDetectionConfidence: 0.5 },
        h.deps,
      ),
    ForbiddenError,
  );
  assert.equal(h.written.length, 0, "nothing was written");
  assert.equal(h.audited.length, 0);
});

test("a user with only institution.read cannot change the attendance settings", async () => {
  const h = harness();
  await assert.rejects(
    () =>
      updateAttendanceSettings(
        READER,
        {
          attendanceMode: "DAILY",
          lowAttendanceThreshold: 75,
          correctionWindowDays: 0,
          requireReasonAfterFinalization: false,
        },
        h.deps,
      ),
    ForbiddenError,
  );
  assert.equal(h.written.length, 0);
});

test("a platform account with no institution is refused rather than defaulted to one", async () => {
  const h = harness();
  await assert.rejects(() => getAdminSettings(PLATFORM, h.deps), AdminSettingsError);
  await assert.rejects(
    () =>
      updateFacePolicy(
        PLATFORM,
        { presentMin: 0.7, reviewMin: 0.5, ambiguityMargin: 0.05, minDetectionConfidence: 0.5 },
        h.deps,
      ),
    AdminSettingsError,
  );
  assert.equal(h.written.length, 0);
});

test("the institution written to is the session's, and there is no parameter for another", async () => {
  const h = harness();
  await updateFacePolicy(
    ADMIN,
    { presentMin: 0.7, reviewMin: 0.5, ambiguityMargin: 0.05, minDetectionConfidence: 0.5 },
    h.deps,
  );
  assert.equal(h.written[0].institutionId, "inst-1");
  assert.equal(h.audited[0].institutionId, "inst-1");
});

// ---------------------------------------------------------------------------
// Validation happens before anything is written
// ---------------------------------------------------------------------------

test("an invalid threshold pair is refused without touching the database", async () => {
  const h = harness();
  await assert.rejects(
    () =>
      updateFacePolicy(
        ADMIN,
        { presentMin: 0.5, reviewMin: 0.6, ambiguityMargin: 0.05, minDetectionConfidence: 0.5 },
        h.deps,
      ),
    AdminSettingsError,
  );
  assert.equal(h.written.length, 0, "a refused submission writes nothing");
  assert.equal(h.audited.length, 0, "a refused submission audits nothing");
});

test("a low-attendance threshold outside 0-100 is refused", async () => {
  const h = harness();
  await assert.rejects(
    () =>
      updateAttendanceSettings(
        ADMIN,
        {
          attendanceMode: "DAILY",
          lowAttendanceThreshold: 175,
          correctionWindowDays: 0,
          requireReasonAfterFinalization: false,
        },
        h.deps,
      ),
    AdminSettingsError,
  );
  assert.equal(h.written.length, 0);
});

test("an unrecognised attendance mode is refused", async () => {
  const h = harness();
  await assert.rejects(
    () =>
      updateAttendanceSettings(
        ADMIN,
        {
          attendanceMode: "WHENEVER",
          lowAttendanceThreshold: 75,
          correctionWindowDays: 0,
          requireReasonAfterFinalization: false,
        },
        h.deps,
      ),
    AdminSettingsError,
  );
});

// ---------------------------------------------------------------------------
// The audit trail
// ---------------------------------------------------------------------------

test("a threshold change records the previous policy, the new one, and the warnings shown", async () => {
  const h = harness({ confidenceThresholds: { presentMin: 0.62, reviewMin: 0.45 } });
  await updateFacePolicy(
    ADMIN,
    { presentMin: 0.5, reviewMin: 0.3, ambiguityMargin: 0.05, minDetectionConfidence: 0.5 },
    h.deps,
  );

  assert.equal(h.audited.length, 1);
  const row = h.audited[0];
  assert.equal(row.action, "institution.face_policy_updated");
  assert.equal(row.entityType, "Institution");
  assert.equal(row.actorUserId, "user-admin");
  assert.deepEqual(row.beforeJson, DEFAULT_FACE_POLICY);

  const after = row.afterJson as { presentMin: number; warnings: string[] };
  assert.equal(after.presentMin, 0.5);
  assert.ok(
    after.warnings.some((w) => /marked present who were not there/.test(w)),
    "the warning the administrator was shown travels into the audit row",
  );
});

test("an attendance settings change is audited with before and after", async () => {
  const h = harness({ attendanceMode: "DAILY", lowAttendanceThreshold: 75 });
  await updateAttendanceSettings(
    ADMIN,
    {
      attendanceMode: "SUBJECT_WISE",
      lowAttendanceThreshold: 80,
      correctionWindowDays: 14,
      requireReasonAfterFinalization: true,
    },
    h.deps,
  );

  const row = h.audited[0];
  assert.equal(row.action, "institution.attendance_policy_updated");
  assert.deepEqual(row.beforeJson, {
    attendanceMode: "DAILY",
    lowAttendanceThreshold: 75,
    policy: { correctionWindowDays: 0, requireReasonAfterFinalization: false },
  });
  assert.deepEqual(row.afterJson, {
    attendanceMode: "SUBJECT_WISE",
    lowAttendanceThreshold: 80,
    policy: { correctionWindowDays: 14, requireReasonAfterFinalization: true },
  });
});

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

test("the settings view reports the defaults for an unconfigured institution", async () => {
  const h = harness({});
  const view = await getAdminSettings(ADMIN, h.deps);
  assert.deepEqual(view.facePolicy, DEFAULT_FACE_POLICY);
  assert.deepEqual(view.faceWarnings, []);
  assert.deepEqual(view.faceChangedFields, []);
  // COLLEGE with nothing configured means subject-wise, matching
  // resolveAttendanceMode in modules/institutions/service.ts.
  assert.equal(view.attendanceMode, "SUBJECT_WISE");
  assert.equal(view.lowAttendanceThreshold, 75);
});

test("the settings view flags which recognition values differ from the defaults", async () => {
  const h = harness({
    confidenceThresholds: { presentMin: 0.75, reviewMin: 0.45 },
    faceRecognitionPolicy: { ambiguityMargin: 0.05, minDetectionConfidence: 0.5 },
  });
  const view = await getAdminSettings(ADMIN, h.deps);
  assert.deepEqual(view.faceChangedFields, ["presentMin"]);
});

test("a settings write preserves the keys this module does not own", async () => {
  const h = harness({
    integrationConnections: [{ id: "conn-1" }],
    biometricRetention: { faceTemplateRetentionDays: 30 },
  });
  await updateAttendanceSettings(
    ADMIN,
    {
      attendanceMode: "DAILY",
      lowAttendanceThreshold: 60,
      correctionWindowDays: 3,
      requireReasonAfterFinalization: false,
    },
    h.deps,
  );
  const saved = h.written[0].settings;
  assert.deepEqual(saved.integrationConnections, [{ id: "conn-1" }]);
  assert.deepEqual(saved.biometricRetention, { faceTemplateRetentionDays: 30 });
});
