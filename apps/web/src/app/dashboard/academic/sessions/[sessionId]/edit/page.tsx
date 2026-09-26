import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { getAcademicSessionForRequest } from "@/modules/academic-sessions/service";
import { AcademicSessionError } from "@/modules/academic-sessions/types";
import { PageTrail } from "@/components/nav/page-trail";
import { EmptyState } from "@/components/ui/panel";
import { AcademicSessionForm } from "./academic-session-form";

interface PageProps {
  params: Promise<{ sessionId: string }>;
}

const BASE = "/dashboard/academic/sessions";

/** Academic / Academic sessions / this year — or "Academic year" where it could not be loaded. */
function trail(name: string) {
  return [
    { label: "Academic", href: "/dashboard/academic" },
    { label: "Academic sessions", href: BASE },
    { label: name },
  ];
}

/**
 * Edit one academic year.
 *
 * The id comes from the URL, so the read goes through
 * `getAcademicSessionForRequest` rather than a repository call: that function
 * puts the session's institution in the `where`, so a year id copied from
 * another institution's URL reads as "does not exist" here and the form is
 * never rendered for it. The same check happens again on save.
 *
 * Which year is current, and whether a year is archived, are not edited here.
 * Both are decisions about the other years — making one current takes the
 * status from another — so they are made on the list where all of them are
 * visible at once.
 */
export default async function EditAcademicSessionPage({ params }: PageProps) {
  const user = await requirePermissionOrRedirect("academicStructure.manage");
  const { sessionId } = await params;

  if (!user.institutionId) {
    return (
      <div className="flex w-full max-w-3xl flex-col gap-4">
        <PageTrail items={trail("Academic year")} />
        <p className="text-sm text-neutral-500">
          Platform-level accounts aren&apos;t scoped to an institution, so there is no academic year
          to edit here.
        </p>
      </div>
    );
  }

  let session;
  try {
    session = await getAcademicSessionForRequest(user, sessionId);
  } catch (error) {
    if (error instanceof AcademicSessionError) {
      return (
        <div className="flex w-full max-w-3xl flex-col gap-4">
          <PageTrail items={trail("Academic year")} />
          <EmptyState>{error.message}</EmptyState>
        </div>
      );
    }
    throw error;
  }

  return (
    <div className="flex w-full max-w-3xl flex-col gap-5">
      <PageTrail items={trail(session.name)} />
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-neutral-900">{session.name}</h1>
        <p className="max-w-2xl text-sm text-neutral-500">
          Renaming a year or moving its dates does not move a class or a register. Everything
          already recorded under it stays where it is.
        </p>
      </header>

      <AcademicSessionForm session={session} />
    </div>
  );
}
