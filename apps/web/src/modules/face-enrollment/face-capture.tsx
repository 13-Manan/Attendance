"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/use-confirm";
import type { FaceEnrollmentStatusSummary } from "./policy";
import {
  CAPTURE_JPEG_QUALITY,
  cameraIsAvailable,
  captureDimensions,
  describeCameraError,
  inspectImageInBrowser,
  stripDataUrlPrefix,
} from "./capture-support";
import type { FaceCaptureSource, FaceEnrollmentResult } from "./types";

/**
 * Capture a face, look at it, and decide whether to send it.
 *
 * ## Two ways in, one way out
 *
 * The camera is the intended path and the upload is not a lesser fallback — a
 * shared classroom tablet with a broken camera, a locked-down browser, a
 * desktop with no webcam and a student photograph already on file are all
 * ordinary situations, and in every one of them the alternative to an upload
 * is no enrollment at all. Both paths converge on the same review step and the
 * same submission, so nothing downstream has to care which was used. The
 * server records which it was, because provenance is worth having when
 * somebody later asks how a particular template got there.
 *
 * ## The review step is not decoration
 *
 * A still is held and shown before anything is sent. The model is about to
 * turn this image into a biometric template, and the person holding the camera
 * is the only one who can see that the frame caught a blink, the wrong
 * student, or two faces. Sending on capture would make every one of those a
 * round trip and a rejection message instead of a glance.
 *
 * ## What this component never holds
 *
 * An embedding — it is never sent one. And no image after it has been
 * submitted: the captured bytes are cleared from state on success, nothing is
 * written to `localStorage`, and the only copy that ever existed outside this
 * component's memory is the request body.
 */

type Stage =
  | { name: "choosing" }
  | { name: "startingCamera" }
  | { name: "streaming" }
  | { name: "review"; imageBase64: string; previewUrl: string; source: FaceCaptureSource }
  | { name: "submitting"; previewUrl: string };

export interface FaceCaptureProps {
  /** Adds one more sample. */
  onSubmit: (image: {
    imageBase64: string;
    captureSource: FaceCaptureSource;
  }) => Promise<FaceEnrollmentResult>;
  /**
   * Retires every stored sample and stores this one instead. Staff only —
   * omitted on the student portal, where being able to retire your own
   * templates would be a way to make yourself unrecognisable before a class.
   */
  onReplace?: (image: {
    imageBase64: string;
    captureSource: FaceCaptureSource;
  }) => Promise<FaceEnrollmentResult>;
  /** The subject's enrollment status as of the last server render. */
  initialStatus: FaceEnrollmentStatusSummary;
  /** Changes the second person: a member of staff captures someone else. */
  subject: "student" | "self";
  /**
   * Set when enrollment cannot proceed at all — the institution does not allow
   * self-enrollment, say. The component renders the reason instead of a camera
   * rather than letting somebody take a photograph that will be refused.
   */
  unavailableReason?: string | null;
}

const ACCEPTED_FILE_TYPES = "image/jpeg,image/png,image/webp";

