"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  analyzeCaptureImageAction,
  cancelCaptureSessionAction,
  startCaptureSession,
  summarizeCaptureSessionAction,
} from "@/modules/attendance-capture/actions";
import type {
  CaptureImageAnalysis,
  CaptureSessionSummary,
  StartCaptureSessionResult,
} from "@/modules/attendance-capture/types";
import { MAX_CAPTURES_PER_SESSION } from "@/modules/attendance-capture/types";
import { cameraStatusLabel, canCapture, canStart } from "@/modules/attendance-capture/camera";
import { fixtureCameraSource } from "@/modules/attendance-capture/camera-source";
import { useClassroomCamera } from "@/modules/attendance-capture/use-classroom-camera";
import {
  processSessionAttendanceAction,
  startManualRollCallAction,
} from "@/modules/attendance-review/actions";
import type { GenerateAttendanceCandidatesResult } from "@/modules/attendance-review/service";
import type { RecognitionRunSummary } from "@/modules/recognition-engine/types";
import type { AttendanceMode } from "@/modules/institutions/types";

/**
 * The classroom capture wizard.
 *
 *   briefing → camera → review → processing → summary
 *
 * ## Where state lives, and why
 *
 * The attendance session id is server-side, so a refresh resumes rather than
 * duplicating. Everything the browser holds — the camera stream, the captured
 * previews — is in memory only: no `localStorage`, no IndexedDB, nothing that
 * outlives the tab. A refresh loses the photographs and the teacher retakes
 * them, which is the correct default for images of a room full of children.
 *
 * The counts on the summary screen are the *server's*, not this component's.
 * The browser knows how many faces it was told about; what gets displayed and
 * what gets written are both derived from what the server saw.
 *
 * ## Camera
 *
 * All of it is behind `useClassroomCamera`. This file decides what to render
 * for each camera state; it never touches `getUserMedia`, a `MediaStream`, or
 * a canvas.
 */

type WizardStep = "briefing" | "camera" | "review" | "processing" | "summary";

interface CapturedShot {
  sequenceNumber: 1 | 2 | 3;
  /** Data URL for the local `<img>` preview. Never uploaded as-is. */
  dataUrl: string;
  /** Raw base64 sent to the server. */
  imageBase64: string;
  width: number;
  height: number;
  /** The server's verdict on this frame, once it has one. */
  analysis?: CaptureImageAnalysis;
  /** Set while the quality check is in flight. */
  checking?: boolean;
  /** Set when the quality check failed — the shot gets a retake affordance
   * rather than being silently dropped. */
  failure?: { message: string; retryable: boolean };
}

interface Props {
  cohortId: string;
  cohortSubjectId: string | null;
  attendanceMode: AttendanceMode;
  /**
   * Development-only. Replaces the camera with a deterministic fixture so the
   * flow can be driven in a browser with no webcam attached. Never true in a
   * deployed environment — see the page component, which reads a
   * `NEXT_PUBLIC_` flag that no deployment sets.
   */
  useFixtureCamera?: boolean;
}

const CAPTURE_TIPS = [
  "Stand where you can see the whole class, and include every row",
  "Ask students to face forward, with hats and hands away from faces",
  "Avoid strong backlighting — the window behind the class is the classic trap",
  "Take a second photo from another angle if students are behind one another",
] as const;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function nextSequenceNumber(shots: CapturedShot[]): 1 | 2 | 3 | null {
  const used = new Set(shots.map((s) => s.sequenceNumber));
  for (const n of [1, 2, 3] as const) if (!used.has(n)) return n;
  return null;
}

function qualityBadgeClasses(label: CaptureImageAnalysis["qualityLabel"] | undefined): string {
  switch (label) {
    case "good":
      return "bg-green-50 text-green-700 border-green-200";
    case "acceptable":
      return "bg-amber-50 text-amber-700 border-amber-200";
    case "poor":
      return "bg-orange-50 text-orange-700 border-orange-200";
    case "no_faces":
      return "bg-red-50 text-red-700 border-red-200";
    default:
      return "bg-neutral-50 text-neutral-500 border-neutral-200";
  }
}

