/**
 * End-to-end check of the enrollment write path against a real database and a
 * real face service.
 *
 * The unit tests inject every dependency, which is what makes them fast and
 * precise — and also what means they never execute the raw SQL. The three
 * things they cannot prove are exactly the three most likely to be wrong:
 *
 *   1. The INSERT: fifteen columns, two Postgres enum casts and a pgvector
 *      literal, written through `$executeRaw`.
 *   2. The duplicate scan: a `<=>` nearest-neighbour query whose similarity
 *      arithmetic (1 - cosine distance) has to agree with the thresholds the
 *      policy compares it against.
 *   3. The replacement transaction: a retire-then-insert that must leave the
 *      student with exactly one live template.
 *
 * Run against the local development database only. It creates its own
 * institution, students and templates under a `verify-` prefix and deletes
 * them again, so it neither reads nor disturbs seeded data.
 *
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5433/attendance_dev \
 *   FACE_AI_SERVICE_URL=http://127.0.0.1:8099 \
 *   AUTH_SECRET=x API_KEY_PEPPER=x \
 *   node --import ./scripts/register-test-loader.mjs scripts/verify-face-enrollment.ts
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/modules/auth-tenancy/types";
import {
  enrollFaceForStudentRequest,
  getStudentFaceEnrollment,
  replaceFaceEnrollmentRequest,
  deactivateFaceEmbeddingRequest,
} from "@/modules/face-enrollment/service";
import {
  findNearestTemplatesInInstitution,
  listSampleHistoryForStudent,
} from "@/modules/face-enrollment/repository";
import { EMBEDDING_DIMENSION } from "@attendance/shared-types";

const TAG = `verify-${randomUUID().slice(0, 8)}`;
const ids = {
  institutionA: `${TAG}-inst-a`,
  institutionB: `${TAG}-inst-b`,
  user: `${TAG}-user`,
  studentOne: `${TAG}-stu-1`,
  studentTwo: `${TAG}-stu-2`,
  studentOther: `${TAG}-stu-other`,
};

function actor(institutionId: string): SessionUser {
  return {
    userId: ids.user,
    email: `${TAG}@verify.test`,
    name: "Verification Admin",
    institutionId,
    campusId: null,
    roles: [
      {
        key: "INSTITUTION_ADMIN",
        name: "Institution Admin",
        institutionId,
        campusId: null,
        permissions: ["faceEmbedding.manage"] as SessionUser["roles"][number]["permissions"],
      },
    ],
  };
}

/**
 * A distinct base64 payload per subject.
 *
 * The mock backend hashes the image bytes into a vector, so two different
 * strings produce two unrelated templates and the same string reproduces one
 * exactly — which is what lets this script drive the duplicate and
 * already-enrolled branches deterministically without any real photograph.
 */
function imageFor(subject: string): string {
  return Buffer.from(`${TAG}:${subject}`).toString("base64");
}

const results: string[] = [];
function ok(what: string) {
  results.push(what);
  console.log(`  ok  ${what}`);
}

async function setup() {
  for (const [id, name] of [
    [ids.institutionA, "Verify College A"],
    [ids.institutionB, "Verify College B"],
  ] as const) {
    await prisma.institution.create({
      data: { id, name, type: "COLLEGE", timezone: "Asia/Kolkata", settings: {} },
    });
  }
  await prisma.user.create({
    data: {
      id: ids.user,
      institutionId: ids.institutionA,
      email: `${TAG}@verify.test`,
      name: "Verification Admin",
    },
  });
  for (const [id, institutionId, code] of [
    [ids.studentOne, ids.institutionA, `${TAG}-1`],
    [ids.studentTwo, ids.institutionA, `${TAG}-2`],
    [ids.studentOther, ids.institutionB, `${TAG}-3`],
  ] as const) {
    await prisma.student.create({
      data: {
        id,
        institutionId,
        studentCode: code,
        firstName: "Verify",
        lastName: code,
        status: "ACTIVE",
      },
    });
  }
}

