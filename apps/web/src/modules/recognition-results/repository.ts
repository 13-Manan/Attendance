import { EMBEDDING_DIMENSION } from "@attendance/shared-types";
import { prisma } from "@/lib/prisma";

export interface CandidateEmbedding {
  id: string;
  studentId: string;
  modelName: string;
  modelVersion: string;
}

/** Same shape as `CandidateEmbedding` with the raw vector attached. Distinct
 * type so a caller wanting metadata cannot accidentally pull the vector via
 * a shared function signature — every use of `CandidateEmbeddingWithVector`
 * is a deliberate load of biometric material. */
export interface CandidateEmbeddingWithVector extends CandidateEmbedding {
  embedding: number[];
  embeddingDim: number;
}

/**
 * The ONLY entry point for retrieving face-embedding candidates. There is
 * deliberately no function anywhere in this codebase that accepts zero
 * scope and searches embeddings globally — "students must only be
 * searchable/matched against the relevant classroom/class/section
 * population" (ARCHITECTURE.md) is enforced by this function's signature,
 * not by caller discipline. It joins through Enrollment so only students
 * actively enrolled in the given cohort are ever candidates, regardless of
 * how many other students exist in the same institution or elsewhere.
 *
 * Returns candidate rows only (no embedding vectors) — the actual `<=>`
 * cosine-distance ranking against a query vector is wired up when the
 * recognition pipeline is implemented (still deferred from Phase 1,
 * ADR-0002); this function exists now so that pipeline has nowhere else to
 * plug in except a cohort-scoped query.
 *
 * `model` narrows candidates to embeddings produced by one model build.
 * Vectors from two different models (or two different preprocessing
 * versions of the same weights) occupy unrelated spaces, so a cosine score
 * between them is a meaningless number that happens to be in range — and a
 * meaningless number near 1.0 is a false match against a real student. A
 * caller that omits `model` is asking for every candidate regardless of
 * provenance, which is only correct while a single model has ever been
 * used; the recognition pipeline is expected to pass it.
 */
export async function findCandidateEmbeddingsForCohort(
  cohortId: string,
  model?: { modelName: string; modelVersion: string },
): Promise<CandidateEmbedding[]> {
  return prisma.faceEmbedding.findMany({
    where: {
      isActive: true,
      student: {
        enrollments: { some: { cohortId, status: "ACTIVE" } },
      },
      ...(model ? { modelName: model.modelName, modelVersion: model.modelVersion } : {}),
    },
    select: { id: true, studentId: true, modelName: true, modelVersion: true },
  });
}

/**
 * The recognition engine's cohort-scoped vector loader.
 *
 * A separate function from `findCandidateEmbeddingsForCohort` because the
 * vector column is `Unsupported("vector(512)")` in Prisma — it must be
 * cast to text on the server and parsed here. The parsing lives in this
 * repository so callers never see a raw pgvector literal.
 *
 * Every access to biometric templates for recognition passes through this
 * function; the cohort filter is required (no unscoped variant, same rule
 * as `findCandidateEmbeddingsForCohort`).
 */
export async function findCandidateEmbeddingsWithVectorsForCohort(
  cohortId: string,
  model?: { modelName: string; modelVersion: string },
): Promise<CandidateEmbeddingWithVector[]> {
  // Parametrised `$queryRaw`: `cohortId` and the optional model fields are
  // bound values, so this is not string interpolation into SQL. The vector
  // column is cast to text ('[a,b,c]') on the server and parsed here.
  //
  // We deliberately do not use pgvector's `<=>` operator or any nearest-
  // neighbour ordering: recognition ranking happens in-process against the
  // exact cohort so the same cosine implementation is used for every
  // score (see modules/recognition-engine/service.ts and
  // services/face-ai/app/matching.py). A future performance phase can
  // switch this to a `<=>` pre-filter without changing the wire behaviour.
  const rows = await prisma.$queryRaw<
    Array<{
      id: string;
      studentId: string;
      modelName: string;
      modelVersion: string;
      embeddingDim: number;
      embeddingText: string;
    }>
  >`
    SELECT
      fe.id,
      fe."studentId"     AS "studentId",
      fe."modelName"     AS "modelName",
      fe."modelVersion"  AS "modelVersion",
      fe."embeddingDim"  AS "embeddingDim",
      fe.embedding::text AS "embeddingText"
    FROM "FaceEmbedding" fe
    INNER JOIN "Enrollment" en
      ON en."studentId" = fe."studentId"
     AND en."cohortId" = ${cohortId}
     AND en.status = 'ACTIVE'
    WHERE fe."isActive" = TRUE
      -- Gallery samples (Azure) carry no vector and are matched by the
      -- provider, never here. The model filter already excludes them.
      AND fe.embedding IS NOT NULL
      AND (${model?.modelName ?? null}::text IS NULL OR fe."modelName" = ${model?.modelName ?? null})
      AND (${model?.modelVersion ?? null}::text IS NULL OR fe."modelVersion" = ${model?.modelVersion ?? null})
  `;

  return rows.map((r) => {
    const parsed = parsePgVectorLiteral(r.embeddingText);
    if (parsed.length !== EMBEDDING_DIMENSION) {
      // Not a hard throw: silently dropping is exactly what
      // `score_candidates` in face-ai already guards against (the caller
      // gets a `skippedIncompatibleCandidates` count). We keep the row so
      // the recognition service can count it and the reviewer can be told.
    }
    return {
      id: r.id,
      studentId: r.studentId,
      modelName: r.modelName,
      modelVersion: r.modelVersion,
      embeddingDim: r.embeddingDim,
      embedding: parsed,
    };
  });
}

