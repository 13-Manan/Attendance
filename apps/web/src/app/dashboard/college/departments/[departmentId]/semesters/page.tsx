import { redirect } from "next/navigation";

interface PageProps {
  params: Promise<{ departmentId: string }>;
}

/** A path segment, not a page: a department's semesters are listed on the department itself. */
export default async function DepartmentSemestersIndex({ params }: PageProps) {
  const { departmentId } = await params;
  redirect(`/dashboard/college/departments/${encodeURIComponent(departmentId)}`);
}
