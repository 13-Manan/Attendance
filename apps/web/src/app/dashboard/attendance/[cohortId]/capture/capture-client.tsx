"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { CameraIcon, CheckIcon, PlusIcon, RetakeIcon, Spinner, SwitchCameraIcon } from "@/components/attendance/icons";
import type {
  CaptureImageAnalysis,
  CaptureSessionSummary,
  StartCaptureSessionResult,
} from "@/modules/attendance-capture/types";
import { MAX_CAPTURES_PER_SESSION } from "@/modules/attendance-capture/types";
import { canCapture, canStart } from "@/modules/attendance-capture/camera";
import { fixtureCameraSource } from "@/modules/attendance-capture/camera-source";
import {
  PROCESSING_LABEL,
  cameraHelp,
  cameraStageOf,
  describeCaptureFlowError,
  doneStateOf,
  formatElapsed,
  nextSequenceNumber,
  photoStatusOf,
  platformOf,
  readySummaryOf,
  type CaptureFlowErrorCode,
  type ProcessingPhase,
} from "@/modules/attendance-capture/capture-flow";
import {
  cancelCaptureFlow,
  checkCapturePhotoFlow,
  markByHandFlow,
  processCaptureFlow,
  startCaptureFlow,
  summarizeCaptureFlow,
} from "@/modules/attendance-capture/flow-actions";
import { useClassroomCamera } from "@/modules/attendance-capture/use-classroom-camera";
import type { GenerateAttendanceCandidatesResult } from "@/modules/attendance-review/service";
import type { RecognitionRunSummary } from "@/modules/recognition-engine/types";
import type { AttendanceMode } from "@/modules/institutions/types";
import { describeRecognitionAvailability } from "@/modules/recognition-engine/wording";
import {
  ActionButton,
  CaptureShell,
  ConfirmBar,
  ShutterButton,
  StatusChip,
  Viewfinder,
  toneClasses,
  type ShellTone,
} from "./capture-screens";

/**
 * The classroom capture wizard.
 *
 *   (start) → camera → photo → matching → result
 *
 * On a phone it takes the whole screen; on a wider one it sits in the page.
 * Opened from the Today card or the class page with `autoStart`, it opens
 * today's register and the camera at once; otherwise it shows one "Take
 * attendance" button first.
 *
 * ## Where state lives, and why
 *
 * The attendance session id is server-side, so a refresh resumes rather than
 * duplicating. Everything the browser holds — the camera stream, the captured
 * previews — is in memory only: no `localStorage`, no IndexedDB, nothing that
 * outlives the tab. A refresh loses the photographs and the teacher retakes
 * them, which is the correct default for images of a room full of children.
 *
 * The counts on the result screen are the *server's*, not this component's.
 *
 * ## What it does not decide
 *
 * Attendance. The face check on each photo, recognition and the register are
 * the server's, through the same actions as before (`flow-actions.ts` only
 * changes how their failures come back). "Done" is allowed exactly when
 * "Process attendance" was. Recognised students are suggestions the teacher
 * confirms on the review screen.
 *
 * ## Camera
 *
 * All of it is behind `useClassroomCamera`. This file decides what to render
 * for each camera state; it never touches `getUserMedia`, a `MediaStream`, or
 * a canvas.
 */

type WizardStep = "start" | "camera" | "photo" | "processing" | "result";

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
  /** Set while the face check is in flight. */
  checking?: boolean;
  /** Set when the check failed — the shot gets a retake rather than being
   * silently dropped. */
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
  /**
   * Whether to show which recognition provider and model build ran. Admins
   * (`faceEmbedding.manage`) only: a teacher is told whether matching is
   * available and what that means for them, not which backend is loaded.
   */
  showDiagnostics?: boolean;
  /** Arrived from a register's "Add another photo". Changes the wording only;
   * whether a run merges is decided by the session's own state. */
  addingToRegister?: boolean;
  /** The teacher already asked to start: open the register and the camera. */
  autoStart?: boolean;
  /** What is being taken, for the header: "Data Structures", "CSE Sem 3 - Section 1", "Thu, Oct 1". */
  context: { title: string; subtitle: string | null; dateLabel: string };
  /** Where the back arrow goes (Today, or the class page). */
  back: { href: string; label: string };
  /** Whether this account can open the review board. An attendance operator
   * captures; the class's teacher reviews. */
  canReview?: boolean;
  /** Nobody is on roll: there is no register to take, so nothing is started. */
  noStudents?: boolean;
}

const CAPTURE_TIPS = [
  "Stand where you can see the whole class, and include every row",
  "Ask students to face forward, with hats and hands away from faces",
  "Avoid strong backlighting — the window behind the class is the classic trap",
  "Take a second photo from another angle if students are behind one another",
] as const;

// `navigator.onLine` and page visibility, defined outside the component so
// React's referential snapshot equality holds across renders.
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
function subscribeToVisibility(cb: () => void): () => void {
  if (typeof document === "undefined") return () => {};
  document.addEventListener("visibilitychange", cb);
  return () => document.removeEventListener("visibilitychange", cb);
}
function getVisibleSnapshot(): boolean {
  return typeof document === "undefined" ? true : document.visibilityState === "visible";
}
function alwaysTrue(): boolean {
  return true;
}

