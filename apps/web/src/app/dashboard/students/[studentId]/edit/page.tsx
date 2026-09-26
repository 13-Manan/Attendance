import { notFound, redirect } from "next/navigation";
import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { hasPermission } from "@/modules/authorization/service";
import {
  getStudentForRequest,
  getStudentFormOptionsForRequest,
} from "@/modules/students/directory-service";
import { StudentError } from "@/modules/students/directory-types";
import { studentOriginPath } from "@/modules/students/record-origin";
import { studentDisplayName } from "@/modules/students/types";
import { RETURN_PARAM, withReturnPath } from "@/lib/return-path";
import { PageTrail } from "@/components/nav/page-trail";
import { StudentForm } from "../../student-form";

interface PageProps {
  params: Promise<{ studentId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * Edit one student.
 *
 * Gated on `student.update` — and on `student.read` as well, because the form
 * has to show the current values to be an edit rather than a re-entry. The
 * record is loaded through the same institution-scoped read the rest of the
 * directory uses, so an id copied from another school's URL is a 404 here, not
 * a form pre-filled with their student's details.
 *
 * Placement is deliberately absent: it has its own permission and lives on the
 * student's record, where the classes they are already in are visible.
 *
 * Leads back to the record — and, when the record was opened from a section,
 * keeps that way back through the save, so the record still offers it.
 */
export default async function EditStudentPage({ params, searchParams }: PageProps) {
  const user = await requirePermissionOrRedirect("student.update");
  if (!hasPermission(user, "student.read")) redirect("/unauthorized");

  const { studentId } = await params;
  const origin = studentOriginPath((await searchParams)[RETURN_PARAM]);

  let student;
  try {
    student = await getStudentForRequest(user, studentId);
  } catch (error) {
    if (error instanceof StudentError) notFound();
    throw error;
  }

  const options = await getStudentFormOptionsForRequest(user);
  const name = studentDisplayName(student);

  return (
    <div className="flex w-full max-w-2xl flex-col gap-5">
      <PageTrail
        items={[
          { label: "Students", href: "/dashboard/students" },
          { label: name, href: withReturnPath(`/dashboard/students/${student.id}`, origin) },
          { label: "Edit" },
        ]}
      />

      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-neutral-900">Edit student</h1>
        <p className="text-sm text-neutral-500">
          {name} · <span className="font-mono">{student.studentCode}</span>
        </p>
      </header>

      <StudentForm
        mode="edit"
        student={student}
        options={options}
        canPlace={false}
        returnTo={origin ?? undefined}
      />
    </div>
  );
}
