import { redirect } from "next/navigation";
import { studentClassHref } from "@/modules/students/class-navigation-paths";

/** A class's sections are listed on the class page; this path exists for the breadcrumb. */
export default async function StudentSectionsPage({
  params,
}: {
  params: Promise<{ classId: string }>;
}) {
  const { classId } = await params;
  redirect(studentClassHref(classId));
}
