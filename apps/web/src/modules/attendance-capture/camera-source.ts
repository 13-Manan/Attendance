import {
  CLASSROOM_JPEG_QUALITY,
  MAX_CLASSROOM_CAPTURE_EDGE,
  classroomCaptureDimensions,
  inspectCapturedFrame,
  type CameraDevice,
  type CaptureFrameResult,
} from "./camera";

/**
 * The one place this application touches camera hardware.
 *
 * ## The seam, and why it is here
 *
 * `browserCameraSource` is the production implementation and it calls
 * `navigator.mediaDevices.getUserMedia` exactly as it always did. Nothing
 * about the real capture path is replaced, weakened, or routed around — the
 * teacher's browser opens the teacher's camera.
 *
 * What the interface buys is that everything *around* the hardware can be
 * exercised without any: the wizard's state transitions, the failure messages,
 * the lifecycle guarantees, the payload bounds. A webcam cannot be summoned in
 * CI, and "a human confirmed it once" does not survive a refactor.
 *
 * `fixtureCameraSource` exists for tests and for driving the flow in a browser
 * that has no camera attached. It is never reachable from production code:
 * `resolveCameraSource` only returns it when explicitly asked, and the only
 * caller that asks is gated on a development-only flag.
 */

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

/**
 * The slice of `HTMLVideoElement` the capture path actually uses.
 *
 * Narrow on purpose: a test satisfies it with an object literal, and it
 * documents precisely how much DOM the camera code depends on.
 */
export interface VideoSink {
  /**
   * `MediaProvider` rather than `MediaStream` so a real `HTMLVideoElement`
   * satisfies this interface — the DOM declares the wider union, and narrowing
   * it here would make the production element unassignable to the very type
   * that exists to describe it.
   */
  srcObject: MediaProvider | null;
  readonly videoWidth: number;
  readonly videoHeight: number;
  play(): Promise<void>;
}

export interface OpenCameraRequest {
  /**
   * Rear camera by preference — a classroom capture points away from the
   * person holding the device. Expressed as `ideal` rather than `exact` so a
   * laptop, which has only a front camera, still opens one instead of failing
   * the constraint.
   */
  facingMode: "environment" | "user";
  /** Set when the user has picked a specific camera from the device list. */
  deviceId?: string;
  /** Where to render the preview. */
  videoSink: VideoSink | null;
}

export interface OpenCameraResult {
  deviceId: string | null;
  deviceLabel: string | null;
  /** Encodes the current preview frame. Never returns raw hardware handles. */
  grabFrame(): CaptureFrameResult;
  /** Releases every track and detaches the preview. Safe to call twice. */
  stop(): void;
}

export interface CameraSource {
  isAvailable(): boolean;
  /**
   * Cameras this device offers, for the "switch camera" control.
   *
   * Labels are empty until permission has been granted at least once — a
   * browser will not tell an un-permitted page what hardware exists. The UI
   * therefore only offers the switcher once a stream is running.
   */
  listVideoDevices(): Promise<CameraDevice[]>;
  open(request: OpenCameraRequest): Promise<OpenCameraResult>;
}

// ---------------------------------------------------------------------------
// Production: real hardware
// ---------------------------------------------------------------------------