/**
 * The narrower, subject-scoped vector loader — the correct pool for a college
 * session attached to a `CohortSubject` with per-student (elective)
 * enrollment.
 *
 * Narrower is safer. False acceptance grows with pool size: every extra
 * template a face is compared against is another chance for a stranger to
 * out-score the right student. A subject of 18 elective students should not
 * be searched against the 60-student cohort that contains them.
 *
 * The cohort `Enrollment` join is kept as well as the subject join: a student
 * who left the cohort but whose subject row was never cleaned up must not
 * reappear in a classroom search.
 */
export async function findCandidateEmbeddingsWithVectorsForCohortSubject(
  cohortSubjectId: string,
  model?: { modelName: string; modelVersion: string },
): Promise<CandidateEmbeddingWithVector[]> {
  const rows = await prisma.$queryRaw<
    Array<{
      id: string;
      studentId: string;
      modelName: string;
      modelVersion: string;
      embeddingDim: number;
      embeddingText: string;
    }>
  >`
    SELECT
      fe.id,
      fe."studentId"     AS "studentId",
      fe."modelName"     AS "modelName",
      fe."modelVersion"  AS "modelVersion",
      fe."embeddingDim"  AS "embeddingDim",
      fe.embedding::text AS "embeddingText"
    FROM "FaceEmbedding" fe
    INNER JOIN "StudentSubjectEnrollment" sse
      ON sse."studentId" = fe."studentId"
     AND sse."cohortSubjectId" = ${cohortSubjectId}
    INNER JOIN "CohortSubject" cs
      ON cs.id = sse."cohortSubjectId"
    INNER JOIN "Enrollment" en
      ON en."studentId" = fe."studentId"
     AND en."cohortId" = cs."cohortId"
     AND en.status = 'ACTIVE'
    WHERE fe."isActive" = TRUE
      -- Gallery samples (Azure) carry no vector and are matched by the
      -- provider, never here. The model filter already excludes them.
      AND fe.embedding IS NOT NULL
      AND (${model?.modelName ?? null}::text IS NULL OR fe."modelName" = ${model?.modelName ?? null})
      AND (${model?.modelVersion ?? null}::text IS NULL OR fe."modelVersion" = ${model?.modelVersion ?? null})
  `;

  return rows.map((r) => ({
    id: r.id,
    studentId: r.studentId,
    modelName: r.modelName,
    modelVersion: r.modelVersion,
    embeddingDim: r.embeddingDim,
    embedding: parsePgVectorLiteral(r.embeddingText),
  }));
}

/**
 * pgvector renders a vector as `[0.1,0.2,...]` in text form. We split
 * rather than parse-JSON because a real vector is comma-separated with no
 * quotes on each element — cheap and allocation-light for a 512-d row.
 */
/**
 * Exported only so `scripts/bench/` can time the real function rather than a
 * copy of it that drifts. Nothing outside this module and that benchmark
 * should call it: the parse is an implementation detail of "we select
 * `embedding::text` instead of using pgvector's own operators", and if that
 * decision changes this helper goes away with it.
 */
export function parsePgVectorLiteral(text: string): number[] {
  const trimmed = text.trim();
  if (trimmed.length < 2 || trimmed[0] !== "[" || trimmed[trimmed.length - 1] !== "]") {
    return [];
  }
  const inner = trimmed.slice(1, -1);
  if (inner.length === 0) return [];
  const parts = inner.split(",");
  const out = new Array<number>(parts.length);
  for (let i = 0; i < parts.length; i++) {
    const n = Number(parts[i]);
    // A NaN component would silently poison cosine similarity (0/0), so we
    // fail the whole row rather than mixing garbage into scoring.
    if (!Number.isFinite(n)) return [];
    out[i] = n;
  }
  return out;
}
