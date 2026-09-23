import { redirect } from "next/navigation";

/** The sections are listed on the class page; this path exists for the breadcrumb. */
export default async function SectionsPage({ params }: { params: Promise<{ classId: string }> }) {
  const { classId } = await params;
  redirect(`/dashboard/academic/classes/${encodeURIComponent(classId)}`);
}
