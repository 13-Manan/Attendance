import { z } from "zod";

// Validated once at module load so misconfiguration fails fast at boot
// rather than surfacing as an obscure runtime error deep in a request.
const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  FACE_AI_SERVICE_URL: z.string().url(),
  AUTH_SECRET: z.string().min(1),
  API_KEY_PEPPER: z.string().min(1),
  /**
   * Whether this deployment runs on the institution's own network.
   *
   * Opt-in, and default off, because the question it answers is one no code
   * can infer: "will the AI still be reachable when the internet is not?" A
   * stack running on a server in the school building answers yes; the same
   * image on a cloud host answers no, and both look identical from inside the
   * process. Setting this on a cloud deployment would make the app tell
   * teachers that offline recognition works when it cannot — the exact claim
   * the offline design forbids.
   *
   * When off, offline attendance still works in full. It is taken by hand,
   * and the UI says so.
   */
  LOCAL_AI_ENABLED: z
    .string()
    .optional()
    .transform((value) => value === "true" || value === "1"),
  /**
   * Shared secret sent to the face-AI service as `Authorization: Bearer …`.
   *
   * Optional here, and required there — the asymmetry is deliberate. This app
   * must keep starting in a development checkout whose face service has no
   * token configured (see services/face-ai/app/auth.py for why that mode
   * exists and why it warns). Any deployment holding real faces sets this and
   * `FACE_AI_REQUIRE_AUTH` on the service, after which the service refuses
   * anonymous callers and a mismatch fails loudly at the first capture rather
   * than silently downgrading to an open endpoint.
   *
   * Never reaches a browser: it is read only by `lib/face-ai-client.ts`, which
   * runs server-side, and it is not prefixed `NEXT_PUBLIC_`.
   */
  FACE_AI_SERVICE_TOKEN: z.string().min(1).optional(),
});

export const env = envSchema.parse({
  DATABASE_URL: process.env.DATABASE_URL,
  FACE_AI_SERVICE_URL: process.env.FACE_AI_SERVICE_URL,
  AUTH_SECRET: process.env.AUTH_SECRET,
  API_KEY_PEPPER: process.env.API_KEY_PEPPER,
  LOCAL_AI_ENABLED: process.env.LOCAL_AI_ENABLED,
  // Empty string reads as "not configured" rather than as a one-character
  // secret: `FACE_AI_SERVICE_TOKEN=` in a .env file is how people disable a
  // variable, and `z.string().min(1)` would otherwise turn that into a boot
  // failure nobody expects.
  FACE_AI_SERVICE_TOKEN: process.env.FACE_AI_SERVICE_TOKEN || undefined,
});
