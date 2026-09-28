import { redirect } from "next/navigation";
import { withReturnPath } from "@/lib/return-path";

interface PageProps {
  params: Promise<{
    departmentId: string;
    semesterId: string;
    courseId: string;
    sectionId: string;
    studentId: string;
  }>;
}

/**
 * A student opened from a section is the department's student page — one page
 * per student, whichever way they were reached — with the way back leading to
 * this section. That page checks the department and the student for itself.
 */
export default async function SectionStudentPage({ params }: PageProps) {
  const { departmentId, semesterId, courseId, sectionId, studentId } = await params;
  const department = `/dashboard/college/departments/${encodeURIComponent(departmentId)}`;
  const section =
    `${department}/semesters/${encodeURIComponent(semesterId)}` +
    `/courses/${encodeURIComponent(courseId)}/sections/${encodeURIComponent(sectionId)}`;
  redirect(withReturnPath(`${department}/students/${encodeURIComponent(studentId)}`, section));
}
