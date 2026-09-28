"use client";

import { useRouter } from "next/navigation";
import {
  enrollDepartmentStudentFaceAction,
  replaceDepartmentStudentFaceAction,
} from "@/modules/college-setup/actions";
import { FaceCapture } from "@/modules/face-enrollment/face-capture";
import type { FaceEnrollmentStatusSummary } from "@/modules/face-enrollment/policy";
import type { FaceCaptureSource, FaceEnrollmentResult } from "@/modules/face-enrollment/types";

/**
 * The administrator's capture surface, for one of a college department's
 * students — the same `FaceCapture`, bound to the department's two server
 * actions instead of the Students screen's. Those check the department and
 * the student first, then call the same enrolment service, so the quality
 * gate, duplicate checks and audit rows are the ones every enrolment gets.
 * Like `StaffEnrollmentClient`, it refreshes after every attempt so the
 * sample history below stays true.
 */
export function DepartmentEnrollmentClient({
  departmentId,
  studentId,
  initialStatus,
}: {
  departmentId: string;
  studentId: string;
  initialStatus: FaceEnrollmentStatusSummary;
}) {
  const router = useRouter();

  const submit = async (image: {
    imageBase64: string;
    captureSource: FaceCaptureSource;
    confirmDistinctFromStudentId?: string;
  }): Promise<FaceEnrollmentResult> => {
    const result = await enrollDepartmentStudentFaceAction({ departmentId, studentId, ...image });
    router.refresh();
    return result;
  };

  const replace = async (image: {
    imageBase64: string;
    captureSource: FaceCaptureSource;
    confirmDistinctFromStudentId?: string;
  }): Promise<FaceEnrollmentResult> => {
    const result = await replaceDepartmentStudentFaceAction({ departmentId, studentId, ...image });
    router.refresh();
    return result;
  };

  return <FaceCapture onSubmit={submit} onReplace={replace} initialStatus={initialStatus} subject="student" />;
}
