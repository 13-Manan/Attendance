import { redirect } from "next/navigation";

/** There for the URL's sake: the college's structure starts at its departments. */
export default function CollegeIndex() {
  redirect("/dashboard/college/departments");
}