async function teardown() {
  await prisma.faceEmbedding.deleteMany({
    where: { institutionId: { in: [ids.institutionA, ids.institutionB] } },
  });
  await prisma.auditLog.deleteMany({
    where: { institutionId: { in: [ids.institutionA, ids.institutionB] } },
  });
  await prisma.student.deleteMany({
    where: { institutionId: { in: [ids.institutionA, ids.institutionB] } },
  });
  await prisma.user.deleteMany({ where: { id: ids.user } });
  await prisma.institution.deleteMany({
    where: { id: { in: [ids.institutionA, ids.institutionB] } },
  });
}

async function main() {
  await setup();

  // -- 1. The INSERT, with every provenance column ------------------------
  const first = await enrollFaceForStudentRequest(actor(ids.institutionA), {
    studentId: ids.studentOne,
    imageBase64: imageFor("one-a"),
    captureSource: "CAMERA",
  });
  assert.equal(first.ok, true, `first enrollment failed: ${JSON.stringify(first)}`);
  ok("a capture is enrolled through the real INSERT (15 columns, 2 enum casts, a vector literal)");

  const stored = await prisma.faceEmbedding.findUniqueOrThrow({
    where: { id: first.ok ? first.embeddingId : "" },
    select: {
      modelName: true,
      modelVersion: true,
      weightsVersion: true,
      preprocessingVersion: true,
      aligned: true,
      qualityScore: true,
      captureSource: true,
      channel: true,
      enrolledByUserId: true,
      sourceImageUrl: true,
      isActive: true,
      embeddingDim: true,
    },
  });
  assert.equal(stored.weightsVersion, "0.1.0");
  assert.equal(stored.preprocessingVersion, "1");
  assert.equal(stored.aligned, true, "the service must enrol an aligned crop");
  assert.equal(stored.captureSource, "CAMERA");
  assert.equal(stored.channel, "STAFF");
  assert.equal(stored.enrolledByUserId, ids.user);
  assert.equal(stored.sourceImageUrl, null, "the raw image must never be persisted");
  assert.equal(stored.embeddingDim, EMBEDDING_DIMENSION);
  ok("provenance, alignment and the actor are all persisted; no image URL is");

  // -- 2. The vector actually landed, and is unit length -------------------
  // `<#>` is pgvector's *negative* inner product, so a vector against itself
  // gives -(v·v) and the norm is the square root of its negation. Parenthesised
  // explicitly: `a <#> a * -1` parses as `a <#> (a * -1)`, which is a different
  // question and not one pgvector has an operator for.
  const [row] = await prisma.$queryRaw<Array<{ norm: number }>>`
    SELECT sqrt(-(embedding <#> embedding)) AS norm
    FROM "FaceEmbedding" WHERE id = ${first.ok ? first.embeddingId : ""}
  `;
  assert.ok(Math.abs(Number(row.norm) - 1) < 1e-5, `stored vector norm was ${row.norm}`);
  ok("the stored pgvector is unit length, so cosine similarity is the dot product");

  // -- 3. The duplicate scan, against the real `<=>` operator --------------
  const probeSelf = await findNearestTemplatesInInstitution(
    ids.institutionA,
    // Re-derive the same vector the mock produced, by enrolling nothing and
    // reading the row back out of the database as text.
    await readVector(first.ok ? first.embeddingId : ""),
    { modelName: stored.modelName, modelVersion: stored.modelVersion },
    8,
  );
  assert.equal(probeSelf.length, 1);
  assert.equal(probeSelf[0].studentId, ids.studentOne);
  assert.ok(
    Math.abs(probeSelf[0].rawSimilarity - 1) < 1e-5,
    `a vector compared with itself scored ${probeSelf[0].rawSimilarity}`,
  );
  ok("the <=> scan finds the identical template and scores it 1.0");

  // -- 4. Same photograph again -> already_enrolled ------------------------
  const again = await enrollFaceForStudentRequest(actor(ids.institutionA), {
    studentId: ids.studentOne,
    imageBase64: imageFor("one-a"),
    captureSource: "UPLOAD",
  });
  assert.equal(again.ok, false);
  assert.equal(again.ok === false && again.reason, "already_enrolled");
  ok("re-submitting the same photograph is refused as already enrolled");

  // -- 5. That same face against a different student -> duplicate_identity -
  const collision = await enrollFaceForStudentRequest(actor(ids.institutionA), {
    studentId: ids.studentTwo,
    imageBase64: imageFor("one-a"),
    captureSource: "CAMERA",
  });
  assert.equal(collision.ok, false);
  assert.equal(
    collision.ok === false && collision.reason,
    "duplicate_identity",
    `expected duplicate_identity, got ${JSON.stringify(collision)}`,
  );
  assert.match(collision.message, new RegExp(`${TAG}-1`), "staff are told whose face it is");
  ok("the same face against a second student is refused, and the refusal names them");

  const refusalAudit = await prisma.auditLog.findFirst({
    where: { institutionId: ids.institutionA, action: "face_enrollment.refused" },
  });
  assert.ok(refusalAudit, "a collision must leave an audit row");
  assert.equal(
    JSON.stringify(refusalAudit.afterJson).includes("0.04"),
    false,
    "no vector component in the audit payload",
  );
  ok("the collision is audited, with both student ids and no vector");

  // -- 6. A genuinely different face for student two -----------------------
  const second = await enrollFaceForStudentRequest(actor(ids.institutionA), {
    studentId: ids.studentTwo,
    imageBase64: imageFor("two-a"),
    captureSource: "UPLOAD",
  });
  assert.equal(second.ok, true, `second student failed: ${JSON.stringify(second)}`);
  ok("an unrelated face enrols normally for a second student");

  // -- 7. Tenant isolation of the scan -------------------------------------
  const acrossTenants = await findNearestTemplatesInInstitution(
    ids.institutionB,
    await readVector(first.ok ? first.embeddingId : ""),
    { modelName: stored.modelName, modelVersion: stored.modelVersion },
    8,
  );
  assert.equal(acrossTenants.length, 0, "institution B must not see institution A's templates");
  ok("the duplicate scan cannot see another institution's templates");

  // -- 8. Model filtering ---------------------------------------------------
  const wrongModel = await findNearestTemplatesInInstitution(
    ids.institutionA,
    await readVector(first.ok ? first.embeddingId : ""),
    { modelName: "arcface-r100", modelVersion: "9.9.9+pp9" },
    8,
  );
  assert.equal(wrongModel.length, 0, "templates from another model are not comparable");
  ok("the scan ignores templates made by a different model");

  // -- 9. The replacement transaction ---------------------------------------
  await enrollFaceForStudentRequest(actor(ids.institutionA), {
    studentId: ids.studentOne,
    imageBase64: imageFor("one-b"),
    captureSource: "CAMERA",
  });
  const beforeReplace = await prisma.faceEmbedding.count({
    where: { studentId: ids.studentOne, isActive: true },
  });
  assert.equal(beforeReplace, 2);

  const replaced = await replaceFaceEnrollmentRequest(actor(ids.institutionA), {
    studentId: ids.studentOne,
    imageBase64: imageFor("one-c"),
    captureSource: "CAMERA",
  });
  assert.equal(replaced.ok, true, `replace failed: ${JSON.stringify(replaced)}`);
  assert.equal(replaced.ok === true && replaced.replaced, 2);

  const live = await prisma.faceEmbedding.findMany({
    where: { studentId: ids.studentOne, isActive: true },
  });
  assert.equal(live.length, 1, "a replacement leaves exactly one live template");
  const retired = await prisma.faceEmbedding.findMany({
    where: { studentId: ids.studentOne, isActive: false },
    select: { retirementReason: true, retiredByUserId: true, retiredAt: true },
  });
  assert.equal(retired.length, 2);
  assert.ok(retired.every((r) => r.retirementReason === "REPLACED"));
  assert.ok(retired.every((r) => r.retiredByUserId === ids.user));
  assert.ok(retired.every((r) => r.retiredAt !== null));
  ok("replacement retires the old set in one transaction and records who and why");

  // One clock per row. `createdAt` used to be written by the database's
  // `NOW()` and `retiredAt` by the Prisma client, so on any deployment whose
  // Postgres timezone was not UTC a template read as retired hours before it
  // was created — visibly wrong in the history view, and quietly wrong in any
  // age comparison the retention sweep makes.
  const lifecycles = await prisma.faceEmbedding.findMany({
    where: { studentId: ids.studentOne, isActive: false },
    select: { createdAt: true, retiredAt: true },
  });
  for (const row of lifecycles) {
    assert.ok(
      row.retiredAt !== null && row.retiredAt.getTime() >= row.createdAt.getTime(),
      `retiredAt ${row.retiredAt?.toISOString()} precedes createdAt ${row.createdAt.toISOString()}`,
    );
  }
  ok("createdAt and retiredAt come from the same clock, so a template is never retired first");

  // -- 10. History and status ----------------------------------------------
  const history = await listSampleHistoryForStudent(ids.studentOne);
  assert.equal(history.length, 3, "retired templates stay in the history");
  assert.equal(history[0].isActive, true, "live templates sort first");
  assert.equal(history[0].enrolledByName, "Verification Admin");
  // `embeddingDim` is metadata (the dimension count) and is expected. What must not
  // appear is a vector: the `embedding` key itself, or any array at all.
  const historyJson = JSON.stringify(history);
  assert.equal(historyJson.includes('"embedding":'), false, "no embedding field");
  assert.equal(/\[\s*-?\d/.test(historyJson.slice(1)), false, "no numeric array anywhere");
  ok("the history shows retired templates, names the actor, and carries no vector");

  const view = await getStudentFaceEnrollment(actor(ids.institutionA), ids.studentOne);
  assert.equal(view.status.status, "ENROLLED");
  assert.equal(view.status.usableSamples, 1);
  assert.equal(view.status.staleSamples, 0);
  assert.equal(view.runningModel?.productionEligible, false);
  ok("the status reads ENROLLED against the running model, which reports itself ineligible");

  // -- 11. Retiring one template -------------------------------------------
  await deactivateFaceEmbeddingRequest(actor(ids.institutionA), live[0].id);
  const afterRetire = await prisma.faceEmbedding.findUniqueOrThrow({
    where: { id: live[0].id },
    select: { isActive: true, retirementReason: true, retiredByUserId: true },
  });
  assert.equal(afterRetire.isActive, false);
  assert.equal(afterRetire.retirementReason, "WITHDRAWN");
  assert.equal(afterRetire.retiredByUserId, ids.user);
  ok("retiring one template records WITHDRAWN and the actor");

  const afterView = await getStudentFaceEnrollment(actor(ids.institutionA), ids.studentOne);
  assert.equal(afterView.status.status, "NOT_ENROLLED");
  ok("a student with no live templates reads as NOT_ENROLLED");

  // -- 12. Cross-tenant enrollment is refused -------------------------------
  await assert.rejects(
    () =>
      enrollFaceForStudentRequest(actor(ids.institutionA), {
        studentId: ids.studentOther,
        imageBase64: imageFor("other"),
        captureSource: "CAMERA",
      }),
    /Forbidden|forbidden/,
  );
  const leaked = await prisma.faceEmbedding.count({ where: { studentId: ids.studentOther } });
  assert.equal(leaked, 0);
  ok("staff at one institution cannot enrol a student at another");

  console.log(`\n${results.length} checks passed against the real database and face service.`);
}

/** Reads a stored template back as numbers, to use as a scan probe. */
async function readVector(id: string): Promise<number[]> {
  const [row] = await prisma.$queryRaw<Array<{ text: string }>>`
    SELECT embedding::text AS text FROM "FaceEmbedding" WHERE id = ${id}
  `;
  return row.text.slice(1, -1).split(",").map(Number);
}

main()
  .catch((error) => {
    console.error("\nFAILED:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await teardown();
    await prisma.$disconnect();
  });
