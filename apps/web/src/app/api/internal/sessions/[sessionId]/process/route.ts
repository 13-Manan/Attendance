import { z } from "zod";
import { getCurrentUser } from "@/modules/auth-tenancy/session";
import { requireCohortAccess } from "@/modules/authorization/cohort-access";
import { hasPermission, requireSameInstitution } from "@/modules/authorization/service";
import { ForbiddenError } from "@/modules/authorization/types";
import { MAX_IMAGE_BASE64_CHARS, isAcceptableImageBase64 } from "@/lib/image-validation";
import { getSessionWithImages } from "@/modules/sessions/repository";

/**
 * Internal Next↔Python orchestration entry point (ADR-0002).
 *
 * ## This used to be unauthenticated, and the reason it gave was wrong
 *
 * The comment this file carried said it was "not reachable from outside the
 * server … never exposed past the internal network", and therefore needed no
 * auth. That is not a property a Next.js Route Handler has. `app/api/**` is
 * compiled into the same public router as every other route: whatever host
 * serves `/dashboard` serves this path too, on the same port, to anybody who
 * types the URL. "Internal" described an intention about who would call it,
 * not a control over who could.
 *
 * What that intention got wrong is worth stating plainly, because the same
 * mistake is easy to repeat: a path segment named `internal` is documentation.
 * The only thing that makes a request internal is a credential.
 *
 * So the check is the same one the capture wizard performs, for the same
 * reason — this endpoint accepts classroom photographs and names an attendance
 * session:
 *
 *   1. A session (401 if absent). Not an API key: the caller is a signed-in
 *      faculty member's device or a worker acting as one, never a third-party
 *      integration. `/api/v1` is where integrations live and it has no
 *      recognition scope on purpose.
 *   2. `attendanceSession.capture` (403).
 *   3. The session's own institution (403) — previously
 *      `getSessionWithImages(sessionId)` was called with no scoping at all, so
 *      a guessed or enumerated id from another school answered 501 "session
 *      found" instead of 404. That difference alone is a cross-tenant
 *      existence oracle.
 *   4. Cohort access (403), so a teacher cannot process a class that is not
 *      theirs even inside their own institution.
 *
 * ## Why the body is bounded here too
 *
 * The images are base64 in a JSON body, which Next buffers before this
 * function runs. `imageBase64: z.string().min(1)` set no ceiling, so a single
 * request could ask the process to hold an arbitrary amount of memory before
 * any authorization had been considered. Both bounds — per image and per
 * request — now match the Server Action capture path exactly, and the same
 * magic-byte check runs, so "which door did the photo come through" stops
 * changing what is accepted.
 *
 * The pipeline itself (call face-ai, vector search, confidence engine, write
 * `AttendanceRecord` rows) is still deferred; the live implementation is the
 * capture wizard in `modules/attendance-capture`. This route continues to
 * answer 501 — but it answers it only to callers who were entitled to ask.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Matches `MAX_CAPTURES_PER_SESSION` in modules/attendance-capture. */
const MAX_IMAGES = 3;

const bodySchema = z.object({
  images: z
    .array(
      z.object({
        sequenceNumber: z.union([z.literal(1), z.literal(2), z.literal(3)]),
        // Lower bound as well as upper: 64 characters is below any real
        // encoded image and is the same floor the capture action uses, so an
        // empty frame is named as such rather than sent to the model.
        imageBase64: z
          .string()
          .min(64)
          .max(MAX_IMAGE_BASE64_CHARS)
          .refine(isAcceptableImageBase64, {
            message: "Expected base64-encoded JPEG, PNG or WebP image bytes.",
          }),
      }),
    )
    .min(1)
    .max(MAX_IMAGES),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;

  const user = await getCurrentUser();
  if (!user) {
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }
  if (!hasPermission(user, "attendanceSession.capture")) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  // Parsed before the session lookup so a malformed body cannot be used to
  // probe which session ids exist, and after authentication so an anonymous
  // caller never gets as far as allocating for a body at all.
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsedBody = bodySchema.safeParse(raw);
  if (!parsedBody.success) {
    return Response.json(
      { error: "invalid_request", details: parsedBody.error.flatten() },
      { status: 400 },
    );
  }

  const session = await getSessionWithImages(sessionId);
  if (!session) {
    return Response.json({ error: "session_not_found" }, { status: 404 });
  }

  try {
    requireSameInstitution(user, session.institutionId);
    await requireCohortAccess(user, session.cohortId);
  } catch (e) {
    if (e instanceof ForbiddenError) {
      // 403 and not 404. The caller is authenticated and the session exists;
      // pretending otherwise would be a lie told to a legitimate user whose
      // cohort assignment is simply wrong. The cross-tenant case is already
      // covered — a caller from another institution never reaches a body that
      // names this session's cohort.
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    throw e;
  }

  return Response.json(
    {
      error: "not_implemented",
      message:
        "Session found and request validated. Recognition pipeline orchestration is implemented in a later phase.",
    },
    { status: 501 },
  );
}
