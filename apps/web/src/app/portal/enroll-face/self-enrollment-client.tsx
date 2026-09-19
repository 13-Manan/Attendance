"use client";

import { useRouter } from "next/navigation";
import { enrollOwnFace } from "@/modules/face-enrollment/actions";
import { FaceCapture } from "@/modules/face-enrollment/face-capture";
import type { FaceEnrollmentStatusSummary } from "@/modules/face-enrollment/policy";
import type { FaceCaptureSource, FaceEnrollmentResult } from "@/modules/face-enrollment/types";

/**
 * A student enrolling their own face.
 *
 * No `onReplace`. Retiring templates is a staff capability on purpose: a
 * student who can retire their own samples can make themselves unrecognisable
 * before a class they would rather not be marked present in, which turns a
 * privacy control into an attendance loophole. A student whose appearance has
 * changed adds another sample, and asks the office if they have run out.
 *
 * No student id anywhere in this file, or in the action it calls. The server
 * resolves the caller's own linked Student profile from the session.
 */
export function SelfEnrollmentClient({
  initialStatus,
  unavailableReason,
}: {
  initialStatus: FaceEnrollmentStatusSummary;
  unavailableReason: string | null;
}) {
  const router = useRouter();

  const submit = async (image: {
    imageBase64: string;
    captureSource: FaceCaptureSource;
  }): Promise<FaceEnrollmentResult> => {
    const result = await enrollOwnFace(image);
    router.refresh();
    return result;
  };

  return (
    <FaceCapture
      onSubmit={submit}
      initialStatus={initialStatus}
      subject="self"
      unavailableReason={unavailableReason}
    />
  );
}
