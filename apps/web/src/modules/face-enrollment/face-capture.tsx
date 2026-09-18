"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { FaceEnrollmentResult } from "./types";

type Status = "idle" | "requesting" | "streaming" | "captured" | "submitting" | "error";

interface Props {
  /**
   * Server-side submission handler. Receives ONLY the captured base64 image
   * (no metadata). Returns the enrollment result — this component never
   * sees an embedding.
   */
  onSubmit: (imageBase64: string) => Promise<FaceEnrollmentResult>;
  submitLabel?: string;
  helpText?: string;
}

/**
 * Camera + capture + submit primitive. Deliberately DOES NOT persist the
 * captured image anywhere (no localStorage, no upload beyond the enrollment
 * Server Action). Once submitted, the captured blob is discarded so the raw
 * image doesn't linger on the client.
 */
export function FaceCapture({ onSubmit, submitLabel = "Enroll face", helpText }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [result, setResult] = useState<FaceEnrollmentResult | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const stopStream = useCallback(() => {
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) track.stop();
      streamRef.current = null;
    }
  }, []);

  useEffect(() => stopStream, [stopStream]);

  const start = useCallback(async () => {
    setErrorMessage(null);
    setResult(null);
    setStatus("requesting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setStatus("streaming");
    } catch (e) {
      setStatus("error");
      setErrorMessage(
        e instanceof Error
          ? `Camera permission was denied or the camera is unavailable: ${e.message}`
          : "Could not open the camera.",
      );
    }
  }, []);

  const capture = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    const w = video.videoWidth;
    const h = video.videoHeight;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, w, h);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
    setPreviewUrl(dataUrl);
    setStatus("captured");
    stopStream();
  }, [stopStream]);

  const retry = useCallback(() => {
    setPreviewUrl(null);
    setResult(null);
    setStatus("idle");
    void start();
  }, [start]);

  const submit = useCallback(async () => {
    if (!previewUrl) return;
    setStatus("submitting");
    setErrorMessage(null);
    // Strip the "data:image/jpeg;base64," prefix — the server contract
    // wants raw base64 bytes (see EnrollRequest.imageBase64).
    const base64 = previewUrl.split(",", 2)[1] ?? "";
    try {
      const r = await onSubmit(base64);
      setResult(r);
      setStatus(r.ok ? "captured" : "captured");
    } catch (e) {
      setStatus("error");
      setErrorMessage(e instanceof Error ? e.message : "Submission failed.");
    }
  }, [onSubmit, previewUrl]);

  return (
    <div className="flex flex-col gap-3">
      {helpText && <p className="text-xs text-neutral-500">{helpText}</p>}

      <div className="flex flex-col gap-2">
        <div className="relative w-full max-w-md overflow-hidden rounded-md border border-neutral-200 bg-neutral-50">
          {previewUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={previewUrl} alt="Captured face" className="w-full" />
          ) : (
            <video ref={videoRef} playsInline muted className="w-full" />
          )}
        </div>
        <canvas ref={canvasRef} className="hidden" />
      </div>

      <div className="flex gap-2">
        {status === "idle" && <Button onClick={start}>Start camera</Button>}
        {status === "requesting" && <Button disabled>Requesting camera…</Button>}
        {status === "streaming" && <Button onClick={capture}>Capture</Button>}
        {status === "captured" && (
          <>
            <Button onClick={submit} disabled={!!result?.ok}>
              {result?.ok ? "Enrolled ✓" : submitLabel}
            </Button>
            <Button onClick={retry} type="button">
              Retake
            </Button>
          </>
        )}
        {status === "submitting" && <Button disabled>Submitting…</Button>}
        {status === "error" && <Button onClick={retry}>Try again</Button>}
      </div>

      {errorMessage && (
        <p role="alert" className="text-sm text-red-600">
          {errorMessage}
        </p>
      )}

      {result && (
        <p
          role={result.ok ? "status" : "alert"}
          className={result.ok ? "text-sm text-green-700" : "text-sm text-red-600"}
        >
          {result.message}
        </p>
      )}
    </div>
  );
}