// ---------------------------------------------------------------------------

export function CaptureWizard({
  cohortId,
  cohortSubjectId,
  attendanceMode,
  useFixtureCamera = false,
  showDiagnostics = false,
  addingToRegister = false,
  autoStart = false,
  context,
  back,
  canReview = true,
  noStudents = false,
}: Props) {
  const router = useRouter();
  const [step, setStep] = useState<WizardStep>("start");
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<CaptureFlowErrorCode | null>(
    noStudents ? "no_students" : null,
  );
  const [started, setStarted] = useState<StartCaptureSessionResult | null>(null);

  const [shots, setShots] = useState<CapturedShot[]>([]);
  const [selected, setSelected] = useState<1 | 2 | 3 | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);

  const [phase, setPhase] = useState<ProcessingPhase>("matching");
  const [processingSince, setProcessingSince] = useState(0);
  const [clock, setClock] = useState(0);
  const [summary, setSummary] = useState<CaptureSessionSummary | null>(null);
  const [recognition, setRecognition] = useState<RecognitionRunSummary | null>(null);
  const [generation, setGeneration] = useState<GenerateAttendanceCandidatesResult | null>(null);
  const [processError, setProcessError] = useState<CaptureFlowErrorCode | null>(null);
  const [markByHandBusy, setMarkByHandBusy] = useState(false);
  const [markByHandError, setMarkByHandError] = useState<CaptureFlowErrorCode | null>(null);

  const [confirmLeave, setConfirmLeave] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const headingRef = useRef<HTMLHeadingElement | null>(null);

  const isOnline = useSyncExternalStore(subscribeToOnlineStatus, getOnlineSnapshot, alwaysTrue);
  const isVisible = useSyncExternalStore(subscribeToVisibility, getVisibleSnapshot, alwaysTrue);

  // The fixture source is constructed once, and only when explicitly asked
  // for. `useMemo` because a fresh source each render would restart the camera.
  const fixtureSource = useMemo(
    () => (useFixtureCamera ? fixtureCameraSource() : undefined),
    [useFixtureCamera],
  );
  const camera = useClassroomCamera({ source: fixtureSource });

  // Leaving the camera step releases the hardware. The hook also handles
  // unmount and tab-hidden; this covers "moved on to the photo".
  const { stop: stopCamera } = camera;
  useEffect(() => {
    if (step !== "camera") stopCamera();
  }, [step, stopCamera]);

  /**
   * Open the camera once the camera step has actually rendered.
   *
   * Not in the click handler that sets the step. `setStep("camera")` only
   * schedules a render, so calling `camera.start()` on the next line runs while
   * `<video>` still does not exist — `videoRef.current` is null, the stream is
   * opened with nothing to draw into, and the state machine reaches `ready`
   * with no preview attached.
   *
   * An effect runs after commit, so the element is mounted by the time this
   * fires. Gated on `idle` specifically rather than `canStart`: a failed start
   * must wait for the user to press "Try again" instead of being retried
   * forever, and `ready`/`starting` must not be restarted. Gated on the page
   * being visible too: the hook stops the camera when the tab is hidden, and
   * restarting it there would only be stopped again.
   */
  const cameraState = camera.state.name;
  const { start: startCamera, activeDeviceId, devices: cameraDevices, switchDevice, videoRef } = camera;
  useEffect(() => {
    if (step === "camera" && cameraState === "idle" && isVisible) {
      void startCamera(activeDeviceId ?? undefined);
    }
  }, [step, cameraState, startCamera, activeDeviceId, isVisible]);

  // A screen reader hears where it is after every step change.
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, [step]);

  // While matching runs: an honest clock, and the screen kept awake so a
  // phone does not lock in the teacher's hand.
  useEffect(() => {
    if (step !== "processing") return;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    let lock: { release: () => Promise<void> } | null = null;
    let done = false;
    const wakeLock = (navigator as Navigator & {
      wakeLock?: { request: (type: "screen") => Promise<{ release: () => Promise<void> }> };
    }).wakeLock;
    wakeLock
      ?.request("screen")
      .then((sentinel) => {
        if (done) void sentinel.release().catch(() => {});
        else lock = sentinel;
      })
      .catch(() => {
        // Not supported, or refused: the screen may dim. Nothing to tell anyone.
      });
    return () => {
      done = true;
      window.clearInterval(timer);
      void lock?.release().catch(() => {});
    };
  }, [step]);

  // On a phone the flow covers the page; the page underneath must not scroll.
  const fullScreen = step !== "start" || autoStart;
  useEffect(() => {
    if (!fullScreen || !window.matchMedia("(max-width: 767px)").matches) return;
    const previous = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    return () => {
      document.documentElement.style.overflow = previous;
    };
  }, [fullScreen]);

  // -------------------------------------------------------------------------
  // Session
  // -------------------------------------------------------------------------
  const start = useCallback(async () => {
    setStartError(null);
    setStarting(true);
    try {
      const result = await startCaptureFlow({ cohortId, cohortSubjectId });
      if (!result.ok) {
        setStartError(result.code);
        return;
      }
      setStarted(result.value);
      // A class with nobody on roll has no register to build: say so now,
      // rather than after the teacher has photographed an empty room.
      if (result.value.enrolledStudentCount === 0) {
        setStartError("no_students");
        return;
      }
      setStep("camera");
    } catch {
      setStartError("unknown");
    } finally {
      setStarting(false);
    }
  }, [cohortId, cohortSubjectId]);

  // The teacher's tap on the Today card is the start. Once, even under React's
  // development double-invoke: Start is idempotent on the server, but a second
  // call would write a second audit row.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (!autoStart || noStudents || autoStarted.current) return;
    autoStarted.current = true;
    void start();
  }, [autoStart, noStudents, start]);

  // -------------------------------------------------------------------------
  // Capture, face check, retake
  // -------------------------------------------------------------------------

  /**
   * Sends one frame for its face check, as soon as the shutter is pressed, so
   * a photograph with nobody in it is caught while the class is still sitting
   * there. Detection only on the server — no embedding is produced for a frame
   * the teacher may be about to discard.
   */
  const checkShot = useCallback(async (sessionId: string, shot: CapturedShot) => {
    const settle = (patch: Partial<CapturedShot>) =>
      setShots((current) =>
        current.map((s) => (s.sequenceNumber === shot.sequenceNumber ? { ...s, ...patch } : s)),
      );
    settle({ checking: true, failure: undefined });
    try {
      const result = await checkCapturePhotoFlow({
        sessionId,
        sequenceNumber: shot.sequenceNumber,
        imageBase64: shot.imageBase64,
      });
      if (!result.ok) {
        settle({
          checking: false,
          analysis: undefined,
          failure: { message: describeCaptureFlowError(result.code, "process").message, retryable: true },
        });
      } else if (result.value.ok) {
        settle({ checking: false, analysis: result.value, failure: undefined });
      } else {
        settle({
          checking: false,
          analysis: undefined,
          failure: { message: result.value.message, retryable: result.value.retryable },
        });
      }
    } catch {
      settle({
        checking: false,
        failure: { message: "Couldn't reach the server to check this photo. Check the connection and retake.", retryable: true },
      });
    }
  }, []);

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
    setShots((current) => [...current, shot].sort((a, b) => a.sequenceNumber - b.sequenceNumber));
    setSelected(sequenceNumber);
    setFlash(true);
    window.setTimeout(() => setFlash(false), 150);
    setStep("photo");
    void checkShot(started.session.id, shot);
  }, [camera, checkShot, shots, started]);

  const removeShot = useCallback((sequenceNumber: 1 | 2 | 3) => {
    setShots((current) => current.filter((s) => s.sequenceNumber !== sequenceNumber));
  }, []);

  /** A retake gives up the photo's slot; the next capture takes it back. */
  const retakeShot = useCallback(
    (sequenceNumber: 1 | 2 | 3) => {
      removeShot(sequenceNumber);
      setStep("camera");
    },
    [removeShot],
  );

  const removeSelected = useCallback(() => {
    if (selected === null) return;
    const remaining = shots.filter((s) => s.sequenceNumber !== selected);
    removeShot(selected);
    if (remaining.length === 0) {
      setSelected(null);
      setStep("camera");
    } else {
      setSelected(remaining[remaining.length - 1].sequenceNumber);
    }
  }, [removeShot, selected, shots]);

  // -------------------------------------------------------------------------
  // Matching
  //
  // Recognition and register generation happen in ONE server call. If the
  // browser ran recognition and posted results back, a client could simply
  // claim everybody was matched — attendance would be asserted by the device
  // rather than measured. What the browser gets back is display-only.
  // -------------------------------------------------------------------------
  const done = doneStateOf(shots);

  const process = useCallback(async () => {
    if (!started || !doneStateOf(shots).enabled) return;
    setStep("processing");
    setPhase("matching");
    setProcessingSince(Date.now());
    setClock(Date.now());
    setProcessError(null);
    setRecognition(null);
    setGeneration(null);
    setMarkByHandError(null);

    try {
      const result = await processCaptureFlow({
        sessionId: started.session.id,
        images: shots.map((s) => ({ sequenceNumber: s.sequenceNumber, imageBase64: s.imageBase64 })),
        // A session that was already in review when this wizard opened has a
        // register. These photos are added to it: a student found earlier is
        // not un-found, and a teacher's decision is not overwritten.
        merge: started.session.status === "REVIEW",
      });
      if (result.ok) {
        setRecognition(result.value.recognition);
        setGeneration(result.value.generation);
      } else {
        setProcessError(result.code);
      }
    } catch {
      // The request itself failed — the connection, usually.
      setProcessError("unknown");
    }

    setPhase("preparing");
    try {
      const summarized = await summarizeCaptureFlow({ sessionId: started.session.id });
      if (summarized.ok) setSummary(summarized.value);
    } catch {
      // The summary only decorates the result; the register is written.
    }
    setStep("result");
  }, [shots, started]);

  const reviewHref = started
    ? `/dashboard/attendance/${cohortId}/review/${started.session.id}`
    : null;

  /**
   * Marking by hand: the register is built from the class list with every
   * student awaiting the teacher's decision. Nothing is presumed present or
   * absent — the existing manual roll call, offered wherever the camera or the
   * matching cannot help.
   */
  const markByHand = useCallback(async () => {
    if (!started || !reviewHref) return;
    setMarkByHandError(null);
    setMarkByHandBusy(true);
    try {
      const result = await markByHandFlow({ sessionId: started.session.id });
      if (result.ok) {
        camera.stop();
        router.push(reviewHref);
        return;
      }
      setMarkByHandError(result.code);
    } catch {
      setMarkByHandError("unknown");
    } finally {
      setMarkByHandBusy(false);
    }
  }, [camera, reviewHref, router, started]);

  /** This wizard is adding photos to a register already under review. */
  const addingToExisting = started?.session.status === "REVIEW";

  // Adding photos to a register under review: back means back to that
  // register, not to the class it belongs to.
  const backTarget =
    addingToExisting && reviewHref ? { href: reviewHref, label: "the register" } : back;

  const leave = useCallback(() => {
    camera.stop();
    router.push(backTarget.href);
  }, [backTarget.href, camera, router]);

  const onBack = useCallback(() => {
    // Photos not yet sent would be lost; ask once. Nothing else needs asking:
    // the register stays open, and the Today card offers to continue it.
    if ((step === "camera" || step === "photo") && shots.length > 0 && !confirmLeave) {
      setConfirmLeave(true);
      return;
    }
    leave();
  }, [confirmLeave, leave, shots.length, step]);

  const cancelAttendance = useCallback(async () => {
    // Leaving an add-photo round must not cancel the register it was adding
    // to: that register holds suggestions and decisions. Only the new,
    // never-sent photos are dropped, and they were only ever in memory.
    if (started && started.session.status === "REVIEW" && reviewHref) {
      camera.stop();
      router.push(reviewHref);
      return;
    }
    setCancelling(true);
    if (started) {
      try {
        await cancelCaptureFlow({ sessionId: started.session.id });
      } catch {
        // Best effort. The session either moved to CANCELLED or was already
        // terminal; either way the teacher is leaving.
      }
    }
    camera.stop();
    router.push(back.href);
  }, [back.href, camera, reviewHref, router, started]);

  // -------------------------------------------------------------------------
  // Derived
  // -------------------------------------------------------------------------
  const captureLimitReached = shots.length >= MAX_CAPTURES_PER_SESSION;
  const selectedShot = shots.find((s) => s.sequenceNumber === selected) ?? shots[shots.length - 1] ?? null;
  const subtitle = [context.subtitle, context.dateLabel].filter(Boolean).join(" · ");
  const platform = typeof navigator === "undefined" ? "other" : platformOf(navigator.userAgent);

  const offlineNotice = !isOnline ? (
    <p
      role="alert"
      className="mx-4 mt-2 rounded-lg bg-amber-100 px-3 py-2 text-sm text-amber-950 md:mx-5"
    >
      You appear to be offline. Photos can&apos;t be checked or matched until the connection
      returns — the ones you have taken are kept.
    </p>
  ) : null;

  const leaveBar = (tone: ShellTone) =>
    confirmLeave ? (
      <ConfirmBar
        tone={tone}
        message="Leave without finishing? These photos aren't saved — you can continue today's attendance later."
        cancelLabel="Stay"
        confirmLabel="Leave"
        onCancel={() => setConfirmLeave(false)}
        onConfirm={leave}
      />
    ) : null;

  const cancelControl = (tone: ShellTone) =>
    confirmCancel ? (
      <ConfirmBar
        tone={tone}
        message={
          addingToExisting
            ? "Stop adding photos? The register you were reviewing stays exactly as it was."
            : "Cancel today's attendance? The photos are deleted and this register is closed. You can start again."
        }
        cancelLabel="Keep going"
        confirmLabel={addingToExisting ? "Stop" : "Yes, cancel"}
        onCancel={() => setConfirmCancel(false)}
        onConfirm={() => void cancelAttendance()}
        busy={cancelling}
      />
    ) : (
      <div className="flex justify-center">
        <ActionButton tone={tone} kind="quiet" onClick={() => setConfirmCancel(true)}>
          {addingToExisting ? "Stop adding photos" : "Cancel attendance"}
        </ActionButton>
      </div>
    );

  // =========================================================================
  // Start — only when the teacher did not already ask to start
  // =========================================================================
  if (step === "start" && !autoStart) {
    const error = startError ? describeCaptureFlowError(startError, "start") : null;
    return (
      <section className="flex flex-col gap-4 rounded-2xl border border-neutral-200 bg-white p-4 sm:p-6">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold text-neutral-900">
            {addingToRegister ? "Add photos to this register" : "Ready to take attendance"}
          </h2>
          <p className="text-sm text-neutral-600">
            {addingToRegister
              ? "New photos are added to the register you were reviewing. A student already found stays found, and any decision you have made is kept."
              : `Take one photo of the whole class — up to ${MAX_CAPTURES_PER_SESSION} if some students are hidden.`}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void start()}
          disabled={starting || noStudents}
          className="flex min-h-14 w-full items-center justify-center gap-2.5 rounded-xl bg-neutral-900 px-5 text-base font-semibold text-white transition-colors hover:bg-neutral-700 disabled:bg-neutral-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 focus-visible:ring-offset-2 sm:w-auto sm:self-start"
        >
          {starting ? <Spinner className="size-5" /> : <CameraIcon className="size-5" />}
          {starting ? "Opening camera…" : addingToRegister ? "Open camera" : "Take attendance"}
        </button>
        {error ? (
          <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
            {error.message}
          </p>
        ) : null}
        {attendanceMode === "SUBJECT_WISE" && !cohortSubjectId ? (
          <p className="text-sm text-red-700">No subject selected — go back to the class page and pick one first.</p>
        ) : null}
        <details className="group rounded-lg border border-neutral-200 px-3 py-2">
          <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium text-neutral-700">
            Tips for a good photo
          </summary>
          <ul className="mt-1 flex flex-col gap-1.5 pb-1 text-sm text-neutral-700">
            {CAPTURE_TIPS.map((tip) => (
              <li key={tip} className="flex gap-2">
                <span className="mt-2 size-1.5 shrink-0 rounded-full bg-neutral-400" aria-hidden />
                <span>{tip}</span>
              </li>
            ))}
          </ul>
        </details>
        <p className="text-xs text-neutral-500">
          Classroom photos are checked and discarded — none is stored on our servers. Only the
          attendance result is kept.
        </p>
      </section>
    );
  }

  // =========================================================================
  // Opening — the register and the camera, straight from the Today card
  // =========================================================================
  if (step === "start") {
    const error = startError ? describeCaptureFlowError(startError, "start") : null;
    return (
      <CaptureShell
        tone="dark"
        title={context.title}
        subtitle={subtitle}
        onBack={leave}
        backLabel={backTarget.label}
        headingRef={headingRef}
        heading={error ? "Couldn't start attendance" : "Getting ready"}
        showHeading={false}
        notices={offlineNotice}
        footer={
          error ? (
            <div className="flex flex-col gap-2">
              {error.canRetry ? (
                <ActionButton tone="dark" size="lg" onClick={() => void start()} disabled={starting}>
                  Try again
                </ActionButton>
              ) : null}
              <ActionButton tone="dark" kind="secondary" onClick={leave}>
                Back to {backTarget.label}
              </ActionButton>
            </div>
          ) : null
        }
      >
        <Viewfinder>
          <div className="flex max-w-sm flex-col items-center gap-3 px-6 text-center text-white">
            {error ? (
              <>
                <p className="text-lg font-semibold" aria-hidden="true">
                  Couldn&apos;t start attendance
                </p>
                <p role="alert" className="text-sm text-white/85">
                  {error.message}
                </p>
              </>
            ) : (
              <>
                <Spinner className="size-8" />
                <p className="text-base font-medium" role="status">
                  Getting ready…
                </p>
              </>
            )}
          </div>
        </Viewfinder>
      </CaptureShell>
    );
  }

  // =========================================================================
  // Camera
  // =========================================================================
  if (step === "camera") {
    const state = camera.state;
    const stage = cameraStageOf(state);
    const showVideo = state.name === "ready" || state.name === "capturing";
    const help =
      state.name === "failed"
        ? cameraHelp(state.failure.kind, platform)
        : state.name === "unsupported"
          ? cameraHelp("unsupported", platform)
          : null;
    const nextNumber = nextSequenceNumber(shots) ?? MAX_CAPTURES_PER_SESSION;
    const t = toneClasses("dark");
    const markByHandCopy = markByHandError ? describeCaptureFlowError(markByHandError, "markByHand") : null;
    const lastShot = shots[shots.length - 1] ?? null;

    return (
      <CaptureShell
        tone="dark"
        title={context.title}
        subtitle={subtitle}
        onBack={onBack}
        backLabel={backTarget.label}
        headingRef={headingRef}
        heading={addingToExisting ? "Add a photo" : "Take a photo of the class"}
        notices={offlineNotice}
        footer={
          help ? (
            <>
              {help.canRetry && canStart(state) ? (
                <ActionButton tone="dark" size="lg" onClick={() => void camera.start(activeDeviceId ?? undefined)}>
                  Try again
                </ActionButton>
              ) : null}
              {help.offerMarkByHand && canReview && !addingToExisting ? (
                <ActionButton tone="dark" kind="secondary" onClick={() => void markByHand()} disabled={markByHandBusy}>
                  {markByHandBusy ? <Spinner className="size-4" /> : null}
                  Mark attendance by hand
                </ActionButton>
              ) : null}
              {markByHandCopy ? (
                <p role="alert" className={`text-sm ${t.body}`}>
                  {markByHandCopy.message}
                </p>
              ) : null}
              {leaveBar("dark")}
              {cancelControl("dark")}
            </>
          ) : (
            <>
              {captureError ? (
                <p role="alert" className="text-center text-sm text-amber-300 md:text-amber-700">
                  {captureError}
                </p>
              ) : null}
              {leaveBar("dark")}
              <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-4">
                <div className="flex justify-start">
                  {lastShot ? (
                    <button
                      type="button"
                      onClick={() => {
                        setSelected(lastShot.sequenceNumber);
                        setStep("photo");
                      }}
                      aria-label={`See your ${shots.length === 1 ? "photo" : `${shots.length} photos`}`}
                      className="relative size-14 overflow-hidden rounded-lg ring-2 ring-white/60 focus-visible:outline-none focus-visible:ring-4 md:ring-neutral-300"
                    >
                      {/* A data URL held in memory for the length of this flow.
                          next/image optimises assets served from a URL and has
                          nothing to do here. */}
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={lastShot.dataUrl} alt="" className="size-full object-cover" />
                      {shots.length > 1 ? (
                        <span className="absolute right-0.5 bottom-0.5 rounded bg-neutral-900/80 px-1 text-xs font-semibold text-white">
                          {shots.length}
                        </span>
                      ) : null}
                    </button>
                  ) : null}
                </div>
                <ShutterButton
                  label={`Take photo ${nextNumber} of ${MAX_CAPTURES_PER_SESSION}`}
                  disabled={!canCapture(state) || captureLimitReached}
                  onClick={capture}
                />
                <div className="flex justify-end">
                  {shots.length > 0 ? (
                    <ActionButton
                      tone="dark"
                      onClick={() => (done.enabled ? void process() : setStep("photo"))}
                    >
                      Done
                    </ActionButton>
                  ) : null}
                </div>
              </div>
              <p className={`text-center text-xs ${t.muted}`}>
                {captureLimitReached
                  ? "That's the most photos for one register."
                  : `Photo ${nextNumber} of ${MAX_CAPTURES_PER_SESSION} · Fit every row of the class in the frame`}
              </p>
            </>
          )
        }
      >
        <Viewfinder>
          {/* The element stays mounted across every camera state: `open()`
              resolves into this ref, and a ref pointing at an element React has
              just unmounted is how a camera ends up running with nothing to
              draw it. `object-contain` so the preview shows the whole frame
              that will be sent — not a crop of it. */}
          <video
            ref={videoRef}
            playsInline
            muted
            className={`size-full object-contain ${showVideo ? "block" : "invisible"}`}
            aria-label="Camera preview"
          />
          {!showVideo ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 overflow-y-auto px-6 text-center text-white">
              {stage === "requesting" ? (
                <>
                  <CameraIcon className="size-10" />
                  <p className="text-lg font-semibold">Allow camera access</p>
                  <p className="max-w-xs text-sm text-white/80">
                    Your {platform === "other" ? "browser" : "phone"} will ask to use the camera. Choose
                    Allow.
                  </p>
                </>
              ) : help ? (
                <>
                  <p className="text-lg font-semibold">{help.title}</p>
                  <ol className="flex max-w-xs list-decimal flex-col gap-1.5 pl-5 text-left text-sm text-white/85">
                    {help.steps.map((stepText) => (
                      <li key={stepText}>{stepText}</li>
                    ))}
                  </ol>
                </>
              ) : (
                <>
                  <Spinner className="size-8" />
                  <p className="text-sm text-white/80">Starting the camera…</p>
                </>
              )}
            </div>
          ) : null}
          {showVideo ? (
            <span className="absolute top-3 left-3 rounded-full bg-neutral-900/70 px-3 py-1 text-xs font-medium text-white">
              Photo {nextNumber} of {MAX_CAPTURES_PER_SESSION}
            </span>
          ) : null}
          {showVideo && cameraDevices.length > 1 ? (
            <button
              type="button"
              onClick={() => {
                const index = cameraDevices.findIndex((d) => d.deviceId === activeDeviceId);
                const next = cameraDevices[(index + 1) % cameraDevices.length];
                void switchDevice(next.deviceId);
              }}
              aria-label="Switch camera"
              className="absolute top-2 right-2 inline-flex size-11 items-center justify-center rounded-full bg-neutral-900/70 text-white hover:bg-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
            >
              <SwitchCameraIcon className="size-6" />
            </button>
          ) : null}
          {flash ? <div className="pointer-events-none absolute inset-0 bg-white/80 motion-reduce:hidden" aria-hidden /> : null}
        </Viewfinder>
      </CaptureShell>
    );
  }

  // =========================================================================
  // Photo — the captured frame, its face check, and what next
  // =========================================================================
  if (step === "photo" && selectedShot) {
    const status = photoStatusOf(selectedShot);
    const t = toneClasses("dark");
    return (
      <CaptureShell
        tone="dark"
        title={context.title}
        subtitle={subtitle}
        onBack={onBack}
        backLabel={backTarget.label}
        headingRef={headingRef}
        heading={`Photo ${selectedShot.sequenceNumber}: ${status.label}`}
        notices={offlineNotice}
        footer={
          <>
            {status.detail ? <p className={`text-sm ${t.body}`}>{status.detail}</p> : null}
            {leaveBar("dark")}
            <div className="grid grid-cols-2 gap-3">
              <ActionButton tone="dark" kind="secondary" onClick={() => retakeShot(selectedShot.sequenceNumber)}>
                <RetakeIcon className="size-4" />
                Retake
              </ActionButton>
              {!captureLimitReached ? (
                <ActionButton tone="dark" kind="secondary" onClick={() => setStep("camera")}>
                  <PlusIcon className="size-4" />
                  Add another photo
                </ActionButton>
              ) : (
                <ActionButton tone="dark" kind="secondary" onClick={removeSelected}>
                  Remove photo
                </ActionButton>
              )}
            </div>
            <ActionButton tone="dark" size="lg" onClick={() => void process()} disabled={!done.enabled}>
              {done.enabled ? (
                <>
                  <CheckIcon className="size-5" />
                  Done
                </>
              ) : (
                <>
                  {shots.some((s) => s.checking) ? <Spinner className="size-5" /> : null}
                  {done.reason}
                </>
              )}
            </ActionButton>
            {cancelControl("dark")}
          </>
        }
      >
        <Viewfinder>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={selectedShot.dataUrl}
            alt={`Photo ${selectedShot.sequenceNumber} of the class`}
            className="size-full object-contain"
          />
          <StatusChip status={status} className="absolute top-3 left-3" />
          {flash ? <div className="pointer-events-none absolute inset-0 bg-white/80 motion-reduce:hidden" aria-hidden /> : null}
        </Viewfinder>
        {shots.length > 1 ? (
          <div className="flex items-center justify-center gap-3 px-4 pt-3 md:justify-start md:px-5">
            {shots.map((shot) => {
              const shotStatus = photoStatusOf(shot);
              const isSelected = shot.sequenceNumber === selectedShot.sequenceNumber;
              return (
                <button
                  key={shot.sequenceNumber}
                  type="button"
                  onClick={() => setSelected(shot.sequenceNumber)}
                  aria-label={`Photo ${shot.sequenceNumber}: ${shotStatus.label}`}
                  aria-pressed={isSelected}
                  className={`relative size-14 overflow-hidden rounded-lg focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-white md:focus-visible:ring-neutral-900 ${
                    isSelected ? "ring-2 ring-white md:ring-neutral-900" : "opacity-70"
                  }`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={shot.dataUrl} alt="" className="size-full object-cover" />
                  <span
                    className={`absolute right-1 bottom-1 size-3 rounded-full ring-2 ring-neutral-950 ${
                      shotStatus.tone === "good"
                        ? "bg-emerald-500"
                        : shotStatus.tone === "checking"
                          ? "bg-neutral-300"
                          : shotStatus.tone === "warning"
                            ? "bg-amber-400"
                            : "bg-red-500"
                    }`}
                    aria-hidden
                  />
                </button>
              );
            })}
            {!captureLimitReached ? (
              <ActionButton tone="dark" kind="quiet" onClick={removeSelected}>
                Remove this photo
              </ActionButton>
            ) : null}
          </div>
        ) : null}
      </CaptureShell>
    );
  }

  // Unreachable: Retake, Remove and Done all return to the camera when no
  // photo is left. Rendering nothing beats rendering the wrong step.
  if (step === "photo") return null;

  // =========================================================================
  // Matching
  // =========================================================================
  if (step === "processing") {
    return (
      <CaptureShell
        tone="light"
        title={context.title}
        subtitle={subtitle}
        onBack={leave}
        backLabel={backTarget.label}
        backDisabled
        headingRef={headingRef}
        heading="Matching students"
        showHeading={false}
        notices={offlineNotice}
      >
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 py-12 text-center">
          <Spinner className="size-12 text-neutral-900" />
          <p className="text-xl font-semibold text-neutral-900" role="status" aria-live="polite">
            {PROCESSING_LABEL[phase]}
          </p>
          <p className="text-sm tabular-nums text-neutral-500">{formatElapsed(clock - processingSince)}</p>
          <p className="max-w-xs text-sm text-neutral-600">
            Keep this screen open. {shots.length === 1 ? "Your photo is" : `All ${shots.length} photos are`}{" "}
            checked together, so a student in two photos is counted once.
          </p>
        </div>
      </CaptureShell>
    );
  }

  // =========================================================================
  // Result
  // =========================================================================
  const modelState = recognition ?? summary;
  const availability = modelState ? describeRecognitionAvailability(modelState, { showDiagnostics }) : null;
  const perStudent = recognition?.perStudent ?? [];
  const ready = readySummaryOf({
    total: generation?.counts.total ?? summary?.enrolledStudentCount ?? started?.enrolledStudentCount ?? 0,
    recognition: recognition
      ? {
          recognised: perStudent.filter((s) => s.advisoryResult === "PRESENT").length,
          lookAlikes: perStudent.filter((s) => s.wasAmbiguous).length,
          detectedFaces: recognition.detectedFacesTotal,
          unknownFaces: recognition.unknownFacesTotal,
          comparableStudents: recognition.candidatePoolSize,
          needReenrolment: recognition.skippedIncompatibleCandidates,
          recommendRetake: recognition.recommendRetake,
        }
      : null,
    availability: availability?.availability ?? null,
  });
  const failed = processError !== null && generation === null;
  const failure = processError ? describeCaptureFlowError(processError, "process") : null;
  const markByHandCopy = markByHandError ? describeCaptureFlowError(markByHandError, "markByHand") : null;

  return (
    <CaptureShell
      tone="light"
      title={context.title}
      subtitle={subtitle}
      onBack={leave}
      backLabel={backTarget.label}
      headingRef={headingRef}
      heading={failed ? "Couldn't match students" : "Attendance ready"}
      showHeading={false}
      notices={offlineNotice}
      footer={
        failed ? (
          <>
            {failure?.canRetry ? (
              <ActionButton tone="light" size="lg" onClick={() => void process()} disabled={markByHandBusy}>
                Try again
              </ActionButton>
            ) : null}
            {failure?.canMarkByHand && canReview ? (
              <ActionButton tone="light" kind="secondary" onClick={() => void markByHand()} disabled={markByHandBusy}>
                {markByHandBusy ? <Spinner className="size-4" /> : null}
                Mark attendance by hand
              </ActionButton>
            ) : null}
            {markByHandCopy ? (
              <p role="alert" className="text-sm text-red-800">
                {markByHandCopy.message}
              </p>
            ) : null}
            <ActionButton tone="light" kind="quiet" onClick={leave}>
              Back to {backTarget.label}
            </ActionButton>
          </>
        ) : (
          <>
            {canReview && reviewHref ? (
              <ActionButton tone="light" size="lg" onClick={() => router.push(reviewHref)}>
                Review attendance
              </ActionButton>
            ) : (
              <p className="rounded-lg bg-neutral-50 px-3 py-2 text-sm text-neutral-700">
                Sent for review. The class&apos;s teacher confirms the register.
              </p>
            )}
            <ActionButton tone="light" kind="quiet" onClick={leave}>
              Back to {backTarget.label}
            </ActionButton>
          </>
        )
      }
    >
      <div className="flex flex-col gap-4 overflow-y-auto px-4 py-6 md:px-5">
        {failed ? (
          <div className="flex flex-col items-center gap-3 text-center">
            <span className="inline-flex size-14 items-center justify-center rounded-full bg-red-50 text-red-700">
              <CameraIcon className="size-7" />
            </span>
            <p className="text-xl font-semibold text-neutral-900" aria-hidden="true">
              Couldn&apos;t match students
            </p>
            <p role="alert" className="max-w-sm text-sm text-neutral-700">
              {failure?.message}
            </p>
            <p className="max-w-sm text-xs text-neutral-500">
              Nobody has been marked present or absent because of this.
            </p>
          </div>
        ) : (
          <>
            <div className="flex flex-col items-center gap-2 text-center">
              <span className="inline-flex size-14 items-center justify-center rounded-full bg-emerald-50 text-emerald-700">
                <CheckIcon className="size-8" />
              </span>
              <p className="text-xl font-semibold text-neutral-900" aria-hidden="true">
                Attendance ready
              </p>
              <p className="text-sm text-neutral-500">{subtitle ? `${context.title} · ${subtitle}` : context.title}</p>
            </div>
            <dl className="grid grid-cols-3 gap-2 text-center">
              <div className="flex flex-col-reverse rounded-xl bg-emerald-50 px-2 py-3">
                <dt className="text-xs text-emerald-900">Recognised</dt>
                <dd className="text-2xl font-semibold tabular-nums text-emerald-800">{ready.recognised}</dd>
              </div>
              <div className="flex flex-col-reverse rounded-xl bg-amber-50 px-2 py-3">
                <dt className="text-xs text-amber-900">To check</dt>
                <dd className="text-2xl font-semibold tabular-nums text-amber-800">{ready.toCheck}</dd>
              </div>
              <div className="flex flex-col-reverse rounded-xl bg-neutral-100 px-2 py-3">
                <dt className="text-xs text-neutral-700">Students</dt>
                <dd className="text-2xl font-semibold tabular-nums text-neutral-900">{ready.total}</dd>
              </div>
            </dl>
            {ready.notices.length > 0 ? (
              <ul className="flex flex-col gap-2">
                {ready.notices.map((notice) => (
                  <li
                    key={notice.text}
                    className={`rounded-lg px-3 py-2 text-sm ${
                      notice.tone === "warning" ? "bg-amber-50 text-amber-950" : "bg-neutral-50 text-neutral-700"
                    }`}
                  >
                    {notice.text}
                  </li>
                ))}
              </ul>
            ) : null}
            <p className="text-center text-sm text-neutral-600">
              {canReview
                ? "Recognised students are suggestions. Nothing is final until you confirm it on the next screen."
                : "Recognised students are suggestions until the register is confirmed."}
            </p>
            {availability?.diagnostics ? (
              <p className="text-center font-mono text-[11px] text-neutral-400">{availability.diagnostics}</p>
            ) : null}
          </>
        )}
      </div>
    </CaptureShell>
  );
}