function qualityBadgeText(
  label: CaptureImageAnalysis["qualityLabel"] | undefined,
  checking: boolean,
): string {
  if (checking) return "Checking…";
  switch (label) {
    case "good":
      return "Good";
    case "acceptable":
      return "Acceptable";
    case "poor":
      return "Poor";
    case "no_faces":
      return "No faces";
    default:
      return "Not checked";
  }
}

// `navigator.onLine` adapters, defined outside the component so React's
// referential snapshot equality holds across renders.
function subscribeToOnlineStatus(cb: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("online", cb);
  window.addEventListener("offline", cb);
  return () => {
    window.removeEventListener("online", cb);
    window.removeEventListener("offline", cb);
  };
}
function getOnlineSnapshot(): boolean {
  return typeof window === "undefined" ? true : window.navigator.onLine;
}
function getServerOnlineSnapshot(): boolean {
  return true;
}

/**
 * Turns a thrown Server Action error into something a teacher standing in
 * front of a class can act on.
 *
 * The service layer throws tagged strings (`session_locked:FINALIZED`,
 * `empty_roster`) precisely so this mapping can exist. Without it the states
 * the spec calls "session expired", "unauthorized" and "no students in the
 * selected cohort" all render as the same raw identifier.
 */
function describeProcessingError(error: unknown): { message: string; canRollCall: boolean } {
  const raw = error instanceof Error ? error.message : "";

  if (raw.startsWith("session_locked:FINALIZED")) {
    return {
      message:
        "This register has already been finalized, so it cannot accept new captures. Open it from the class page to make a correction.",
      canRollCall: false,
    };
  }
  if (raw.startsWith("session_locked:CANCELLED") || raw === "session_not_found") {
    return {
      message:
        "This attendance session has expired or was discarded. Go back to the class and start a new one.",
      canRollCall: false,
    };
  }
  if (raw === "empty_roster") {
    return {
      message:
        "No students are enrolled in this class, so there is no register to build. Ask an administrator to enrol students, then try again.",
      canRollCall: false,
    };
  }
  if (raw === "not_cohort_faculty" || raw === "not_subject_faculty" || raw === "forbidden") {
    return {
      message:
        "You are not authorized to take attendance for this class. Ask an administrator to link you as its faculty.",
      canRollCall: false,
    };
  }
  if (raw === "face_ai_timeout") {
    return {
      message:
        "Face recognition took too long to respond. The captures were not lost — try again, or call the roll manually.",
      canRollCall: true,
    };
  }
  return {
    message: raw
      ? `Recognition could not be completed: ${raw}`
      : "Recognition could not be completed.",
    canRollCall: true,
  };
}

// ---------------------------------------------------------------------------

