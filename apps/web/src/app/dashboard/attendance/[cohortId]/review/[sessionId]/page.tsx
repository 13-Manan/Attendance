import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { getAttendanceReviewBoard } from "@/modules/attendance-review/service";
import { hasPermission } from "@/modules/authorization/service";
import { ForbiddenError } from "@/modules/authorization/types";
import { ReviewBoard } from "./review-client";

interface PageProps {
  params: Promise<{ cohortId: string; sessionId: string }>;
}

/**
 * Server shell for the Phase 6 faculty review board.
 *
 * The board is fetched here rather than in the client so the first paint
 * already contains the register — a teacher standing in front of a class
 * should not watch a spinner resolve who is present. The client takes over
 * for corrections and realtime updates.
 *
 * Authorization is deliberately done twice: once here (so an unauthorized
 * caller never renders the screen) and again inside every Server Action the
 * client calls (so the screen is not the security boundary).
 */
export default async function AttendanceReviewPage({ params }: PageProps) {
  const { cohortId, sessionId } = await params;
  const user = await requirePermissionOrRedirect("attendanceRecord.read");

  let board;
  try {
    board = await getAttendanceReviewBoard(user, sessionId);
  } catch (e) {
    if (e instanceof ForbiddenError) redirect("/unauthorized");
    if (e instanceof Error && e.message === "session_not_found") notFound();
    throw e;
  }

  // A session id from another class in the URL must not render under this
  // class's heading, even though the caller is allowed to see it.
  if (board.session.cohortId !== cohortId) {
    redirect(`/dashboard/attendance/${board.session.cohortId}/review/${sessionId}`);
  }

  // Only a register still in review takes more photos, and only from someone
  // who may capture; the capture page re-checks both before anything runs.
  const addPhotoHref =
    board.session.processingStatus === "REVIEW" &&
    hasPermission(user, "attendanceSession.capture")
      ? `/dashboard/attendance/${cohortId}/capture?add=1${
          board.session.cohortSubjectId
            ? `&subject=${encodeURIComponent(board.session.cohortSubjectId)}`
            : ""
        }`
      : null;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      <div className="flex flex-col gap-1">
        <Link
          href={`/dashboard/attendance/${cohortId}`}
          className="text-xs text-neutral-500 hover:underline"
        >
          ← Back to class
        </Link>
        <h1 className="text-xl font-semibold text-neutral-900">
          {board.session.cohortName}
          {board.session.subjectName ? ` · ${board.session.subjectName}` : ""}
        </h1>
        <p className="text-xs text-neutral-500">
          {board.session.institutionName}
          {board.session.academicSessionName ? ` · ${board.session.academicSessionName}` : ""}
          {" · "}
          {new Date(board.session.sessionDate).toLocaleDateString(undefined, {
            weekday: "short",
            year: "numeric",
            month: "short",
            day: "numeric",
          })}
          {" · started "}
          {new Date(board.session.startedAt).toLocaleTimeString(undefined, {
            hour: "2-digit",
            minute: "2-digit",
          })}
          {board.session.facultyName ? ` · ${board.session.facultyName}` : ""}
        </p>
      </div>
      <ReviewBoard
        initialBoard={board}
        showDiagnostics={hasPermission(user, "faceEmbedding.manage")}
        addPhotoHref={addPhotoHref}
      />
    </div>
  );
}
