import { notFound } from "next/navigation";
import { requireUser } from "@/modules/auth-tenancy/session";
import { hasPermission } from "@/modules/authorization/service";
import { addNewStudentToSectionAction } from "@/modules/college-setup/actions";
import { getSectionPlacement } from "@/modules/college-setup/service";
import { getStudentFormOptionsForRequest } from "@/modules/students/directory-service";
import { PageTrail } from "@/components/nav/page-trail";
import { EmptyState } from "@/components/ui/panel";
import { StudentForm } from "@/app/dashboard/students/student-form";
import {
  courseHref,
  courseTitle,
  departmentHref,
  readOrDeny,
  sectionHref,
  semesterHref,
} from "@/app/dashboard/college/shared";

interface PageProps {
  params: Promise<{ departmentId: string; semesterId: string; courseId: string; sectionId: string }>;
}

/**
 * Admit a new student straight into a course section.
 *
 * The college's usual Add student form — the same fields, checked by the same
 * student service with its duplicate-code check and audit rows — submitted to
 * an action that places the student in this section and nowhere else. There
 * is no class to choose, so the list of every class in the college is never
 * sent to the browser.
 */
export default async function AddSectionStudentPage({ params }: PageProps) {
  const user = await requireUser();
  const ids = await params;
  const isAdmin = hasPermission(user, "academicStructure.manage");
  const trailBase = isAdmin ? [{ label: "Departments", href: "/dashboard/college/departments" }] : [];

  const result = await readOrDeny(() => getSectionPlacement(user, ids));
  if (!result.ok) {
    return (
      <div className="flex w-full max-w-2xl flex-col gap-5">
        <PageTrail items={[...trailBase, { label: "Add student" }]} />
        <EmptyState>{result.message}</EmptyState>
      </div>
    );
  }
  const placement = result.value;
  if (!placement) notFound();
  const { department, semester, course, session, section } = placement;

  // Campuses need `student.read`, which an administrator holds; a head of
  // department is not offered one — campus stays optional, as it always is.
  const options = hasPermission(user, "student.read")
    ? { campuses: (await getStudentFormOptionsForRequest(user)).campuses, cohorts: [] }
    : { campuses: [], cohorts: [] };
  const back = sectionHref(department.id, semester.id, course.id, section.id);

  return (
    <div className="flex w-full max-w-2xl flex-col gap-5">
      <PageTrail
        items={[
          ...trailBase,
          { label: department.name, href: departmentHref(department.id) },
          { label: semester.name, href: semesterHref(department.id, semester.id) },
          { label: courseTitle(course), href: courseHref(department.id, semester.id, course.id) },
          { label: section.label, href: back },
          { label: "Add student" },
        ]}
      />
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-neutral-900">Add student</h1>
        <p className="max-w-xl text-sm text-neutral-700">
          They will be placed in <span className="font-medium text-neutral-900">{courseTitle(course)} — {section.label}</span>{" "}
          ({section.groupName}, {session.name}).
        </p>
        <p className="max-w-xl text-sm text-neutral-500">
          Only a name and a student code are required. The student can be added to other courses&apos; sections by their
          student ID afterwards.
        </p>
      </header>
      {!session.isActive ? (
        <EmptyState>{session.name} is archived, so students can&apos;t be added to its sections.</EmptyState>
      ) : (
        <StudentForm
          mode="create"
          options={options}
          canPlace={false}
          action={addNewStudentToSectionAction}
          hidden={{
            departmentId: department.id,
            semesterId: semester.id,
            courseId: course.id,
            sectionId: section.id,
          }}
        />
      )}
    </div>
  );
}