export function FaceCapture({
  onSubmit,
  onReplace,
  initialStatus,
  subject,
  unavailableReason = null,
}: FaceCaptureProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [stage, setStage] = useState<Stage>({ name: "choosing" });
  const [status, setStatus] = useState(initialStatus);
  const [result, setResult] = useState<FaceEnrollmentResult | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [replaceMode, setReplaceMode] = useState(false);

  /**
   * Whether to offer the camera at all.
   *
   * `navigator` does not exist while this component is server-rendered, so
   * reading it during render would return false on the server and true in the
   * browser — a hydration mismatch on the primary control of the page.
   * `useSyncExternalStore` is the tool for exactly this: a value that lives
   * outside React, with a server snapshot that is allowed to differ from the
   * client one. The subscribe function is a no-op because the answer cannot
   * change while the page is open — a device does not grow a camera.
   */
  const cameraOffered = useSyncExternalStore(
    () => () => {},
    cameraIsAvailable,
    () => false,
  );

  const canReplace = onReplace !== undefined && status.usableSamples + status.staleSamples > 0;
  const [confirmingReplace, setConfirmingReplace] = useConfirm(canReplace && replaceMode);

  const atCapacity = status.remainingSlots === 0;
  const them = subject === "self" ? "you" : "the student";

  // -- camera lifecycle -----------------------------------------------------

  const stopStream = useCallback(() => {
    if (!streamRef.current) return;
    for (const track of streamRef.current.getTracks()) track.stop();
    streamRef.current = null;
    // Detaching matters as well as stopping: a paused <video> holding a dead
    // MediaStream keeps the camera indicator lit in some browsers, which is
    // alarming on a page about biometrics.
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  useEffect(() => stopStream, [stopStream]);

  const startCamera = useCallback(async () => {
    setCameraError(null);
    setFileError(null);
    setResult(null);
    setStage({ name: "startingCamera" });

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) {
        // The element went away while permission was being granted — a
        // navigation, almost certainly. Release the camera rather than leaving
        // it on behind a page nobody is looking at.
        stopStream();
        setStage({ name: "choosing" });
        return;
      }
      video.srcObject = stream;
      await video.play();
      setStage({ name: "streaming" });
    } catch (error) {
      stopStream();
      setCameraError(describeCameraError(error));
      setStage({ name: "choosing" });
    }
  }, [stopStream]);

  // -- capture --------------------------------------------------------------

  const capture = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;

    const { width, height } = captureDimensions(video.videoWidth, video.videoHeight);
    if (width === 0 || height === 0) {
      setCameraError("The camera has not produced a frame yet. Give it a moment and try again.");
      return;
    }

    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) {
      setCameraError("This browser could not read a frame from the camera. Upload a photograph instead.");
      return;
    }

    // Drawn unmirrored, deliberately. The live preview is flipped in CSS
    // because an unmirrored self-view is disorienting, but the *bytes* must
    // not be: a recognition model's alignment step works from left and right
    // eye positions, and handing it a mirrored face means every template is
    // built from a different geometry than the one the camera will see at
    // attendance time.
    context.drawImage(video, 0, 0, width, height);

    const dataUrl = canvas.toDataURL("image/jpeg", CAPTURE_JPEG_QUALITY);
    const base64 = stripDataUrlPrefix(dataUrl);
    if (!base64) {
      setCameraError("The captured frame could not be encoded. Try again, or upload a photograph.");
      return;
    }

    stopStream();
    setStage({ name: "review", imageBase64: base64, previewUrl: dataUrl, source: "CAMERA" });
  }, [stopStream]);

  // -- upload ---------------------------------------------------------------

  const onFileChosen = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Reset immediately so choosing the same file twice still fires a change
    // event — otherwise a user who fixes a photo and re-picks it sees nothing
    // happen.
    event.target.value = "";
    if (!file) return;

    setFileError(null);
    setCameraError(null);
    setResult(null);

    const reader = new FileReader();
    reader.onerror = () => {
      setFileError("That file could not be read. Try a different one.");
    };
    reader.onload = () => {
      const dataUrl = typeof reader.result === "string" ? reader.result : "";
      const base64 = stripDataUrlPrefix(dataUrl);
      if (!base64) {
        setFileError("That file could not be read as an image.");
        return;
      }
      const inspection = inspectImageInBrowser(base64);
      if (!inspection.ok) {
        // Checked here so somebody who picked a PDF finds out now. The server
        // checks the same thing again and is the authority; this is only to
        // save a round trip and give a clearer message.
        setFileError(inspection.message);
        return;
      }
      setStage({ name: "review", imageBase64: base64, previewUrl: dataUrl, source: "UPLOAD" });
    };
    reader.readAsDataURL(file);
  }, []);

  // -- submission -----------------------------------------------------------

  const send = useCallback(
    async (mode: "add" | "replace") => {
      if (stage.name !== "review") return;
      const payload = { imageBase64: stage.imageBase64, captureSource: stage.source };
      const previewUrl = stage.previewUrl;

      setStage({ name: "submitting", previewUrl });
      setCameraError(null);
      setFileError(null);

      const held: Stage = {
        name: "review",
        imageBase64: stage.imageBase64,
        previewUrl,
        source: stage.source,
      };

      try {
        const handler = mode === "replace" && onReplace ? onReplace : onSubmit;
        const outcome = await handler(payload);
        setResult(outcome);
        setStatus(outcome.status);
        setConfirmingReplace(false);

        if (outcome.ok) {
          // The image has served its purpose. Dropping it here means a page
          // left open on a shared classroom device is not also a page holding
          // a photograph of a child.
          setReplaceMode(false);
          setStage({ name: "choosing" });
        } else if (outcome.retryable) {
          // Keep the still on screen: the reason is about this photograph, and
          // being able to look at it while reading "the face is too small" is
          // the whole point of showing it.
          setStage(held);
        } else {
          // A refusal no retake can fix — the slot limit, a collision with
          // another student, a policy. Holding the photograph would invite one.
          setStage({ name: "choosing" });
        }
      } catch {
        setResult(null);
        setCameraError(
          "The enrollment could not be submitted. Check the connection and try again.",
        );
        setStage(held);
      }
    },
    [onReplace, onSubmit, setConfirmingReplace, stage],
  );

  const discard = useCallback(() => {
    setResult(null);
    setCameraError(null);
    setFileError(null);
    setStage({ name: "choosing" });
  }, []);

  // -- render ---------------------------------------------------------------

  if (unavailableReason) {
    return (
      <div className="rounded-md border border-neutral-200 bg-neutral-50 px-4 py-3">
        <p className="text-sm text-neutral-700">{unavailableReason}</p>
      </div>
    );
  }

  const showCameraTile = stage.name === "startingCamera" || stage.name === "streaming";
  const previewUrl =
    stage.name === "review" || stage.name === "submitting" ? stage.previewUrl : null;

  return (
    <div className="flex flex-col gap-4">
      <SlotSummary status={status} subject={subject} />

      <div className="flex flex-col gap-3">
        <div className="relative w-full max-w-md overflow-hidden rounded-lg border border-neutral-200 bg-neutral-900/5">
          {/* The video element stays mounted across stages rather than being
              conditionally rendered: `getUserMedia` resolves into a ref, and a
              ref that points at an element React has just unmounted is how a
              camera ends up running with nothing to draw it. */}
          <video
            ref={videoRef}
            playsInline
            muted
            aria-label={`Live camera preview of ${them}`}
            className={`w-full -scale-x-100 ${showCameraTile ? "block" : "hidden"}`}
          />
          {previewUrl ? (
            /* A data URL held in memory for the length of one review step.
               next/image optimises assets served from a URL and has nothing to
               do here; it would also mean handing a photograph of a student to
               an image pipeline, which is the opposite of what this page is
               for. */
            // eslint-disable-next-line @next/next/no-img-element
            <img src={previewUrl} alt={`Captured photograph of ${them}`} className="w-full" />
          ) : null}
          {!showCameraTile && !previewUrl ? (
            <div className="flex aspect-[4/3] items-center justify-center px-6 text-center">
              <p className="text-sm text-neutral-500">
                {atCapacity
                  ? `${subject === "self" ? "You have" : "This student has"} the maximum number of samples.`
                  : "Start the camera, or choose a photograph."}
              </p>
            </div>
          ) : null}
        </div>
        <canvas ref={canvasRef} className="hidden" />

        <Controls
          stage={stage}
          cameraOffered={cameraOffered}
          atCapacity={atCapacity}
          canReplace={canReplace}
          replaceMode={replaceMode}
          confirmingReplace={confirmingReplace}
          setConfirmingReplace={setConfirmingReplace}
          setReplaceMode={setReplaceMode}
          onStartCamera={startCamera}
          onCapture={capture}
          onChooseFile={() => fileInputRef.current?.click()}
          onSend={send}
          onDiscard={discard}
          subject={subject}
        />

        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPTED_FILE_TYPES}
          onChange={onFileChosen}
          className="sr-only"
          // Labelled for the accessibility tree even though it is driven by a
          // button: a screen-reader user who reaches it by other means should
          // still be told what it takes.
          aria-label="Choose a photograph to upload"
          tabIndex={-1}
        />
      </div>

      <Guidance subject={subject} />

      <div aria-live="polite" className="flex flex-col gap-2 empty:hidden">
        {cameraError ? <Message tone="error">{cameraError}</Message> : null}
        {fileError ? <Message tone="error">{fileError}</Message> : null}
        {result ? (
          <Message tone={result.ok ? "success" : "error"}>{result.message}</Message>
        ) : null}
        {result?.ok && status.remainingSlots > 0 ? (
          <p className="text-xs text-neutral-500">
            {status.remainingSlots} more sample{status.remainingSlots === 1 ? "" : "s"} can be
            added. Several photographs in different light recognise {them} more reliably than one.
          </p>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function SlotSummary({
  status,
  subject,
}: {
  status: FaceEnrollmentStatusSummary;
  subject: "student" | "self";
}) {
  const stored = status.usableSamples + status.staleSamples;
  const owner = subject === "self" ? "You have" : "This student has";

  return (
    <div className="flex flex-col gap-1 rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2">
      <p className="text-sm text-neutral-700">
        {stored === 0
          ? `${owner} no face samples yet.`
          : `${owner} ${stored} face sample${stored === 1 ? "" : "s"}, ${status.remainingSlots} slot${status.remainingSlots === 1 ? "" : "s"} free.`}
      </p>
      {status.staleSamples > 0 ? (
        <p className="text-xs text-amber-800">
          {status.staleSamples} of them {status.staleSamples === 1 ? "was" : "were"} made by a model
          this deployment no longer runs, so {status.staleSamples === 1 ? "it is" : "they are"}{" "}
          never compared against a classroom photograph. Enrol again to replace{" "}
          {status.staleSamples === 1 ? "it" : "them"}.
        </p>
      ) : null}
      {status.modelUnknown && stored > 0 ? (
        <p className="text-xs text-neutral-500">
          The face service could not be reached, so whether these samples match the running model is
          not known.
        </p>
      ) : null}
    </div>
  );
}

interface ControlsProps {
  stage: Stage;
  cameraOffered: boolean;
  atCapacity: boolean;
  canReplace: boolean;
  replaceMode: boolean;
  confirmingReplace: boolean;
  setConfirmingReplace: (next: boolean) => void;
  setReplaceMode: (next: boolean) => void;
  onStartCamera: () => void;
  onCapture: () => void;
  onChooseFile: () => void;
  onSend: (mode: "add" | "replace") => void;
  onDiscard: () => void;
  subject: "student" | "self";
}

function Controls({
  stage,
  cameraOffered,
  atCapacity,
  canReplace,
  replaceMode,
  confirmingReplace,
  setConfirmingReplace,
  setReplaceMode,
  onStartCamera,
  onCapture,
  onChooseFile,
  onSend,
  onDiscard,
  subject,
}: ControlsProps) {
  // At capacity, adding is impossible and replacing is the only thing that can
  // move the situation on — so that is what the buttons offer, rather than an
  // enabled "capture" that leads to a refusal.
  const mustReplace = atCapacity && canReplace;
  const mode: "add" | "replace" = replaceMode || mustReplace ? "replace" : "add";

  if (stage.name === "startingCamera") {
    return (
      <div className="flex flex-wrap gap-2">
        <Button disabled>Starting camera…</Button>
      </div>
    );
  }

  if (stage.name === "streaming") {
    return (
      <div className="flex flex-wrap gap-2">
        <Button onClick={onCapture}>Take the photograph</Button>
        <Button type="button" variant="secondary" onClick={onDiscard}>
          Cancel
        </Button>
      </div>
    );
  }

  if (stage.name === "submitting") {
    return (
      <div className="flex flex-wrap gap-2">
        <Button disabled>{mode === "replace" ? "Replacing…" : "Enrolling…"}</Button>
      </div>
    );
  }

  if (stage.name === "review") {
    if (mode === "replace" && confirmingReplace) {
      return (
        <div className="flex flex-col items-start gap-2">
          <p className="max-w-md text-xs text-neutral-600">
            Every face sample {subject === "self" ? "you have" : "this student has"} is retired and
            this photograph becomes the only one. Attendance from now on depends on it alone. The
            retired samples are kept in the history and stop being used for recognition immediately.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="danger" onClick={() => onSend("replace")}>
              Replace all samples
            </Button>
            <Button type="button" variant="secondary" onClick={() => setConfirmingReplace(false)}>
              Cancel
            </Button>
          </div>
        </div>
      );
    }

    return (
      <div className="flex flex-wrap gap-2">
        {mode === "replace" ? (
          <Button type="button" variant="danger" onClick={() => setConfirmingReplace(true)}>
            Replace all samples with this
          </Button>
        ) : (
          <Button onClick={() => onSend("add")}>Use this photograph</Button>
        )}
        <Button type="button" variant="secondary" onClick={onStartCamera}>
          Retake
        </Button>
        <Button type="button" variant="secondary" onClick={onChooseFile}>
          Choose another file
        </Button>
        <Button type="button" variant="secondary" onClick={onDiscard}>
          Discard
        </Button>
      </div>
    );
  }

  // stage.name === "choosing"
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {cameraOffered ? (
          <Button onClick={onStartCamera} disabled={atCapacity && !canReplace}>
            Use the camera
          </Button>
        ) : null}
        <Button
          type="button"
          variant="secondary"
          onClick={onChooseFile}
          disabled={atCapacity && !canReplace}
        >
          Choose a photograph
        </Button>
      </div>

      {canReplace && !atCapacity ? (
        <label className="flex items-center gap-2 text-xs text-neutral-600">
          <input
            type="checkbox"
            checked={replaceMode}
            onChange={(event) => {
              setReplaceMode(event.target.checked);
              setConfirmingReplace(false);
            }}
            className="h-4 w-4 rounded border-neutral-300"
          />
          Replace the existing samples instead of adding to them
        </label>
      ) : null}
    </div>
  );
}

function Guidance({ subject }: { subject: "student" | "self" }) {
  const self = subject === "self";
  return (
    <ul className="flex list-disc flex-col gap-1 pl-5 text-xs text-neutral-500">
      <li>
        {self ? "Face the camera straight on" : "Ask the student to face the camera straight on"}, in
        even light, with nothing covering the face.
      </li>
      <li>Only one face may be in the frame — a second person in the background is rejected.</li>
      <li>
        Fill a good part of the frame. A face from across a room is too small for the model to use.
      </li>
      <li>The photograph itself is never stored. Only the template the model derives from it is.</li>
    </ul>
  );
}

function Message({ tone, children }: { tone: "success" | "error"; children: React.ReactNode }) {
  const className =
    tone === "success"
      ? "rounded-md bg-green-50 px-3 py-2 text-sm text-green-800"
      : "rounded-md bg-red-50 px-3 py-2 text-sm text-red-700";
  return (
    <p role={tone === "success" ? "status" : "alert"} className={className}>
      {children}
    </p>
  );
}
