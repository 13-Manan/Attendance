import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/modules/auth-tenancy/session";
import { hasPermission } from "@/modules/authorization/service";
import { addNewStudentToSectionAction } from "@/modules/college-setup/actions";
import { sectionFullName } from "@/modules/college-setup/policy";
import { getSectionPlacement } from "@/modules/college-setup/service";
import { getStudentFormOptionsForRequest } from "@/modules/students/directory-service";
import { PageTrail } from "@/components/nav/page-trail";
import { EmptyState } from "@/components/ui/panel";
import { StudentForm } from "@/app/dashboard/students/student-form";
import {
  COURSES_PATH,
  LINK_SECONDARY,
  courseHref,
  courseTrail,
  departmentHref,
  readOrDeny,
  sectionHref,
  sectionStudentsHref,
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
 * an action that places the student in this section and nowhere else, then
 * returns to the section with the new student named. There is no class to
 * choose, so the list of every class in the college is never sent to the
 * browser.
 */
export default async function AddSectionStudentPage({ params }: PageProps) {
  const user = await requireUser();
  const ids = await params;
  const isAdmin = hasPermission(user, "academicStructure.manage");

  const result = await readOrDeny(() => getSectionPlacement(user, ids));
  if (!result.ok) {
    return (
      <div className="flex w-full max-w-2xl flex-col gap-5">
        <PageTrail items={[isAdmin ? { label: "Departments", href: "/dashboard/college/departments" } : { label: "Courses", href: COURSES_PATH }, { label: "New student" }]} />
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
  const sectionPage = sectionHref(department.id, semester.id, course.id, section.id);
  const fullName = sectionFullName(course.name, section.label);
  const trail = courseTrail({
    viewer: isAdmin ? "admin" : "hod",
    department: { name: department.name, href: departmentHref(department.id) },
    semester: { name: semester.name, href: semesterHref(department.id, semester.id) },
    course: { name: course.name, code: course.code, href: courseHref(department.id, semester.id, course.id) },
    section: { label: section.label, href: sectionPage },
    leaf: "New student",
  });

  return (
    <div className="flex w-full max-w-2xl flex-col gap-5">
      <PageTrail items={trail.items} back={trail.back} />
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-neutral-900">New student</h1>
        <p className="max-w-xl text-sm text-neutral-700">
          They will be placed in <span className="font-medium text-neutral-900">{fullName}</span> ({section.groupName},{" "}
          {session.name}).
        </p>
        <p className="max-w-xl text-sm text-neutral-500">
          Only a name and a student ID are required. The student can be added to other courses&apos; sections
          afterwards.
        </p>
      </header>

      <nav aria-label="How to add a student" className="flex flex-wrap gap-2">
        <Link href={sectionStudentsHref(ids, "add")} className={LINK_SECONDARY}>
          Select existing student
        </Link>
        <span
          aria-current="page"
          className="inline-flex min-h-11 items-center rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white sm:min-h-10"
        >
          Create new student
        </span>
      </nav>

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
