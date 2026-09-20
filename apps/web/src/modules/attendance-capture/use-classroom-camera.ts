"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  INITIAL_CAMERA_STATE,
  cameraReducer,
  describeCameraFailure,
  type CameraDevice,
  type CameraState,
  type CaptureFrameResult,
} from "./camera";
import { resolveCameraSource, type CameraSource, type OpenCameraResult } from "./camera-source";

/**
 * The camera, as React sees it.
 *
 * Holds three things the pure state machine cannot: the live stream handle,
 * the `<video>` element it renders into, and the effects that guarantee the
 * stream is released. Everything else — what state the camera is in, what a
 * failure means, how big a frame may be — lives in `camera.ts` and is tested
 * without a browser.
 *
 * ## The lifecycle guarantees
 *
 * A classroom device is shared, and a page that leaves the camera running is a
 * page quietly filming a room of children. So the stream is stopped:
 *
 *   - when the component unmounts,
 *   - when the tab is hidden (switched away, screen locked, phone pocketed),
 *   - when `stop()` is called by the wizard leaving the camera step,
 *   - and when an `open()` resolves after the user already asked to stop,
 *     which is the race a slow permission prompt creates.
 *
 * The last one is why `generationRef` exists: `getUserMedia` can take as long
 * as the person takes to click "Allow", and by then the answer may no longer
 * be wanted.
 */

export interface ClassroomCamera {
  state: CameraState;
  /** Attach to the `<video>` element that shows the preview. */
  videoRef: React.RefObject<HTMLVideoElement | null>;
  /** Cameras to choose between. Empty until a stream has run at least once —
   * browsers withhold device labels from an un-permitted page. */
  devices: CameraDevice[];
  activeDeviceId: string | null;
  start: (deviceId?: string) => Promise<void>;
  stop: () => void;
  /** Encodes the current preview frame. Returns a failure rather than
   * throwing, because every failure here has something to tell the user. */
  capture: () => CaptureFrameResult;
  switchDevice: (deviceId: string) => Promise<void>;
}

export interface UseClassroomCameraOptions {
  /**
   * Swap the hardware for a fixture. Production never passes this; the capture
   * page passes it only when the development-only fixture flag is set.
   */
  source?: CameraSource;
  /** Stop the stream when the tab is hidden. On by default. */
  releaseWhenHidden?: boolean;
}

export function useClassroomCamera(options: UseClassroomCameraOptions = {}): ClassroomCamera {
  const [state, dispatch] = useReducer(cameraReducer, INITIAL_CAMERA_STATE);
  const [devices, setDevices] = useState<CameraDevice[]>([]);
  const [activeDeviceId, setActiveDeviceId] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<OpenCameraResult | null>(null);
  /**
   * Bumped by every stop and every new start. An `open()` that resolves with a
   * stale generation belongs to a request nobody is waiting for any more, and
   * its stream is released rather than shown.
   */
  const generationRef = useRef(0);
  /** True between `start()` being called and its promise settling. Guards the
   * async half; the reducer guards the state half. */
  const openingRef = useRef(false);

  // The source is resolved once. Re-resolving on every render would hand a new
  // object to the effects below and restart the camera on unrelated updates.
  const source = useMemo(
    () => options.source ?? resolveCameraSource(false),
    [options.source],
  );

  // -------------------------------------------------------------------------
  // Availability
  // -------------------------------------------------------------------------

  useEffect(() => {
    // Read in an effect rather than during render: `navigator` does not exist
    // on the server, so reading it while rendering would produce a different
    // answer there than in the browser — a hydration mismatch on the primary
    // control of the page.
    if (!source.isAvailable()) dispatch({ type: "unsupported" });
  }, [source]);

  // -------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------

  /** Side-effect only: releases hardware without touching React state, so it
   * is safe to call from an effect cleanup. */
  const release = useCallback(() => {
    generationRef.current += 1;
    streamRef.current?.stop();
    streamRef.current = null;
  }, []);

  const stop = useCallback(() => {
    release();
    dispatch({ type: "stop" });
  }, [release]);

  // Unmount. Deliberately `release` and not `stop` — dispatching into an
  // unmounted reducer is pointless, and the hardware is the part that matters.
  useEffect(() => release, [release]);

  // Tab visibility. A teacher who switches apps mid-capture should not leave a
  // camera running behind a page they cannot see.
  useEffect(() => {
    if (options.releaseWhenHidden === false) return;
    if (typeof document === "undefined") return;
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") stop();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [options.releaseWhenHidden, stop]);

  // -------------------------------------------------------------------------
  // Start / switch
  // -------------------------------------------------------------------------

  const start = useCallback(
    async (deviceId?: string) => {
      if (openingRef.current) return;
      if (!source.isAvailable()) {
        dispatch({ type: "unsupported" });
        return;
      }

      // Any stream already running is released first. Switching cameras
      // without this leaves the previous device held open.
      release();
      const generation = generationRef.current;
      openingRef.current = true;
      dispatch({ type: "start" });

      try {
        const stream = await source.open({
          facingMode: "environment",
          deviceId,
          videoSink: videoRef.current,
        });

        if (generation !== generationRef.current) {
          // Stopped, unmounted, or restarted while the permission prompt was
          // on screen. The stream is real and must be given back.
          stream.stop();
          return;
        }

        streamRef.current = stream;
        setActiveDeviceId(stream.deviceId);
        dispatch({
          type: "started",
          deviceId: stream.deviceId,
          deviceLabel: stream.deviceLabel,
        });

        // Only worth asking once a stream exists: before permission is
        // granted, every device label is the empty string.
        void source
          .listVideoDevices()
          .then((found) => {
            if (generation === generationRef.current) setDevices(found);
          })
          .catch(() => {
            // A device list is a convenience. Failing to get one must never
            // interfere with a camera that is already working.
          });
      } catch (error) {
        if (generation !== generationRef.current) return;
        dispatch({ type: "fail", failure: describeCameraFailure(error) });
      } finally {
        openingRef.current = false;
      }
    },
    [release, source],
  );

  const switchDevice = useCallback(
    async (deviceId: string) => {
      await start(deviceId);
    },
    [start],
  );

  // -------------------------------------------------------------------------
  // Capture
  // -------------------------------------------------------------------------

  const capture = useCallback((): CaptureFrameResult => {
    const stream = streamRef.current;
    if (!stream) {
      return {
        ok: false,
        problem: "no_frame",
        message: "The camera is not running. Start it and try again.",
      };
    }
    dispatch({ type: "capture" });
    try {
      return stream.grabFrame();
    } finally {
      // Back to ready whatever happened — a failed encode must not leave the
      // shutter disabled with no way back.
      dispatch({ type: "captured" });
    }
  }, []);

  return { state, videoRef, devices, activeDeviceId, start, stop, capture, switchDevice };
}