export function CaptureWizard({
  cohortId,
  cohortSubjectId,
  attendanceMode,
  useFixtureCamera = false,
}: Props) {
  const router = useRouter();
  const [step, setStep] = useState<WizardStep>("briefing");
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [started, setStarted] = useState<StartCaptureSessionResult | null>(null);

  const [shots, setShots] = useState<CapturedShot[]>([]);
  const [captureError, setCaptureError] = useState<string | null>(null);

  const [processingStage, setProcessingStage] = useState<string>("");
  const [processingPercent, setProcessingPercent] = useState(0);
  const [summary, setSummary] = useState<CaptureSessionSummary | null>(null);
  const [processingError, setProcessingError] = useState<string | null>(null);
  const [recognition, setRecognition] = useState<RecognitionRunSummary | null>(null);
  const [recognitionError, setRecognitionError] = useState<string | null>(null);
  const [canRollCall, setCanRollCall] = useState(false);
  const [generation, setGeneration] = useState<GenerateAttendanceCandidatesResult | null>(null);
  const [rollCallBusy, setRollCallBusy] = useState(false);
  const [rollCallError, setRollCallError] = useState<string | null>(null);

  const isOnline = useSyncExternalStore(
    subscribeToOnlineStatus,
    getOnlineSnapshot,
    getServerOnlineSnapshot,
  );

  // The fixture source is constructed once, and only when explicitly asked
  // for. `useMemo` because a fresh source each render would restart the camera.
  const fixtureSource = useMemo(
    () => (useFixtureCamera ? fixtureCameraSource() : undefined),
    [useFixtureCamera],
  );
  const camera = useClassroomCamera({ source: fixtureSource });

  // Leaving the camera step releases the hardware. The hook also handles
  // unmount and tab-hidden; this covers "moved on to review".
  const { stop: stopCamera } = camera;
  useEffect(() => {
    if (step !== "camera") stopCamera();
  }, [step, stopCamera]);

  // -------------------------------------------------------------------------
  // Session
  // -------------------------------------------------------------------------
  const start = useCallback(async () => {
    setStartError(null);
    setStarting(true);
    try {
      const result = await startCaptureSession({ cohortId, cohortSubjectId });
      setStarted(result);
      setStep("camera");
      void camera.start();
    } catch (e) {
      setStartError(
        e instanceof Error
          ? describeProcessingError(e).message
          : "Could not start attendance.",
      );
    } finally {
      setStarting(false);
    }
  }, [camera, cohortId, cohortSubjectId]);

  // -------------------------------------------------------------------------
  // Capture, quality check, retake
  // -------------------------------------------------------------------------

  /**
   * Sends one frame for its quality check.
   *
   * Runs as soon as the shutter is pressed rather than at the end, so a
   * photograph with nobody in it is caught while the class is still sitting
   * there. Detection only on the server — no embedding is produced for a frame
   * the teacher may be about to discard.
   */
  const checkShot = useCallback(
    async (sessionId: string, shot: CapturedShot) => {
      setShots((current) =>
        current.map((s) =>
          s.sequenceNumber === shot.sequenceNumber
            ? { ...s, checking: true, failure: undefined }
            : s,
        ),
      );
      try {
        const result = await analyzeCaptureImageAction({
          sessionId,
          sequenceNumber: shot.sequenceNumber,
          imageBase64: shot.imageBase64,
        });
        setShots((current) =>
          current.map((s) =>
            s.sequenceNumber === shot.sequenceNumber
              ? result.ok
                ? { ...s, checking: false, analysis: result, failure: undefined }
                : {
                    ...s,
                    checking: false,
                    analysis: undefined,
                    failure: { message: result.message, retryable: result.retryable },
                  }
              : s,
          ),
        );
      } catch (e) {
        setShots((current) =>
          current.map((s) =>
            s.sequenceNumber === shot.sequenceNumber
              ? {
                  ...s,
                  checking: false,
                  failure: {
                    message:
                      e instanceof Error
                        ? `Could not check this photo: ${e.message}`
                        : "Could not check this photo.",
                    retryable: true,
                  },
                }
              : s,
          ),
        );
      }
    },
    [],
  );

  const capture = useCallback(() => {
    if (!started) return;
    const sequenceNumber = nextSequenceNumber(shots);
    if (sequenceNumber === null) return;

    setCaptureError(null);
    const frame = camera.capture();
    if (!frame.ok) {
      setCaptureError(frame.message);
      return;
    }

    const shot: CapturedShot = {
      sequenceNumber,
      dataUrl: frame.dataUrl,
      imageBase64: frame.imageBase64,
      width: frame.width,
      height: frame.height,
      checking: true,
    };
    setShots((current) => [...current, shot]);
    setStep("review");
    void checkShot(started.session.id, shot);
  }, [camera, checkShot, shots, started]);

  const removeShot = useCallback((sequenceNumber: 1 | 2 | 3) => {
    setShots((current) => current.filter((s) => s.sequenceNumber !== sequenceNumber));
  }, []);

  const retakeShot = useCallback(
    (sequenceNumber: 1 | 2 | 3) => {
      removeShot(sequenceNumber);
      setStep("camera");
      void camera.start(camera.activeDeviceId ?? undefined);
    },
    [camera, removeShot],
  );

  const captureAnother = useCallback(() => {
    setStep("camera");
    void camera.start(camera.activeDeviceId ?? undefined);
  }, [camera]);

  // -------------------------------------------------------------------------
  // Processing
  //
  // Recognition and register generation happen in ONE server call. If the
  // browser ran recognition and posted results back, a client could simply
  // claim everybody was matched — attendance would be asserted by the device
  // rather than measured. What the browser gets back is display-only.
  // -------------------------------------------------------------------------
  const process = useCallback(async () => {
    if (!started || shots.length === 0) return;
    setStep("processing");
    setProcessingError(null);
    setRecognition(null);
    setRecognitionError(null);
    setRollCallError(null);
    setCanRollCall(false);
    setGeneration(null);

    setProcessingStage("Sending the captures for recognition");
    setProcessingPercent(20);
    try {
      const result = await processSessionAttendanceAction({
        sessionId: started.session.id,
        images: shots.map((s) => ({
          sequenceNumber: s.sequenceNumber,
          imageBase64: s.imageBase64,
        })),
      });
      setProcessingStage("Building the attendance register");
      setProcessingPercent(75);
      setRecognition(result.recognition);
      setGeneration(result.generation);
    } catch (e) {
      // Not fatal: the captures succeeded, and the teacher must still be able
      // to take attendance. The reason is surfaced, never swallowed.
      const described = describeProcessingError(e);
      setRecognitionError(described.message);
      setCanRollCall(described.canRollCall);
    }

    setProcessingStage("Preparing the summary");
    setProcessingPercent(90);
    try {
      setSummary(await summarizeCaptureSessionAction({ sessionId: started.session.id }));
    } catch (e) {
      setProcessingError(
        e instanceof Error
          ? `Could not summarize the session: ${e.message}`
          : "Could not summarize the session.",
      );
    }
    setProcessingPercent(100);
    setStep("summary");
  }, [shots, started]);

  const openReview = useCallback(
    (sessionId: string) => {
      router.push(`/dashboard/attendance/${cohortId}/review/${sessionId}`);
    },
    [cohortId, router],
  );

  /**
   * The fallback when recognition could not run: the register is built from
   * the enrolled roster with every student awaiting a decision. Nothing is
   * presumed present or absent — the teacher calls the roll.
   */
  const startRollCall = useCallback(async () => {
    if (!started) return;
    setRollCallError(null);
    setRollCallBusy(true);
    try {
      await startManualRollCallAction({ sessionId: started.session.id });
      openReview(started.session.id);
    } catch (e) {
      setRollCallError(describeProcessingError(e).message);
    } finally {
      setRollCallBusy(false);
    }
  }, [openReview, started]);

  const discard = useCallback(async () => {
    if (started) {
      try {
        await cancelCaptureSessionAction({ sessionId: started.session.id });
      } catch {
        // Best effort. The session either moved to CANCELLED or was already
        // terminal; either way the user is leaving.
      }
    }
    camera.stop();
    router.push(`/dashboard/attendance/${cohortId}`);
  }, [camera, cohortId, router, started]);

  // -------------------------------------------------------------------------
  // Derived
  // -------------------------------------------------------------------------
  const captureLimitReached = shots.length >= MAX_CAPTURES_PER_SESSION;
  const busyChecking = shots.some((s) => s.checking);
  const canProcess = shots.length > 0 && !busyChecking && !shots.some((s) => s.failure);
  const contextLabel = useMemo(() => {
    if (!started) return "";
    const bits = [started.cohortName];
    if (started.subjectName) bits.push(started.subjectName);
    bits.push(`${started.enrolledStudentCount} enrolled`);
    return bits.join(" · ");
  }, [started]);

  const banner = !isOnline ? (
    <div
      role="alert"
      className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"
    >
      You appear to be offline. Captures cannot be processed until the
      connection returns — the photos you have already taken are kept.
    </div>
  ) : null;

  // =========================================================================
  // Briefing
  // =========================================================================
  if (step === "briefing") {
    const noStudents = started?.enrolledStudentCount === 0;
    return (
      <div className="flex flex-col gap-6">
        {banner}
        <section className="rounded-md border border-neutral-200 p-6">
          <h2 className="text-base font-semibold text-neutral-900">Before you capture</h2>
          <p className="mt-1 text-sm text-neutral-600">
            You can take up to {MAX_CAPTURES_PER_SESSION} photos. One is enough for a
            small class; add a second or third from another angle when students are
            obscured.
          </p>
          <ul className="mt-3 flex flex-col gap-1.5 text-sm text-neutral-700">
            {CAPTURE_TIPS.map((tip) => (
              <li key={tip} className="flex gap-2">
                <span
                  className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-neutral-400"
                  aria-hidden
                />
                <span>{tip}</span>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-xs text-neutral-500">
            Classroom photos are processed and discarded — none is stored on our
            servers. Only the attendance result is kept.
          </p>
        </section>

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={start} disabled={starting || noStudents}>
            {starting ? "Starting…" : "Start attendance"}
          </Button>
          {attendanceMode === "SUBJECT_WISE" && !cohortSubjectId && (
            <span className="text-xs text-red-600">
              No subject selected — go back to the class page and pick one first.
            </span>
          )}
        </div>
        {startError && (
          <p role="alert" className="text-sm text-red-600">
            {startError}
          </p>
        )}
      </div>
    );
  }

  // =========================================================================
  // Camera
  // =========================================================================
  if (step === "camera") {
    const state = camera.state;
    const showVideo = state.name === "ready" || state.name === "capturing";
    const failure = state.name === "failed" ? state.failure : null;

    return (
      <div className="flex flex-col gap-4">
        {banner}
        <div className="flex flex-col gap-1">
          <p className="text-xs uppercase tracking-wide text-neutral-500">
            {started?.resumed ? "Resumed session" : "New session"}
          </p>
          <p className="text-sm text-neutral-700">{contextLabel}</p>
        </div>

        <div className="relative w-full overflow-hidden rounded-md border border-neutral-200 bg-neutral-950">
          {/* The element stays mounted across every state: `open()` resolves
              into this ref, and a ref pointing at an element React has just
              unmounted is how a camera ends up running with nothing to draw
              it. */}
          <video
            ref={camera.videoRef}
            playsInline
            muted
            className={`aspect-video w-full object-cover ${showVideo ? "block" : "invisible"}`}
            aria-label="Classroom camera preview"
          />
          {!showVideo && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center">
              <p className="text-sm text-neutral-200">{cameraStatusLabel(state)}</p>
              {state.name === "starting" && (
                <p className="text-xs text-neutral-400">
                  Your browser may ask for permission to use the camera.
                </p>
              )}
              {state.name === "unsupported" && (
                <p className="text-xs text-neutral-400">
                  Open this page in Chrome, Edge or Safari over HTTPS, or use a phone
                  or tablet.
                </p>
              )}
            </div>
          )}
        </div>

        {failure && (
          <div
            role="alert"
            className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
          >
            {failure.message}
          </div>
        )}
        {captureError && (
          <p role="alert" className="text-sm text-red-600">
            {captureError}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {canCapture(state) ? (
            <Button onClick={capture} disabled={captureLimitReached}>
              {captureLimitReached
                ? "Capture limit reached"
                : `Capture photo ${shots.length + 1} of ${MAX_CAPTURES_PER_SESSION}`}
            </Button>
          ) : (
            <Button
              onClick={() => void camera.start()}
              disabled={!canStart(state) || state.name === "starting"}
            >
              {state.name === "starting"
                ? "Opening camera…"
                : state.name === "failed"
                  ? "Try again"
                  : "Open camera"}
            </Button>
          )}
          {shots.length > 0 && (
            <Button variant="secondary" onClick={() => setStep("review")}>
              Review {shots.length} photo{shots.length === 1 ? "" : "s"}
            </Button>
          )}
          <Button variant="secondary" onClick={discard}>
            Discard session
          </Button>
        </div>

        {/* Device switching. Only offered once a stream has run: before
            permission is granted the browser reports no usable labels. */}
        {camera.devices.length > 1 && state.name === "ready" && (
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="camera-device" className="text-xs text-neutral-500">
              Camera
            </label>
            <select
              id="camera-device"
              value={camera.activeDeviceId ?? ""}
              onChange={(e) => void camera.switchDevice(e.target.value)}
              className="rounded-md border border-neutral-300 px-2 py-1.5 text-xs text-neutral-800"
            >
              {camera.devices.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label}
                </option>
              ))}
            </select>
          </div>
        )}

        <p className="text-xs text-neutral-500">
          Reposition between shots so students hidden in one photo appear in another.
          One solid capture is usually enough for a small class.
        </p>
      </div>
    );
  }

  // =========================================================================
  // Review captures
  // =========================================================================
  if (step === "review") {
    return (
      <div className="flex flex-col gap-4">
        {banner}
        <div className="flex items-baseline justify-between">
          <h2 className="text-base font-semibold text-neutral-900">Review captures</h2>
          <span className="text-xs text-neutral-500">
            {shots.length} of up to {MAX_CAPTURES_PER_SESSION} captures
          </span>
        </div>

        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {shots.map((s) => (
            <li
              key={s.sequenceNumber}
              className="flex flex-col gap-2 rounded-md border border-neutral-200 p-2"
            >
              {/* A data URL held in memory for the length of this step.
                  next/image optimises assets served from a URL and has nothing
                  to do here; it would also mean handing a photograph of a
                  classroom to an image pipeline. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={s.dataUrl}
                alt={`Capture ${s.sequenceNumber}`}
                className="aspect-video w-full rounded-sm bg-neutral-100 object-cover"
              />
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-neutral-500">
                  Photo {s.sequenceNumber}
                </span>
                <span
                  className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${qualityBadgeClasses(s.analysis?.qualityLabel)}`}
                >
                  {qualityBadgeText(s.analysis?.qualityLabel, s.checking === true)}
                </span>
              </div>
              {s.analysis && (
                <p className="text-xs text-neutral-600">
                  {s.analysis.faceCount} face{s.analysis.faceCount === 1 ? "" : "s"} detected
                  {s.analysis.averageDetectionConfidence !== null &&
                    ` · avg confidence ${(s.analysis.averageDetectionConfidence * 100).toFixed(0)}%`}
                </p>
              )}
              {s.analysis?.qualityHint && (
                <p className="text-xs text-neutral-500">{s.analysis.qualityHint}</p>
              )}
              {s.failure && (
                <p className="text-xs text-red-600" role="alert">
                  {s.failure.message}
                </p>
              )}
              <p className="text-[10px] text-neutral-400">
                {s.width}×{s.height}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  onClick={() => retakeShot(s.sequenceNumber)}
                  className="!py-1 !text-xs"
                >
                  Retake
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => removeShot(s.sequenceNumber)}
                  className="!py-1 !text-xs"
                >
                  Remove
                </Button>
              </div>
            </li>
          ))}
        </ul>

        {shots.length === 0 && (
          <p className="rounded-md border border-dashed border-neutral-300 px-4 py-6 text-center text-sm text-neutral-500">
            No captures yet. Open the camera and take at least one photo of the class.
          </p>
        )}

        {processingError && (
          <p role="alert" className="text-sm text-red-600">
            {processingError}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={process} disabled={!canProcess}>
            Process attendance
          </Button>
          {!captureLimitReached && (
            <Button variant="secondary" onClick={captureAnother}>
              {shots.length === 0 ? "Open camera" : "Capture another photo"}
            </Button>
          )}
          <Button variant="secondary" onClick={discard}>
            Discard session
          </Button>
        </div>
        {!canProcess && shots.length > 0 && (
          <p className="text-xs text-neutral-500">
            {busyChecking
              ? "Checking the captures — this takes a moment."
              : "Retake or remove any photo that failed its check before continuing."}
          </p>
        )}
      </div>
    );
  }

  // =========================================================================
  // Processing
  // =========================================================================
  if (step === "processing") {
    return (
      <div className="flex flex-col gap-4">
        {banner}
        <h2 className="text-base font-semibold text-neutral-900">Processing captures</h2>
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={processingPercent}
          aria-label="Recognition progress"
          className="h-2 w-full overflow-hidden rounded-full bg-neutral-100"
        >
          <div
            className="h-full bg-neutral-900 transition-[width] duration-500 ease-out"
            style={{ width: `${processingPercent}%` }}
          />
        </div>
        <p className="text-sm text-neutral-700" aria-live="polite">
          {processingStage}…
        </p>
        <p className="text-xs text-neutral-400">
          Do not close this tab. All {shots.length} capture
          {shots.length === 1 ? "" : "s"} are analysed together so a student seen in
          two photos is counted once.
        </p>
      </div>
    );
  }

  // =========================================================================
  // Summary
  //
  // Counts are derived from the server's run: `perStudent` is already one
  // deduplicated row per student, and `unmatchedStudentIds` is the rest of the
  // class.
  // =========================================================================
  const perStudent = recognition?.perStudent ?? [];
  const presentCount = perStudent.filter((s) => s.advisoryResult === "PRESENT").length;
  const reviewCount = perStudent.filter((s) => s.advisoryResult === "NEEDS_REVIEW").length;
  const ambiguousCount = perStudent.filter((s) => s.wasAmbiguous).length;
  const noFacesAtAll = recognition !== null && recognition.detectedFacesTotal === 0;
  const facesButNoMatches =
    recognition !== null && recognition.detectedFacesTotal > 0 && perStudent.length === 0;

  return (
    <div className="flex flex-col gap-4">
      {banner}
      <h2 className="text-base font-semibold text-neutral-900">
        {generation ? "Session ready for review" : "Captures processed"}
      </h2>

      {summary && !summary.productionEligible && (
        <div
          role="alert"
          className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900"
        >
          The recognition model currently loaded is{" "}
          <strong>not cleared for production use</strong> (backend: {summary.modelName} ·{" "}
          {summary.modelVersion}). Face counts and matches below describe the
          pipeline, not real identification. Confirm every student yourself.
        </div>
      )}

      {recognitionError && (
        <div
          role="alert"
          className="flex flex-col gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800"
        >
          <p>{recognitionError}</p>
          {canRollCall && (
            <>
              <p>
                No attendance has been recorded, and nobody has been marked absent as
                a result. A roll call opens the class list with every student awaiting
                your decision.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Button onClick={startRollCall} disabled={rollCallBusy} className="!py-1 !text-xs">
                  {rollCallBusy ? "Opening roll call…" : "Continue to manual roll call"}
                </Button>
                <Button
                  variant="secondary"
                  onClick={process}
                  disabled={rollCallBusy}
                  className="!py-1 !text-xs"
                >
                  Try recognition again
                </Button>
              </div>
            </>
          )}
          {rollCallError && <p role="alert">{rollCallError}</p>}
        </div>
      )}

      {processingError && (
        <p role="alert" className="text-sm text-red-600">
          {processingError}
        </p>
      )}

      {summary && (
        <dl className="grid grid-cols-2 gap-4 rounded-md border border-neutral-200 p-4 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs text-neutral-500">Photos captured</dt>
            <dd className="text-lg font-semibold text-neutral-900">{summary.captureCount}</dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-500">Faces detected</dt>
            <dd className="text-lg font-semibold text-neutral-900">
              {recognition?.detectedFacesTotal ?? summary.totalFacesDetected}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-500">Enrolled students</dt>
            <dd className="text-lg font-semibold text-neutral-900">
              {summary.enrolledStudentCount}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-500">Model</dt>
            <dd
              className="truncate text-sm text-neutral-700"
              title={`${summary.modelName} · ${summary.modelVersion}`}
            >
              {summary.modelName}
            </dd>
          </div>
        </dl>
      )}

      {noFacesAtAll && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <strong>No faces were detected in any capture.</strong> Nobody has been
          marked absent because of it — every student is waiting for your decision.
          Retake with more light, or move closer to the class.
        </div>
      )}

      {facesButNoMatches && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <strong>
            {recognition?.detectedFacesTotal} face
            {recognition?.detectedFacesTotal === 1 ? " was" : "s were"} detected, but
            none matched an enrolled student.
          </strong>{" "}
          This usually means the class has no face enrollments yet. Every student is
          waiting for your decision rather than being marked absent.
        </div>
      )}

      {recognition && (
        <section className="flex flex-col gap-3 rounded-md border border-neutral-200 p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-sm font-semibold text-neutral-900">Recognition advisory</h3>
            <span className="text-xs text-neutral-500">
              {recognition.scoredFacesTotal} of {recognition.detectedFacesTotal} detected
              faces scored against {recognition.candidatePoolSize} enrolled students in
              this class
            </span>
          </div>

          <dl className="grid grid-cols-3 gap-4 text-sm">
            <div>
              <dt className="text-xs text-neutral-500">Suggested present</dt>
              <dd className="text-lg font-semibold text-emerald-700">{presentCount}</dd>
            </div>
            <div>
              <dt className="text-xs text-neutral-500">Needs review</dt>
              <dd className="text-lg font-semibold text-amber-700">{reviewCount}</dd>
            </div>
            <div>
              <dt className="text-xs text-neutral-500">No match found</dt>
              <dd className="text-lg font-semibold text-neutral-700">
                {recognition.unmatchedStudentIds.length}
              </dd>
            </div>
          </dl>

          {ambiguousCount > 0 && (
            <p className="text-xs text-amber-800">
              {ambiguousCount} {ambiguousCount === 1 ? "student was" : "students were"}{" "}
              routed to review rather than marked present — either too close to another
              enrolled student to separate confidently, or claimed by two faces in the
              same photo.
            </p>
          )}

          {recognition.skippedIncompatibleCandidates > 0 && (
            <p className="text-xs text-neutral-600">
              {recognition.skippedIncompatibleCandidates} enrolled{" "}
              {recognition.skippedIncompatibleCandidates === 1 ? "student" : "students"}{" "}
              could not be compared because their stored face data was captured with a
              different model version. That is not evidence of absence — they must be
              re-enrolled or marked by roll call.
            </p>
          )}

          <p className="rounded-md bg-neutral-50 px-3 py-2 text-xs text-neutral-700">
            <strong>Advisory only — attendance is not final.</strong> These results are
            a starting point for the register; nothing counts until you confirm it. An
            uncertain match is never silently promoted to present.
          </p>
        </section>
      )}

      {generation && (
        <section className="flex flex-col gap-2 rounded-md border border-neutral-200 p-4">
          <h3 className="text-sm font-semibold text-neutral-900">Attendance register</h3>
          <p className="text-xs text-neutral-600">
            {generation.counts.total} enrolled{" "}
            {generation.counts.total === 1 ? "student has" : "students have"} a row in
            this session&apos;s register
            {generation.rosterScope === "cohortSubject"
              ? " (this subject's enrolled students)"
              : " (the whole class)"}
            . Every one of them is accounted for — nobody was dropped for having no
            usable face data.
          </p>
          <dl className="grid grid-cols-3 gap-4 text-sm">
            <div>
              <dt className="text-xs text-neutral-500">Present</dt>
              <dd className="text-lg font-semibold text-emerald-700">
                {generation.counts.present}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-neutral-500">Absent</dt>
              <dd className="text-lg font-semibold text-neutral-700">
                {generation.counts.absent}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-neutral-500">Needs review</dt>
              <dd className="text-lg font-semibold text-amber-700">
                {generation.counts.needsReview + generation.counts.notEvaluated}
              </dd>
            </div>
          </dl>
        </section>
      )}

      <p className="text-sm text-neutral-600">
        The captures have been analysed and discarded. Nothing was stored, so a
        retake later would have to be taken live.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        {generation ? (
          <Button onClick={() => started && openReview(started.session.id)}>
            Review and confirm attendance
          </Button>
        ) : null}
        <Button
          variant="secondary"
          onClick={() => router.push(`/dashboard/attendance/${cohortId}`)}
        >
          Back to class
        </Button>
        {!generation && (
          <Button variant="secondary" onClick={discard}>
            Discard session
          </Button>
        )}
      </div>
    </div>
  );
}
