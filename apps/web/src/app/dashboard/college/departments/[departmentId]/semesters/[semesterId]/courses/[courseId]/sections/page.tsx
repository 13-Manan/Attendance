import { redirect } from "next/navigation";

interface PageProps {
  params: Promise<{ departmentId: string; semesterId: string; courseId: string }>;
}

/** A path segment, not a page: a course's sections are listed on the course itself. */
export default async function CourseSectionsIndex({ params }: PageProps) {
  const { departmentId, semesterId, courseId } = await params;
  redirect(
    `/dashboard/college/departments/${encodeURIComponent(departmentId)}/semesters/${encodeURIComponent(semesterId)}/courses/${encodeURIComponent(courseId)}`,
  );
}
