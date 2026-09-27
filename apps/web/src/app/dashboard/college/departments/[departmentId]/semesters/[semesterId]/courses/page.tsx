import { redirect } from "next/navigation";

interface PageProps {
  params: Promise<{ departmentId: string; semesterId: string }>;
}

/** A path segment, not a page: a semester's courses are listed on the semester itself. */
export default async function SemesterCoursesIndex({ params }: PageProps) {
  const { departmentId, semesterId } = await params;
  redirect(
    `/dashboard/college/departments/${encodeURIComponent(departmentId)}/semesters/${encodeURIComponent(semesterId)}`,
  );
}
