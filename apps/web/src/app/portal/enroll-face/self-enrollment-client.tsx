"use client";

import { useRouter } from "next/navigation";
import { enrollOwnFace } from "@/modules/face-enrollment/actions";
import { FaceCapture } from "@/modules/face-enrollment/face-capture";
import type { FaceEnrollmentResult } from "@/modules/face-enrollment/types";

export function SelfEnrollmentClient() {
  const router = useRouter();

  const submit = async (imageBase64: string): Promise<FaceEnrollmentResult> => {
    const result = await enrollOwnFace({ imageBase64 });
    if (result.ok) router.refresh();
    return result;
  };

  return (
    <FaceCapture
      onSubmit={submit}
      submitLabel="Enroll my face"
      helpText="Look straight at the camera in good light. Only your face should be visible."
    />
  );
}
