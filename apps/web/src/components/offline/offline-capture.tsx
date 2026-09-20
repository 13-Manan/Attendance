"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { countImages, putImage, type LocalSession } from "@/lib/offline/db";
import { localAiMessage, probeLocalAi } from "@/lib/offline/local-ai";
import { finalizeLocalSession, markStudent } from "@/lib/offline/store";
import type { LocalAiProbeResult } from "@/modules/offline-sync/types";
import { useSync } from "./sync-provider";

/**
 * Taking a register with no network.
 *
 * ## This is not a degraded mode
 *
 * The same four steps as the online wizard — open the class, capture, review,
 * finalize — with the same rules about what a result may be. The only
 * difference is where the answer is written: IndexedDB now, the server later.
 * Nothing here is disabled, greyed out, or labelled "limited".
 *
 * ## Where it is deliberately stricter than the online flow
 *
 * **Finalize refuses while any student is unmarked.** Online, the register is
 * seeded from recognition and the review board resolves what is left; offline
 * there is no seed, so an unmarked row means nobody looked at that student. The
 * server would refuse to finalize such a register anyway, and queueing one it
 * will refuse is a silent loss wearing a sync badge. So the check happens here,
 * in front of the person who can fix it, while they are still in the room.
 *
 * There is no "mark everyone present" button, for the same reason there is not
 * one online: an absent student who is recorded present by a bulk action is the
 * failure this whole system exists to prevent.
 *
 * ## About the photographs
 *
 * Captured to IndexedDB as `Blob`s, shown back as the teacher's own evidence,
 * and **not uploaded by the sync engine**. Offline recognition is either
 * available on the institution's own network or it is not; shipping classroom
 * photographs of children to a server hours later, from a device that has since
 * left the building, is not something to do quietly as a side effect of a sync.
 * See docs/OFFLINE_SYNC.md.
 */

const MAX_OFFLINE_CAPTURES = 3;

type Step = "capture" | "mark" | "review" | "queued";

