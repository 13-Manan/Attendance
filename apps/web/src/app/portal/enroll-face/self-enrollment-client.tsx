"use client";

import { useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { enrollOwnFace, startOwnFaceCapture } from "@/modules/face-enrollment/actions";
import { FaceCapture } from "@/modules/face-enrollment/face-capture";
import type { FaceEnrollmentStatusSummary } from "@/modules/face-enrollment/policy";
import type { FaceCaptureOutcome, FaceCaptureSource } from "@/modules/face-enrollment/types";

/**
 * A student enrolling their own face.
 *
 * No `onReplace`. Retiring templates is a staff capability on purpose: a
 * student who can retire their own samples can make themselves unrecognisable
 * before a class they would rather not be marked present in, which turns a
 * privacy control into an attendance loophole. A student whose appearance has
 * changed adds another sample, and asks the office if they have run out.
 *
 * No student id anywhere in this file, or in the actions it calls. The server
 * resolves the caller's own linked Student profile from the session.
 *
 * Camera only. Each time the camera starts, the server opens a camera session
 * and every capture taken in it carries the session back; the server refuses
 * a capture without one (see self-enrollment.ts). The session is held in
 * memory for as long as this page is open and nowhere else.
 */
export function SelfEnrollmentClient({
  initialStatus,
  unavailableReason,
}: {
  initialStatus: FaceEnrollmentStatusSummary;
  unavailableReason: string | null;
}) {
  const router = useRouter();
  const captureToken = useRef<string | null>(null);

  const onCameraStarted = useCallback(async () => {
    captureToken.current = null;
    const started = await startOwnFaceCapture();
    if (!started.ok) return { ok: false as const, message: started.message };
    captureToken.current = started.captureToken;
    return { ok: true as const };
  }, []);

  const submit = async (image: {
    imageBase64: string;
    captureSource: FaceCaptureSource;
  }): Promise<FaceCaptureOutcome> => {
    const result = await enrollOwnFace({
      imageBase64: image.imageBase64,
      captureSource: image.captureSource,
      captureToken: captureToken.current ?? undefined,
    });
    router.refresh();
    return result;
  };

  return (
    <FaceCapture
      onSubmit={submit}
      initialStatus={initialStatus}
      subject="self"
      unavailableReason={unavailableReason}
      cameraOnly
      onCameraStarted={onCameraStarted}
    />
  );
}
