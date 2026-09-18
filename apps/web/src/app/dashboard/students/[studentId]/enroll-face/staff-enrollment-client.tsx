"use client";

import { useRouter } from "next/navigation";
import { enrollFaceForStudent } from "@/modules/face-enrollment/actions";
import { FaceCapture } from "@/modules/face-enrollment/face-capture";
import type { FaceEnrollmentResult } from "@/modules/face-enrollment/types";

export function StaffEnrollmentClient({ studentId }: { studentId: string }) {
  const router = useRouter();

  const submit = async (imageBase64: string): Promise<FaceEnrollmentResult> => {
    const result = await enrollFaceForStudent({ studentId, imageBase64 });
    if (result.ok) router.refresh();
    return result;
  };

  return (
    <FaceCapture
      onSubmit={submit}
      submitLabel="Enroll student's face"
      helpText="Position the student in a well-lit area. Only one face may be visible in the frame."
    />
  );
}
