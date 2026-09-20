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
  /**
   * Where rate-limit counters live. `postgres` (the default) shares them
   * across replicas; `memory` keeps the pre-Phase-15 per-process behaviour.
   *
   * Defaulting to the shared implementation is the point: this app is
   * configured for `maxReplicas: 5`, so a deployment that forgot to set this
   * would be the one silently running five separate limiters. `memory` stays
   * available because a single-process developer checkout has no reason to
   * write a row per request, and because a deployment terminating rate limits
   * at its gateway may want this one out of the way.
   *
   * Needs no credential of its own — it uses `DATABASE_URL`.
   */
  RATE_LIMIT_BACKEND: z
    .enum(["postgres", "memory"])
    .optional()
    .transform((value) => value ?? "postgres"),
  /**
   * Where realtime events are carried. `postgres` (the default) uses
   * `LISTEN`/`NOTIFY` so an event published by one replica reaches subscribers
   * on every other; `memory` is the single-process `EventEmitter` from
   * ADR-0004, which is correct only when exactly one instance is running.
   *
   * Also uses `DATABASE_URL`; there is no separate transport credential, and
   * deliberately nothing here is `NEXT_PUBLIC_`.
   */
  REALTIME_BACKEND: z
    .enum(["postgres", "memory"])
    .optional()
    .transform((value) => value ?? "postgres"),
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
  // Same empty-string reasoning as above: an unset or blank variable means
  // "use the default", not "fail to boot".
  RATE_LIMIT_BACKEND: process.env.RATE_LIMIT_BACKEND || undefined,
  REALTIME_BACKEND: process.env.REALTIME_BACKEND || undefined,
});
