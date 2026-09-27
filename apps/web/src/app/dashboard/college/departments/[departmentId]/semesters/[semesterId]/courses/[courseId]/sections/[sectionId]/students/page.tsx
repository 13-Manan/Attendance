import { redirect } from "next/navigation";

interface PageProps {
  params: Promise<{ departmentId: string; semesterId: string; courseId: string; sectionId: string }>;
}

/** A path segment, not a page: a section's students are listed on the section itself. */
export default async function SectionStudentsIndex({ params }: PageProps) {
  const { departmentId, semesterId, courseId, sectionId } = await params;
  redirect(
    `/dashboard/college/departments/${encodeURIComponent(departmentId)}/semesters/${encodeURIComponent(semesterId)}/courses/${encodeURIComponent(courseId)}/sections/${encodeURIComponent(sectionId)}`,
  );
}
