"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
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
import {
  processSessionAttendanceAction,
  startManualRollCallAction,
} from "@/modules/attendance-review/actions";
import type { GenerateAttendanceCandidatesResult } from "@/modules/attendance-review/service";
import type { RecognitionRunSummary } from "@/modules/recognition-engine/types";
import type { AttendanceMode } from "@/modules/institutions/types";

/**
 * Phase 4 classroom capture wizard.
 *
 * Steps, in order:
 *   1. briefing  — instructions + "Start attendance"
 *   2. camera    — live viewfinder, capture up to 3 photos
 *   3. review    — thumbnails, per-image quality, remove/retake/add
 *   4. processing — animated progress while analyses run
 *   5. summary   — face counts, model provenance, "prepare review"
 *
 * State that must survive a refresh (the attendance session id) is kept
 * server-side. Everything the client keeps (camera stream, base64 preview,
 * face-count analyses) is deliberately in-memory only — no localStorage,
 * no upload beyond the analyze/summarize Server Actions. A refresh
 * discards the previews; the server-side session can be resumed but the
 * user will need to retake photos, which is the correct default for
 * biometric material.
 */

type WizardStep = "briefing" | "camera" | "review" | "processing" | "summary";

interface CapturedShot {
  sequenceNumber: 1 | 2 | 3;
  /** Full data URL for the <img> preview. Local-only; never uploaded. */
  dataUrl: string;
  /** Raw base64 payload (no data: prefix) sent to the server. */
  imageBase64: string;
  /** Present once the server has analyzed this shot; undefined while
   * queued/in-flight/failed. */
  analysis?: CaptureImageAnalysis;
  /** Present when analysis failed for this shot — the review UI shows a
   * retake button rather than silently dropping the frame. */
  failure?: { message: string; retryable: boolean };
}

interface Props {
  cohortId: string;
  cohortSubjectId: string | null;
  attendanceMode: AttendanceMode;
}

const CAPTURE_TIPS = [
  "Move the camera to include every visible student",
  "Ask students to face forward, uncovered by hats or hands",
  "Avoid strong backlighting — the window behind the class is the classic trap",
  "A second photo from a different angle helps if some students are behind others",
] as const;

const PROCESSING_STAGES = [
  "Uploading captured image",
  "Detecting faces",
  "Assessing capture quality",
  "Recognizing enrolled students",
  "Combining results across images",
  "Preparing attendance review",
] as const;

// ---------------------------------------------------------------------------
// Small helpers, kept in this file because they are only used by the wizard.
// ---------------------------------------------------------------------------

function nextSequenceNumber(shots: CapturedShot[]): 1 | 2 | 3 | null {
  const used = new Set(shots.map((s) => s.sequenceNumber));
  for (const n of [1, 2, 3] as const) if (!used.has(n)) return n;
  return null;
}

function stripDataUrlPrefix(dataUrl: string): string {
  return dataUrl.split(",", 2)[1] ?? "";
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

function qualityBadgeText(label: CaptureImageAnalysis["qualityLabel"] | undefined): string {
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
      return "Analyzing…";
  }
}

// useSyncExternalStore adapters for `navigator.onLine`. Extracted from the
// component so React's snapshot equality (referential) is stable across
// renders — a fresh closure each render would tear the subscription.
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
  if (typeof window === "undefined") return true;
  return window.navigator.onLine;
}
function getServerOnlineSnapshot(): boolean {
  // Server-render assumes online; the banner only ever renders on the
  // client, so this is only used to satisfy the SSR contract.
  return true;
}

/** Best-effort camera-error → human message. `NotAllowedError` covers both
 * user-denied and OS-blocked permissions on every major browser. */
function humanCameraError(e: unknown): string {
  if (e instanceof Error) {
    if (e.name === "NotAllowedError" || e.name === "SecurityError") {
      return "Camera access was denied. Enable camera permission for this site in your browser settings, then try again.";
    }
    if (e.name === "NotFoundError" || e.name === "OverconstrainedError") {
      return "No usable camera was found on this device.";
    }
    if (e.name === "NotReadableError") {
      return "The camera is in use by another application. Close other apps that might be using it and try again.";
    }
    return `Could not open the camera: ${e.message}`;
  }
  return "Could not open the camera.";
}

