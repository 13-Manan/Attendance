"use client";

import { useRouter } from "next/navigation";
import { enrollFaceForStudent, replaceFaceEnrollment } from "@/modules/face-enrollment/actions";
import { FaceCapture } from "@/modules/face-enrollment/face-capture";
import type { FaceEnrollmentStatusSummary } from "@/modules/face-enrollment/policy";
import type { FaceCaptureSource, FaceEnrollmentResult } from "@/modules/face-enrollment/types";

/**
 * The staff enrollment surface for one student.
 *
 * A boundary and nothing more: it binds the student id — which came from the
 * route and has already been checked against this actor's institution by the
 * page above — to the two server actions, and refreshes so the sample history
 * below the capture reflects what just happened.
 *
 * `router.refresh()` runs on a refusal as well as on success, because two of
 * the refusals (the slot limit, a collision) are statements about stored data
 * that another administrator may have changed a moment ago, and a stale
 * history beside a fresh refusal reads as a contradiction.
 */
export function StaffEnrollmentClient({
  studentId,
  initialStatus,
}: {
  studentId: string;
  initialStatus: FaceEnrollmentStatusSummary;
}) {
  const router = useRouter();

  const submit = async (image: {
    imageBase64: string;
    captureSource: FaceCaptureSource;
  }): Promise<FaceEnrollmentResult> => {
    const result = await enrollFaceForStudent({ studentId, ...image });
    router.refresh();
    return result;
  };

  const replace = async (image: {
    imageBase64: string;
    captureSource: FaceCaptureSource;
  }): Promise<FaceEnrollmentResult> => {
    const result = await replaceFaceEnrollment({ studentId, ...image });
    router.refresh();
    return result;
  };

  return (
    <FaceCapture
      onSubmit={submit}
      onReplace={replace}
      initialStatus={initialStatus}
      subject="student"
    />
  );
}
