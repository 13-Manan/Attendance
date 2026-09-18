import Link from "next/link";
import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { listStudentsByInstitution } from "@/modules/students/repository";
import { studentDisplayName } from "@/modules/students/types";
import { hasPermission } from "@/modules/authorization/service";
import { TableScroll } from "@/components/ui/table-scroll";

export default async function StudentsPage() {
  const user = await requirePermissionOrRedirect("student.read");

  const students = user.institutionId ? await listStudentsByInstitution(user.institutionId) : [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-neutral-900">Students</h1>
        {hasPermission(user, "student.create") && (
          <Link
            href="/dashboard/students/new"
            className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700"
          >
            Add student
          </Link>
        )}
      </div>

      {students.length === 0 ? (
        <p className="text-sm text-neutral-500">No students yet.</p>
      ) : (
        <TableScroll>
          <table className="w-full text-left text-sm">
            <thead className="text-neutral-500">
              <tr>
                <th className="py-2 pr-4 font-medium">Name</th>
                <th className="py-2 pr-4 font-medium">Student code</th>
                <th className="py-2 pr-4 font-medium">Status</th>
                <th className="py-2 pr-4 font-medium"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {students.map((student) => (
                <tr key={student.id}>
                  <td className="py-2 pr-4 text-neutral-900">{studentDisplayName(student)}</td>
                  <td className="py-2 pr-4 text-neutral-500">{student.studentCode}</td>
                  <td className="py-2 pr-4 text-neutral-500">{student.status}</td>
                  <td className="py-2 pr-4 text-right">
                    {hasPermission(user, "faceEmbedding.manage") && (
                      <Link
                        href={`/dashboard/students/${student.id}/enroll-face`}
                        className="text-sm text-neutral-700 underline hover:text-neutral-900"
                      >
                        Enroll face
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}
    </div>
  );
}