// ---------------------------------------------------------------------------

export function CaptureWizard({ cohortId, cohortSubjectId, attendanceMode }: Props) {
  const router = useRouter();
  const [step, setStep] = useState<WizardStep>("briefing");
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [started, setStarted] = useState<StartCaptureSessionResult | null>(null);

  const [shots, setShots] = useState<CapturedShot[]>([]);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [cameraStatus, setCameraStatus] = useState<"idle" | "requesting" | "streaming">("idle");

  const [processingIndex, setProcessingIndex] = useState(0);
  const [processingStage, setProcessingStage] = useState<string>(PROCESSING_STAGES[0]);
  const [summary, setSummary] = useState<CaptureSessionSummary | null>(null);
  const [processingError, setProcessingError] = useState<string | null>(null);
  // Phase 5 recognition output. Null means recognition did not run or did not
  // succeed — the wizard still reaches the summary step in that case, because
  // the Phase 4 capture flow must keep working when the engine cannot.
  const [recognition, setRecognition] = useState<RecognitionRunSummary | null>(null);
  const [recognitionError, setRecognitionError] = useState<string | null>(null);
  // Phase 6: the attendance register this session produced. Non-null means
  // rows exist for every enrolled student and the review board is reachable.
  const [generation, setGeneration] = useState<GenerateAttendanceCandidatesResult | null>(null);
  const [rollCallBusy, setRollCallBusy] = useState(false);
  const [rollCallError, setRollCallError] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // -------------------------------------------------------------------------
  // Online/offline banner. Phase 4 explicitly defers offline support; the
  // banner is what makes the deferral honest — a network drop while
  // uploading a capture would otherwise look like a mysterious hang.
  //
  // useSyncExternalStore keeps the read/subscribe pair inside React's
  // concurrent-safe path, so we never call setState from inside an effect
  // just to mirror an ambient browser signal.
  // -------------------------------------------------------------------------
  const isOnline = useSyncExternalStore(
    subscribeToOnlineStatus,
    getOnlineSnapshot,
    getServerOnlineSnapshot,
  );

  // -------------------------------------------------------------------------
  // Camera lifecycle. Always stopped on unmount and whenever the wizard
  // leaves the camera step, so a captured session never leaves the tab with
  // the camera light on.
  //
  // teardownTracks() is side-effect-only (no React state) so that we can
  // call it from useEffect cleanups without tripping the
  // set-state-in-effect rule. The `cameraStatus` state is updated at every
  // *user-initiated* transition instead — which is when a status change is
  // actually meaningful to the UI.
  // -------------------------------------------------------------------------
  const teardownTracks = useCallback(() => {
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) track.stop();
      streamRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  const stopStream = useCallback(() => {
    teardownTracks();
    setCameraStatus("idle");
  }, [teardownTracks]);

  // Unmount cleanup — pure side-effect, no setState.
  useEffect(() => teardownTracks, [teardownTracks]);
  // Step-change cleanup — pure side-effect. `cameraStatus` is left as-is;
  // it will be reset the next time the user opens the camera.
  useEffect(() => {
    if (step !== "camera") teardownTracks();
  }, [step, teardownTracks]);

  const openCamera = useCallback(async () => {
    setCameraError(null);
    setCameraStatus("requesting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        // Rear camera preferred for a classroom capture; browsers ignore
        // `environment` gracefully on laptops and fall back to the built-in
        // webcam, which is the desired behaviour on demo hardware.
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setCameraStatus("streaming");
    } catch (e) {
      setCameraStatus("idle");
      setCameraError(humanCameraError(e));
    }
  }, []);

  // -------------------------------------------------------------------------
  // Step transitions
  // -------------------------------------------------------------------------
  const start = useCallback(async () => {
    setStartError(null);
    setStarting(true);
    try {
      const result = await startCaptureSession({ cohortId, cohortSubjectId });
      setStarted(result);
      setStep("camera");
    } catch (e) {
      setStartError(
        e instanceof Error
          ? `Could not start attendance: ${e.message}`
          : "Could not start attendance.",
      );
    } finally {
      setStarting(false);
    }
  }, [cohortId, cohortSubjectId]);

  // -------------------------------------------------------------------------
  // Capture / remove / retake
  // -------------------------------------------------------------------------
  const capture = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    const next = nextSequenceNumber(shots);
    if (next === null) return;
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (w === 0 || h === 0) return;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, w, h);
    // JPEG at 0.85 is a reasonable balance: enough detail for face
    // detection, small enough to keep the upload responsive.
    const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
    setShots((current) => [
      ...current,
      { sequenceNumber: next, dataUrl, imageBase64: stripDataUrlPrefix(dataUrl) },
    ]);
    // Move straight to review after a capture so faculty can see what they
    // just took; the review screen offers "Capture another" to come back.
    stopStream();
    setStep("review");
  }, [shots, stopStream]);

  const removeShot = useCallback((sequenceNumber: 1 | 2 | 3) => {
    setShots((current) => current.filter((s) => s.sequenceNumber !== sequenceNumber));
  }, []);

  const captureAnother = useCallback(() => {
    setStep("camera");
    void openCamera();
  }, [openCamera]);

  // -------------------------------------------------------------------------
  // Processing pipeline. Runs analyses in order 1 → 2 → 3, updating the
  // progress label between images so the UI never appears frozen. Failed
  // analyses are attached to their shot and the user can retake from the
  // review screen without losing the successful captures.
  // -------------------------------------------------------------------------
  const process = useCallback(async () => {
    if (!started) return;
    setStep("processing");
    setProcessingError(null);
    // Clear any prior run's advisory before reprocessing, so a retake can
    // never leave stale recognition counts on screen next to fresh captures.
    setRecognition(null);
    setRecognitionError(null);
    setRollCallError(null);
    const collected: CaptureImageAnalysis[] = [];
    for (let i = 0; i < shots.length; i++) {
      const shot = shots[i];
      setProcessingIndex(i);
      setProcessingStage(`Uploading image ${i + 1} of ${shots.length}`);
      try {
        setProcessingStage(`Analyzing image ${i + 1}: detecting faces`);
        const analysis = await analyzeCaptureImageAction({
          sessionId: started.session.id,
          sequenceNumber: shot.sequenceNumber,
          imageBase64: shot.imageBase64,
          acceptedSoFar: i,
        });
        if (!analysis.ok) {
          // Attach the failure to the shot rather than aborting; the review
          // screen will surface a per-shot retake affordance.
          setShots((current) =>
            current.map((s) =>
              s.sequenceNumber === shot.sequenceNumber
                ? { ...s, analysis: undefined, failure: { message: analysis.message, retryable: analysis.retryable } }
                : s,
            ),
          );
          setProcessingError(analysis.message);
          setStep("review");
          return;
        }
        const { ok: _ok, ...rest } = analysis;
        void _ok;
        collected.push(rest);
        setShots((current) =>
          current.map((s) =>
            s.sequenceNumber === shot.sequenceNumber ? { ...s, analysis: rest, failure: undefined } : s,
          ),
        );
        setProcessingStage(`Assessing capture quality for image ${i + 1}`);
      } catch (e) {
        setProcessingError(
          e instanceof Error ? `Processing failed: ${e.message}` : "Processing failed.",
        );
        setStep("review");
        return;
      }
    }
    // Recognition + attendance generation (Phases 5 and 6) in ONE server
    // call. The browser never posts recognition results back for storage:
    // a client that could do that could simply claim everyone was matched.
    // What gets written is what the server computed.
    //
    // A failure here is NOT fatal: the capture itself succeeded, and the
    // faculty member must still reach the summary and fall back to roll
    // call. The error is surfaced, never swallowed.
    setProcessingStage("Recognizing enrolled students");
    setRecognitionError(null);
    try {
      const result = await processSessionAttendanceAction({
        sessionId: started.session.id,
        images: shots.map((s) => ({
          sequenceNumber: s.sequenceNumber,
          imageBase64: s.imageBase64,
        })),
      });
      setRecognition(result.recognition);
      setGeneration(result.generation);
    } catch (e) {
      setRecognition(null);
      setGeneration(null);
      setRecognitionError(
        e instanceof Error
          ? `Recognition could not be completed: ${e.message}`
          : "Recognition could not be completed.",
      );
    }

    setProcessingStage("Combining results across images");
    try {
      const s = await summarizeCaptureSessionAction({
        sessionId: started.session.id,
        analyses: collected,
      });
      setProcessingStage("Preparing attendance review");
      setSummary(s);
      setStep("summary");
    } catch (e) {
      setProcessingError(
        e instanceof Error ? `Could not summarize the session: ${e.message}` : "Could not summarize the session.",
      );
      setStep("review");
    }
  }, [shots, started]);

  // -------------------------------------------------------------------------
  // Manual roll call — the fallback when recognition could not run.
  //
  // Builds the register from the enrolled roster with every student in Needs
  // Review. Nothing is presumed present or absent: the faculty member calls
  // the roll on the review screen. This is what keeps a recognition outage
  // from meaning "no attendance today".
  // -------------------------------------------------------------------------
  const openReview = useCallback(
    (sessionId: string) => {
      router.push(`/dashboard/attendance/${cohortId}/review/${sessionId}`);
    },
    [cohortId, router],
  );

  const startRollCall = useCallback(async () => {
    if (!started) return;
    setRollCallError(null);
    setRollCallBusy(true);
    try {
      await startManualRollCallAction({ sessionId: started.session.id });
      openReview(started.session.id);
    } catch (e) {
      setRollCallError(
        e instanceof Error
          ? `Could not open a roll call: ${e.message}`
          : "Could not open a roll call.",
      );
    } finally {
      setRollCallBusy(false);
    }
  }, [openReview, started]);

  // -------------------------------------------------------------------------
  // Discard
  // -------------------------------------------------------------------------
  const discard = useCallback(async () => {
    if (started) {
      try {
        await cancelCaptureSessionAction({ sessionId: started.session.id });
      } catch {
        // Best-effort. The UI navigates away either way — the server-side
        // session either transitioned to CANCELLED or was already terminal.
      }
    }
    stopStream();
    router.push(`/dashboard/attendance/${cohortId}`);
  }, [cohortId, router, started, stopStream]);

  // -------------------------------------------------------------------------
  // Derived state used across steps
  // -------------------------------------------------------------------------
  const captureLimitReached = shots.length >= MAX_CAPTURES_PER_SESSION;
  const hasAnyShot = shots.length > 0;
  const canProcess = hasAnyShot && !shots.some((s) => s.failure);
  const contextLabel = useMemo(() => {
    if (!started) return "";
    const bits: string[] = [];
    bits.push(started.cohortName);
    if (started.subjectName) bits.push(started.subjectName);
    bits.push(`${started.enrolledStudentCount} enrolled`);
    return bits.join(" · ");
  }, [started]);

  // -------------------------------------------------------------------------
  // Renderers
  // -------------------------------------------------------------------------

  const banner = !isOnline ? (
    <div
      role="alert"
      className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"
    >
      You appear to be offline. Uploads will resume when connectivity is
      restored — full offline capture is planned for a later release.
    </div>
  ) : null;

  if (step === "briefing") {
    return (
      <div className="flex flex-col gap-6">
        {banner}
        <section className="rounded-md border border-neutral-200 p-6">
          <h2 className="text-base font-semibold text-neutral-900">Before you capture</h2>
          <p className="mt-1 text-sm text-neutral-600">
            You can take up to {MAX_CAPTURES_PER_SESSION} photos. One is enough
            for a small class; add a second or third from another angle when
            students are obscured or the room is uneven.
          </p>
          <ul className="mt-3 flex flex-col gap-1.5 text-sm text-neutral-700">
            {CAPTURE_TIPS.map((tip) => (
              <li key={tip} className="flex gap-2">
                <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-neutral-400" aria-hidden />
                <span>{tip}</span>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-xs text-neutral-500">
            Classroom photos are processed and discarded — nothing is
            permanently stored on our servers by default. See your
            institution&apos;s privacy notice for details.
          </p>
        </section>

        <div className="flex items-center gap-3">
          <Button onClick={start} disabled={starting}>
            {starting ? "Starting…" : "Start attendance"}
          </Button>
          {attendanceMode === "SUBJECT_WISE" && !cohortSubjectId && (
            <span className="text-xs text-red-600">
              No subject selected — return to the class page and pick one first.
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

  if (step === "camera") {
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
          <video
            ref={videoRef}
            playsInline
            muted
            className="aspect-video w-full object-cover"
            aria-label="Classroom camera preview"
          />
          {cameraStatus !== "streaming" && (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-neutral-200">
              {cameraStatus === "requesting"
                ? "Requesting camera permission…"
                : "Camera not started"}
            </div>
          )}
          <canvas ref={canvasRef} className="hidden" />
        </div>

        {cameraError && (
          <p role="alert" className="text-sm text-red-600">
            {cameraError}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {cameraStatus !== "streaming" ? (
            <Button onClick={openCamera} disabled={cameraStatus === "requesting"}>
              {cameraStatus === "requesting" ? "Opening camera…" : "Open camera"}
            </Button>
          ) : (
            <Button onClick={capture} disabled={captureLimitReached}>
              {captureLimitReached
                ? "Capture limit reached"
                : `Capture photo ${shots.length + 1} of ${MAX_CAPTURES_PER_SESSION}`}
            </Button>
          )}
          {hasAnyShot && (
            <Button variant="secondary" onClick={() => setStep("review")}>
              Review {shots.length} photo{shots.length === 1 ? "" : "s"}
            </Button>
          )}
          <Button variant="secondary" onClick={discard}>
            Discard session
          </Button>
        </div>

        <p className="text-xs text-neutral-500">
          Reposition between shots so students obscured in one photo appear in
          another. You do not have to take three — one solid capture is
          usually enough for a small class.
        </p>
      </div>
    );
  }

  if (step === "review") {
    return (
      <div className="flex flex-col gap-4">
        {banner}
        <div className="flex items-baseline justify-between">
          <h2 className="text-base font-semibold text-neutral-900">Review captures</h2>
          <span className="text-xs text-neutral-500">
            {shots.length} of {MAX_CAPTURES_PER_SESSION} photos
          </span>
        </div>

        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {shots.map((s) => (
            <li
              key={s.sequenceNumber}
              className="flex flex-col gap-2 rounded-md border border-neutral-200 p-2"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={s.dataUrl}
                alt={`Capture ${s.sequenceNumber}`}
                className="aspect-video w-full rounded-sm object-cover"
              />
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-neutral-500">
                  Photo {s.sequenceNumber}
                </span>
                <span
                  className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${qualityBadgeClasses(s.analysis?.qualityLabel)}`}
                >
                  {qualityBadgeText(s.analysis?.qualityLabel)}
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
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  onClick={() => {
                    removeShot(s.sequenceNumber);
                    setStep("camera");
                    void openCamera();
                  }}
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
              Capture another photo
            </Button>
          )}
          <Button variant="secondary" onClick={discard}>
            Discard session
          </Button>
        </div>
        {!canProcess && (
          <p className="text-xs text-neutral-500">
            Retake or remove any photos that failed to upload before continuing.
          </p>
        )}
      </div>
    );
  }

  if (step === "processing") {
    const pct = shots.length === 0 ? 0 : Math.min(100, ((processingIndex + 1) / shots.length) * 100);
    return (
      <div className="flex flex-col gap-4">
        {banner}
        <h2 className="text-base font-semibold text-neutral-900">Processing captures</h2>
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(pct)}
          className="h-2 w-full overflow-hidden rounded-full bg-neutral-100"
        >
          <div
            className="h-full animate-pulse bg-neutral-900 transition-[width] duration-500 ease-out"
            style={{ width: `${pct}%` }}
          />
        </div>
        <p className="text-sm text-neutral-700">{processingStage}…</p>
        <ol className="ml-4 flex list-decimal flex-col gap-1 text-xs text-neutral-500">
          {PROCESSING_STAGES.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
        <p className="text-xs text-neutral-400">
          Do not close this tab. Analyses run one image at a time so the wizard
          can report which capture, if any, needs a retake.
        </p>
      </div>
    );
  }

  // step === "summary"
  //
  // Counts are derived, never stored: `perStudent` holds one deduplicated row
  // per student who was claimed by some face in some image, and
  // `unmatchedStudentIds` holds the rest of the class. A student appearing in
  // two photos is already collapsed to one row upstream.
  const perStudent = recognition?.perStudent ?? [];
  const presentCount = perStudent.filter((s) => s.advisoryResult === "PRESENT").length;
  const reviewCount = perStudent.filter((s) => s.advisoryResult === "NEEDS_REVIEW").length;
  const ambiguousCount = perStudent.filter((s) => s.wasAmbiguous).length;

  return (
    <div className="flex flex-col gap-4">
      {banner}
      <h2 className="text-base font-semibold text-neutral-900">Session ready for review</h2>

      {summary && !summary.productionEligible && (
        <div
          role="alert"
          className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900"
        >
          The recognition model currently loaded is <strong>not cleared for
          production use</strong> (backend: {summary.modelName} · {summary.modelVersion}).
          Face counts and any matches below are produced by that backend, so
          they describe the pipeline, not real identification. Use faculty
          roll-call to finalize.
        </div>
      )}

      {recognitionError && (
        <div
          role="alert"
          className="flex flex-col gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800"
        >
          <p>
            {recognitionError} The captures were still analyzed — face counts
            below are unaffected. No attendance has been recorded, and nobody
            has been marked absent as a result.
          </p>
          <p>
            You can still take attendance: a roll call opens the class list
            with every student awaiting your decision.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={startRollCall} disabled={rollCallBusy} className="!py-1 !text-xs">
              {rollCallBusy ? "Opening roll call…" : "Continue to manual roll call"}
            </Button>
          </div>
          {rollCallError && <p role="alert">{rollCallError}</p>}
        </div>
      )}

      {summary && (
        <dl className="grid grid-cols-2 gap-4 rounded-md border border-neutral-200 p-4 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs text-neutral-500">Photos captured</dt>
            <dd className="text-lg font-semibold text-neutral-900">{summary.captureCount}</dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-500">Faces detected</dt>
            <dd className="text-lg font-semibold text-neutral-900">{summary.totalFacesDetected}</dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-500">Enrolled students</dt>
            <dd className="text-lg font-semibold text-neutral-900">{summary.enrolledStudentCount}</dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-500">Model</dt>
            <dd className="truncate text-sm text-neutral-700" title={`${summary.modelName} · ${summary.modelVersion}`}>
              {summary.modelName}
            </dd>
          </div>
        </dl>
      )}

      {recognition && (
        <section className="flex flex-col gap-3 rounded-md border border-neutral-200 p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-sm font-semibold text-neutral-900">
              Recognition advisory
            </h3>
            <span className="text-xs text-neutral-500">
              {recognition.scoredFacesTotal} of {recognition.detectedFacesTotal} detected
              faces scored against {recognition.candidatePoolSize} enrolled students in
              this class
            </span>
          </div>

          <dl className="grid grid-cols-3 gap-4 text-sm">
            <div>
              <dt className="text-xs text-neutral-500">Suggested present</dt>
              <dd className="text-lg font-semibold text-emerald-700">
                {presentCount}
              </dd>
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
              too close to another enrolled student to separate confidently, and{" "}
              {ambiguousCount === 1 ? "was" : "were"} routed to review rather than
              marked present.
            </p>
          )}

          {recognition.skippedIncompatibleCandidates > 0 && (
            <p className="text-xs text-neutral-600">
              {recognition.skippedIncompatibleCandidates} enrolled{" "}
              {recognition.skippedIncompatibleCandidates === 1 ? "student" : "students"}{" "}
              could not be compared because their stored face data was captured with a
              different model version. They are not evidence of absence and must be
              re-enrolled or marked by roll-call.
            </p>
          )}

          <p className="rounded-md bg-neutral-50 px-3 py-2 text-xs text-neutral-700">
            <strong>Advisory only — attendance is not finalized.</strong> These
            results have been written to the register as a starting point, but
            nothing counts until a faculty member confirms it. An uncertain
            match is never silently promoted to present.
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
            . Every one of them is accounted for — nobody was dropped for having
            no usable face data.
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
        The captures have been analyzed. Captured images are not stored, so a
        retake later would need to be done live.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        {generation ? (
          <Button onClick={() => started && openReview(started.session.id)}>
            Review and confirm attendance
          </Button>
        ) : (
          <Button onClick={() => router.push(`/dashboard/attendance/${cohortId}`)}>
            Back to class
          </Button>
        )}
        {generation && (
          <Button
            variant="secondary"
            onClick={() => router.push(`/dashboard/attendance/${cohortId}`)}
          >
            Back to class
          </Button>
        )}
        <Button variant="secondary" onClick={discard}>
          Discard session
        </Button>
      </div>
    </div>
  );
}