export function OfflineCapture({
  localSessionId,
  onDone,
}: {
  localSessionId: string;
  onDone: () => void;
}) {
  const sync = useSync();
  const [step, setStep] = useState<Step>("capture");
  const [imageCount, setImageCount] = useState(0);
  const [localAi, setLocalAi] = useState<LocalAiProbeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The register itself lives in the offline store, so every mark is written to
  // IndexedDB first and read back from it — the screen can never show a mark
  // that was not durably saved.
  const session: LocalSession | null =
    sync?.offline.sessions.find((s) => s.id === localSessionId) ?? null;

  useEffect(() => {
    void countImages(localSessionId).then(setImageCount);
  }, [localSessionId]);

  // Probed once when the screen opens, and never cached across screens: a
  // node that answered in the staff room says nothing about this classroom.
  useEffect(() => {
    void probeLocalAi().then(setLocalAi);
  }, []);

  const setMark = useCallback(
    async (studentId: string, result: "PRESENT" | "ABSENT") => {
      await markStudent(localSessionId, studentId, result);
    },
    [localSessionId],
  );

  const finalize = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await finalizeLocalSession(localSessionId, imageCount);
      setStep("queued");
    } catch {
      // The register is still in IndexedDB — only the queue write failed, and
      // it can be retried. Said explicitly so nobody re-takes the roster.
      setError(
        "Could not add this register to the sync queue. It is still saved on this device — try Finalize again.",
      );
    } finally {
      setBusy(false);
    }
  }, [localSessionId, imageCount]);

  if (!session) {
    return <p className="text-sm text-neutral-500">Loading this register…</p>;
  }

  const marked = Object.keys(session.marks).length;
  const unmarked = session.students.filter((s) => !session.marks[s.studentId]);
  const present = Object.values(session.marks).filter((m) => m.result === "PRESENT").length;
  const absent = marked - present;

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h2 className="text-base font-semibold text-neutral-900">
          {session.cohortName}
          {session.subjectName ? ` · ${session.subjectName}` : ""}
        </h2>
        <p className="text-xs text-neutral-500">
          {new Date(session.sessionDate).toLocaleDateString(undefined, {
            year: "numeric",
            month: "short",
            day: "numeric",
          })}{" "}
          · {session.students.length} students · saved on this device
        </p>
      </header>

      <LocalAiNotice result={localAi} />

      {step === "capture" ? (
        <CaptureStep
          localSessionId={localSessionId}
          imageCount={imageCount}
          onCaptured={(count) => setImageCount(count)}
          onContinue={() => setStep("mark")}
        />
      ) : null}

      {step === "mark" ? (
        <MarkStep
          session={session}
          onMark={setMark}
          onBack={() => setStep("capture")}
          onContinue={() => setStep("review")}
        />
      ) : null}

      {step === "review" ? (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-3 gap-2 text-center">
            <Stat label="Present" value={present} />
            <Stat label="Absent" value={absent} />
            <Stat label="Unmarked" value={unmarked.length} />
          </div>

          {unmarked.length > 0 ? (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              <p className="font-medium">
                {unmarked.length} student{unmarked.length === 1 ? "" : "s"} still unmarked.
              </p>
              <p className="mt-1 text-xs">
                A register cannot be finalized with an undecided student — an unanswered
                row must never become Present by omission. Go back and mark{" "}
                {unmarked
                  .slice(0, 4)
                  .map((s) => s.fullName)
                  .join(", ")}
                {unmarked.length > 4 ? `, and ${unmarked.length - 4} more` : ""}.
              </p>
            </div>
          ) : (
            <p className="rounded-md border border-neutral-200 bg-neutral-50 p-3 text-xs text-neutral-600">
              Finalizing saves this register on the device and queues it. It will sync
              automatically when the connection returns — you do not need to keep this page
              open, and you do not need to stay signed in on this screen.
            </p>
          )}

          {error ? (
            <p role="alert" className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900">
              {error}
            </p>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => setStep("mark")} disabled={busy}>
              Back to roster
            </Button>
            <Button onClick={() => void finalize()} disabled={busy || unmarked.length > 0}>
              {busy ? "Saving…" : "Finalize on this device"}
            </Button>
          </div>
        </div>
      ) : null}

      {step === "queued" ? (
        <div className="flex flex-col gap-3">
          <div className="rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900">
            <p className="font-medium">Register finalized and saved on this device.</p>
            <p className="mt-1 text-xs">
              {present} present, {absent} absent. It is queued and will sync on its own.
              You can close the app.
            </p>
          </div>
          <Button variant="secondary" onClick={onDone}>
            Done
          </Button>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-neutral-200 px-3 py-2">
      <p className="text-lg font-semibold text-neutral-900">{value}</p>
      <p className="text-xs text-neutral-500">{label}</p>
    </div>
  );
}

/**
 * States the local-AI probe honestly, in a sentence, on the screen where it
 * matters. Never a spinner that resolves to silence.
 */
function LocalAiNotice({ result }: { result: LocalAiProbeResult | null }) {
  const available = result?.status === "AVAILABLE";
  return (
    <p
      className={`rounded-md border px-3 py-2 text-xs ${
        available
          ? "border-emerald-300 bg-emerald-50 text-emerald-900"
          : "border-neutral-300 bg-neutral-50 text-neutral-600"
      }`}
    >
      {localAiMessage(result)}
      {available ? null : (
        <>
          {" "}
          Photos are still saved on this device as your own record.
        </>
      )}
    </p>
  );
}

// ---------------------------------------------------------------------------

function CaptureStep({
  localSessionId,
  imageCount,
  onCaptured,
  onContinue,
}: {
  localSessionId: string;
  imageCount: number;
  onCaptured: (count: number) => void;
  onContinue: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setStreaming(false);
  }, []);

  // Releasing the camera on unmount is not tidiness — a tablet with a live
  // MediaStream held by a hidden component keeps its recording indicator on,
  // in a classroom, which is exactly the wrong signal to give a room of
  // students.
  useEffect(() => stop, [stop]);

  const start = useCallback(async () => {
    setCameraError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setStreaming(true);
    } catch {
      setCameraError(
        "The camera is unavailable. You can still take this register by marking the roster.",
      );
    }
  }, []);

  const capture = useCallback(async () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || imageCount >= MAX_OFFLINE_CAPTURES) return;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
    // A Blob rather than a data URL: IndexedDB stores it natively, and
    // base64 would inflate a 1 MB photo to 1.4 MB of string on a device whose
    // storage quota is the thing standing between a teacher and a lost
    // register.
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.85),
    );
    if (!blob) return;
    await putImage({
      id: crypto.randomUUID(),
      localSessionId,
      sequenceNumber: imageCount + 1,
      blob,
      capturedAt: new Date().toISOString(),
    });
    onCaptured(await countImages(localSessionId));
  }, [imageCount, localSessionId, onCaptured]);

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-hidden rounded-md border border-neutral-200 bg-neutral-900">
        <video ref={videoRef} playsInline muted className="aspect-video w-full object-cover" />
        <canvas ref={canvasRef} className="hidden" />
      </div>

      {cameraError ? (
        <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
          {cameraError}
        </p>
      ) : null}

      <p className="text-xs text-neutral-500">
        {imageCount} of {MAX_OFFLINE_CAPTURES} photos captured. Photos stay on this device.
      </p>

      <div className="flex flex-wrap gap-2">
        {streaming ? (
          <>
            <Button onClick={() => void capture()} disabled={imageCount >= MAX_OFFLINE_CAPTURES}>
              Capture photo
            </Button>
            <Button variant="secondary" onClick={stop}>
              Stop camera
            </Button>
          </>
        ) : (
          <Button variant="secondary" onClick={() => void start()}>
            Open camera
          </Button>
        )}
        {/* Always enabled. Capturing is optional — the register is the point,
            and a teacher whose camera will not open must not be blocked. */}
        <Button
          onClick={() => {
            stop();
            onContinue();
          }}
        >
          {imageCount > 0 ? "Continue to roster" : "Skip photos, mark roster"}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function MarkStep({
  session,
  onMark,
  onBack,
  onContinue,
}: {
  session: LocalSession;
  onMark: (studentId: string, result: "PRESENT" | "ABSENT") => Promise<void>;
  onBack: () => void;
  onContinue: () => void;
}) {
  const marked = Object.keys(session.marks).length;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-neutral-500">
        {marked} of {session.students.length} marked. Every student needs an answer.
      </p>

      <ul className="flex flex-col divide-y divide-neutral-100 rounded-md border border-neutral-200">
        {session.students.map((student) => {
          const mark = session.marks[student.studentId];
          return (
            <li
              key={student.studentId}
              className="flex items-center justify-between gap-3 px-3 py-2"
            >
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-sm text-neutral-900">{student.fullName}</span>
                {student.rollNumber ? (
                  <span className="text-xs text-neutral-500">{student.rollNumber}</span>
                ) : null}
              </div>
              <div className="flex shrink-0 gap-1" role="group" aria-label={`Mark ${student.fullName}`}>
                <MarkButton
                  active={mark?.result === "PRESENT"}
                  activeClass="border-emerald-400 bg-emerald-50 text-emerald-900"
                  onClick={() => void onMark(student.studentId, "PRESENT")}
                >
                  Present
                </MarkButton>
                <MarkButton
                  active={mark?.result === "ABSENT"}
                  activeClass="border-red-400 bg-red-50 text-red-900"
                  onClick={() => void onMark(student.studentId, "ABSENT")}
                >
                  Absent
                </MarkButton>
              </div>
            </li>
          );
        })}
      </ul>

      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={onBack}>
          Back to photos
        </Button>
        <Button onClick={onContinue}>Review</Button>
      </div>
    </div>
  );
}

/**
 * The two buttons a teacher actually presses, forty times in a row.
 *
 * Sized for a finger rather than a cursor: `min-h-11` is ~44px, the smallest
 * target most accessibility guidance accepts for touch. They were 30px, which
 * is fine on a laptop and wrong on the device this screen exists for — a
 * phone or tablet held in one hand at the front of a classroom, where a
 * mis-tap marks the wrong student and nothing on screen says so.
 *
 * The label stays small; only the hit area grows.
 */
function MarkButton({
  active,
  activeClass,
  onClick,
  children,
}: {
  active: boolean;
  activeClass: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`min-h-11 min-w-16 rounded-md border px-3 text-xs font-medium transition-colors sm:min-h-9 ${
        active ? activeClass : "border-neutral-300 bg-white text-neutral-600 hover:bg-neutral-50"
      }`}
    >
      {children}
    </button>
  );
}