/** Decodes a short base64 prefix using the browser's `atob`. */
function decodePrefixInBrowser(base64: string): Uint8Array | null {
  try {
    const binary = atob(base64.slice(0, 16));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

export function browserCameraSource(): CameraSource {
  return {
    isAvailable() {
      // `mediaDevices` is absent on an insecure origin as well as on a browser
      // without the API, which covers both reasons the button should not be
      // offered rather than offered and then failing.
      return (
        typeof navigator !== "undefined" &&
        typeof navigator.mediaDevices?.getUserMedia === "function"
      );
    },

    async listVideoDevices() {
      if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) {
        return [];
      }
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        return devices
          .filter((d) => d.kind === "videoinput")
          .map((d, index) => ({
            deviceId: d.deviceId,
            // Before permission is granted every label is "". Numbering them
            // at least lets somebody pick the second one.
            label: d.label || `Camera ${index + 1}`,
          }));
      } catch {
        // Device enumeration is a convenience. Failing it must never stop a
        // capture that is otherwise working.
        return [];
      }
    },

    async open(request) {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: request.deviceId
          ? { deviceId: { exact: request.deviceId } }
          : {
              facingMode: { ideal: request.facingMode },
              width: { ideal: MAX_CLASSROOM_CAPTURE_EDGE },
              height: { ideal: 1080 },
            },
        audio: false,
      });

      const track = stream.getVideoTracks()[0] ?? null;
      const settings = track?.getSettings?.() ?? {};

      const sink = request.videoSink;
      if (sink) {
        sink.srcObject = stream;
        try {
          await sink.play();
        } catch {
          // Autoplay can be refused even for a muted, user-gesture-initiated
          // stream on some mobile browsers. The stream is live either way and
          // `grabFrame` reads from the element regardless of playback state,
          // so this is not worth failing the whole capture over.
        }
      }

      let stopped = false;
      const stop = () => {
        if (stopped) return;
        stopped = true;
        for (const t of stream.getTracks()) t.stop();
        // Detaching matters as well as stopping: a paused <video> still
        // holding a dead MediaStream keeps the camera indicator lit in some
        // browsers, which is alarming on a page pointed at a room of children.
        if (sink) sink.srcObject = null;
      };

      return {
        deviceId: settings.deviceId ?? request.deviceId ?? null,
        deviceLabel: track?.label || null,
        stop,
        grabFrame() {
          if (!sink) {
            return { ok: false, problem: "no_frame", message: "No camera preview is attached." };
          }
          const { width, height } = classroomCaptureDimensions(
            sink.videoWidth,
            sink.videoHeight,
          );
          if (width === 0 || height === 0) {
            return {
              ok: false,
              problem: "no_frame",
              message:
                "The camera has not produced a frame yet. Give it a second and press capture again.",
            };
          }

          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const context = canvas.getContext("2d");
          if (!context) {
            return {
              ok: false,
              problem: "encoder_unavailable",
              message:
                "This browser could not read a frame from the camera. Try a different browser or device.",
            };
          }
          // Drawn unmirrored on purpose. A front-facing preview is flipped in
          // CSS because an unmirrored self-view is disorienting, but the bytes
          // must not be: alignment works from left and right eye positions, and
          // a mirrored classroom photograph is a different geometry from the
          // one every enrolled template was built in.
          context.drawImage(sink as unknown as CanvasImageSource, 0, 0, width, height);

          const result = inspectCapturedFrame(
            canvas.toDataURL("image/jpeg", CLASSROOM_JPEG_QUALITY),
            decodePrefixInBrowser,
          );
          return result.ok ? { ...result, width, height } : result;
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Fixture: deterministic, no hardware
// ---------------------------------------------------------------------------

/**
 * A 2×2 JPEG. Small, real, and enough to satisfy every check on both sides of
 * the wire: the magic bytes are a genuine SOI marker, so `detectImageFormat`
 * and the server's `inspectImageBase64` both accept it.
 *
 * Padded at the point of use to clear `MIN_IMAGE_BASE64_CHARS` — the padding is
 * appended base64, not image data, which is exactly the "valid header, junk
 * tail" shape a decoder must tolerate.
 */
const FIXTURE_JPEG_BASE64 =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
  "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAACAAIBAREA/8QAHwAAAQUBAQEB" +
  "AQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1Fh" +
  "ByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZ" +
  "WmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXG" +
  "x8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/APn+v//Z";

export interface FixtureCameraOptions {
  /** Force `open` to reject, so a test can drive the failure states. */
  failWith?: Error;
  /** Make `isAvailable` false, for the "camera unsupported" state. */
  unavailable?: boolean;
  devices?: CameraDevice[];
  /** Reported preview dimensions, so capture geometry can be exercised. */
  frameSize?: { width: number; height: number };
  /** Overrides the encoded payload — used to drive frame-rejection paths. */
  imageBase64?: string;
}

export interface FixtureCameraSource extends CameraSource {
  /**
   * How many streams this source has opened and not had stopped.
   *
   * The lifecycle assertion the real camera cannot make: a leaked stream is
   * invisible in production until somebody notices the camera light is still
   * on, but shows up here as a count that never returns to zero.
   */
  openStreamCount(): number;
}

/**
 * A camera that produces the same bytes every time.
 *
 * Used by the unit tests, and by the browser-verification path where the
 * machine driving Chrome has no webcam. It is *not* a stand-in for a real
 * camera test: it proves the wizard, the contracts and the server behave, and
 * says nothing at all about whether a lens ever opened.
 */
export function fixtureCameraSource(
  options: FixtureCameraOptions = {},
): FixtureCameraSource {
  const devices = options.devices ?? [
    { deviceId: "fixture-rear", label: "Fixture rear camera" },
    { deviceId: "fixture-front", label: "Fixture front camera" },
  ];
  const size = options.frameSize ?? { width: 1280, height: 720 };
  let openStreams = 0;

  return {
    isAvailable: () => !options.unavailable,
    listVideoDevices: async () => devices,
    async open(request) {
      if (options.failWith) throw options.failWith;
      openStreams += 1;
      // Mirrors the real source's contract closely enough to be worth
      // asserting on: a leaked stream shows up here as a count that never
      // returns to zero.
      const chosen =
        devices.find((d) => d.deviceId === request.deviceId) ?? devices[0] ?? null;
      let stopped = false;
      return {
        deviceId: chosen?.deviceId ?? null,
        deviceLabel: chosen?.label ?? null,
        stop() {
          if (stopped) return;
          stopped = true;
          openStreams -= 1;
          if (request.videoSink) request.videoSink.srcObject = null;
        },
        grabFrame(): CaptureFrameResult {
          const { width, height } = classroomCaptureDimensions(size.width, size.height);
          if (width === 0 || height === 0) {
            return {
              ok: false,
              problem: "no_frame",
              message:
                "The camera has not produced a frame yet. Give it a second and press capture again.",
            };
          }
          const payload = options.imageBase64 ?? fixtureFrameBase64();
          return {
            ok: true,
            imageBase64: payload,
            dataUrl: `data:image/jpeg;base64,${payload}`,
            width,
            height,
            approximateBytes: Math.floor((payload.length * 3) / 4),
          };
        },
      };
    },
    openStreamCount: () => openStreams,
  };
}

/** The fixture payload, padded past the server's minimum length. */
export function fixtureFrameBase64(): string {
  const padding = "A".repeat(Math.max(0, 512 - FIXTURE_JPEG_BASE64.length));
  return FIXTURE_JPEG_BASE64 + padding;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * Which source the wizard uses.
 *
 * Production always gets the real one. The fixture is reachable only when the
 * caller passes `useFixture`, and the only caller that does is gated on
 * `NEXT_PUBLIC_ENABLE_FIXTURE_CAMERA`, which is unset in every deployed
 * environment (see `apps/web/src/lib/env.ts` and the deploy workflow). The
 * check is here, in one function, rather than at each call site, so "can a
 * production browser reach the fixture?" has a single answer.
 */
export function resolveCameraSource(useFixture = false): CameraSource {
  return useFixture ? fixtureCameraSource() : browserCameraSource();
}
