import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { listAcademicUnitsForRequest } from "@/modules/academic-structure/service";
import { listAcademicSessionsForRequest } from "@/modules/academic-sessions/service";
import { NewCohortForm } from "./new-cohort-form";

export default async function NewCohortPage() {
  const user = await requirePermissionOrRedirect("cohort.manage");
  if (!user.institutionId) {
    return <p className="text-sm text-neutral-500">Platform-level accounts aren&apos;t scoped to an institution.</p>;
  }

  const [units, sessions] = await Promise.all([
    listAcademicUnitsForRequest(user, user.institutionId),
    listAcademicSessionsForRequest(user, user.institutionId),
  ]);

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold text-neutral-900">New cohort</h2>
      <NewCohortForm
        units={units.map((u) => ({ id: u.id, label: `${u.kind} · ${u.name}` }))}
        sessions={sessions.map((s) => ({ id: s.id, label: s.name }))}
      />
    </div>
  );
}
