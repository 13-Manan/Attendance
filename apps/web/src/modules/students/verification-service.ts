import { prisma } from "@/lib/prisma";
import { twinBlockStates } from "@/modules/twin-confirmation/service";
import {
  computeVerification,
  factsFromRow,
  type FaceModelFilter,
  type StudentVerification,
  type VerificationFacts,
} from "./verification";

/**
 * Verification for students the caller has already been allowed to see.
 *
 * No access check of its own, on purpose: every page that shows a checklist
 * has already resolved its students through its own scoped read — the school
 * directory through `student.read`, a department through its head's scope —
 * and this only ever receives ids from that read. It returns counts, states
 * and dates; never a face, a vector or another student's identity.
 */

/** How long one replica trusts its answer about the running model. */
const MODEL_TTL_MS = 30_000;
let cachedModel: { value: FaceModelFilter; at: number } | null = null;

/**
 * The model this deployment runs, or null when the face service cannot be
 * asked — in which case any active sample counts, as on the coverage page.
 * Cached briefly: every directory page asks, and the answer changes only when
 * a new face-ai revision ships.
 */
export async function runningFaceModel(): Promise<FaceModelFilter> {
  if (cachedModel && Date.now() - cachedModel.at < MODEL_TTL_MS) return cachedModel.value;
  let value: FaceModelFilter = null;
  try {
    const { faceModelInfo } = await import("@/lib/face-ai-client");
    const info = await faceModelInfo();
    value = { modelName: info.modelName, modelVersion: info.modelVersion };
  } catch {
    value = null;
  }
  // An unreachable service is not cached as an answer: the next page asks again.
  if (value) cachedModel = { value, at: Date.now() };
  return value;
}

export interface VerificationDetail extends StudentVerification {
  facts: VerificationFacts;
}

/** The checklist for each of these students, in four reads however many there are. */
export async function verificationFor(
  institutionId: string,
  studentIds: readonly string[],
  faceModel: FaceModelFilter,
): Promise<Map<string, VerificationDetail>> {
  if (studentIds.length === 0) return new Map();
  const [rows, twins] = await Promise.all([
    prisma.student.findMany({
      where: { institutionId, id: { in: [...studentIds] } },
      select: {
        id: true,
        status: true,
        user: { select: { status: true } },
        _count: { select: { enrollments: { where: { status: "ACTIVE" } } } },
        faceEmbeddings: {
          where: { isActive: true },
          select: { modelName: true, modelVersion: true, createdAt: true },
        },
      },
    }),
    // Decorates the checklist; a failure here must not take a directory down.
    twinBlockStates(institutionId, studentIds).catch(() => new Map<string, "pending" | "not_confirmed" | "confirmed">()),
  ]);

  return new Map(
    rows.map((row) => {
      const facts = factsFromRow(
        { status: row.status, user: row.user, enrollmentCount: row._count.enrollments, samples: row.faceEmbeddings },
        faceModel,
        twins.get(row.id) ?? null,
      );
      return [row.id, { ...computeVerification(facts), facts }];
    }),
  );
}

/** One student's checklist, or null for an id that is not this institution's. */
export async function verificationOf(
  institutionId: string,
  studentId: string,
  faceModel: FaceModelFilter,
): Promise<VerificationDetail | null> {
  return (await verificationFor(institutionId, [studentId], faceModel)).get(studentId) ?? null;
}
