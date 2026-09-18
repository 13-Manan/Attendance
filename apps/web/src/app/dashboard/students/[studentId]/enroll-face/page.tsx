import { notFound } from "next/navigation";
import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { requireSameInstitution } from "@/modules/authorization/service";
import { getStudentById } from "@/modules/students/repository";
import { studentDisplayName } from "@/modules/students/types";
import { listActiveEmbeddingMetadataForStudent } from "@/modules/face-enrollment/repository";
import { StaffEnrollmentClient } from "./staff-enrollment-client";
import { DeleteFaceData } from "./delete-face-data";
import { TableScroll } from "@/components/ui/table-scroll";

export default async function StaffEnrollFacePage({
  params,
}: {
  params: Promise<{ studentId: string }>;
}) {
  // Both a permission AND a cross-institution check — a caller with
  // faceEmbedding.manage in inst-A must still be blocked from opening the
  // enrollment page for a student in inst-B.
  const user = await requirePermissionOrRedirect("faceEmbedding.manage");
  const { studentId } = await params;
  const student = await getStudentById(studentId);
  if (!student) notFound();
  requireSameInstitution(user, student.institutionId);

  const embeddings = await listActiveEmbeddingMetadataForStudent(student.id);

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-xl font-semibold text-neutral-900">
          Face enrollment · {studentDisplayName(student)}
        </h1>
        <p className="text-xs text-neutral-500">
          Student code {student.studentCode}. This capture will be stored as a protected biometric template —
          the raw image is not persisted.
        </p>
      </header>

      <StaffEnrollmentClient studentId={student.id} />

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-neutral-900">Active samples</h2>
        {embeddings.length === 0 ? (
          <p className="text-sm text-neutral-500">No active face samples yet.</p>
        ) : (
          <TableScroll>
            <table className="w-full text-left text-sm">
              <thead className="text-neutral-500">
                <tr>
                  <th className="py-2 pr-4 font-medium">Enrolled at</th>
                  <th className="py-2 pr-4 font-medium">Model</th>
                  <th className="py-2 pr-4 font-medium">Sample id</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {embeddings.map((e) => (
                  <tr key={e.id}>
                    <td className="py-2 pr-4 text-neutral-900">{e.createdAt.toISOString()}</td>
                    <td className="py-2 pr-4 text-neutral-500">
                      {e.modelName} · {e.modelVersion}
                    </td>
                    <td className="py-2 pr-4 text-neutral-500">{e.id}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </section>

      {/* Reachable by the same `faceEmbedding.manage` that gates this page, so
          the administrator who receives an erasure request can act on it here
          rather than asking somebody with database access. */}
      <DeleteFaceData studentId={student.id} studentCode={student.studentCode} />
    </div>
  );
}
