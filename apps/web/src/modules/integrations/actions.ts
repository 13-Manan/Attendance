"use server";

/**
 * Server Actions for the Integration Center.
 *
 * This file is a boundary, not a place where decisions are made. Every export
 * does the same four things and nothing else: resolve the session user, parse
 * the untrusted input, hand off to `center-service`, and turn whatever comes
 * back into something a form can render. Authorization, tenancy and audit all
 * live in the service, which is what lets the same rules apply to a request
 * that arrives as an API call instead of a button press.
 *
 * Two conventions worth stating because they are easy to get wrong here:
 *
 * - **`refresh()` after every mutation.** In this version of Next a Server
 *   Action's response only carries a re-rendered tree when the action
 *   revalidates, refreshes, sets a cookie or redirects. The Integration Center
 *   keeps the admin on the page — pausing a connection or running a sync does
 *   not navigate — so without `refresh()` the button would work and the status
 *   column would keep showing the old value until a manual reload.
 * - **Errors become form state, not exceptions.** An `IntegrationCenterError`
 *   carries a sentence written for an administrator. Anything else is a bug or
 *   a driver message, and is replaced with a generic line rather than rendered.
 */

import { z } from "zod";
import { refresh } from "next/cache";
import { requireUser } from "@/modules/auth-tenancy/session";
import { ForbiddenError } from "@/modules/authorization/types";
import {
  IntegrationCenterError,
  commitImport,
  createConnection,
  deleteConnection,
  previewImport,
  runSync,
  saveFieldMappings,
  setConnectionStatus,
  testConnection,
  updateConnection,
} from "./center-service";
import type { ImportPreviewResult } from "./center-service";
import type { FieldMapping } from "./types";
import type { SyncRunResult } from "./sync";

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/** Every form on the page returns this shape, so one banner component renders them all. */
export interface ActionState {
  error?: string;
  message?: string;
}

/**
 * Turns a thrown value into a sentence.
 *
 * `IntegrationCenterError` messages are written to be read by the person who
 * configured the integration, so they pass through verbatim. A `ForbiddenError`
 * gets a fixed line — telling someone precisely which permission they lack is
 * a small disclosure about how the institution is configured, and they cannot
 * act on it anyway. Everything else is deliberately flattened: a Prisma error
 * names tables and columns, and an upstream fetch failure can echo a URL with
 * a token in the query string.
 */
function describe(error: unknown, fallback: string): ActionState {
  if (error instanceof IntegrationCenterError) return { error: error.message };
  if (error instanceof ForbiddenError) return { error: "You do not have access to manage integrations." };
  return { error: fallback };
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

const mappingSchema = z.object({
  source: z.string().min(1).max(200),
  target: z.string().min(1).max(200),
  fallback: z.string().max(200).optional(),
});

/**
 * Header rows arrive as two parallel arrays because that is what an HTML form
 * of repeated `<input>` pairs produces. Zipping them here keeps the shape out
 * of the service, which takes a record.
 */
function readHeaders(formData: FormData): Record<string, string> {
  const names = formData.getAll("headerName").map(String);
  const values = formData.getAll("headerValue").map(String);
  const headers: Record<string, string> = {};
  for (let i = 0; i < names.length; i += 1) {
    const name = names[i]?.trim();
    if (!name) continue;
    headers[name] = values[i] ?? "";
  }
  return headers;
}

function readNumber(value: FormDataEntryValue | null): number | null {
  if (value === null || String(value).trim() === "") return null;
  const parsed = Number(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

const createSchema = z.object({
  name: z.string().min(1, "Give this integration a name.").max(120),
  kind: z.string().min(1),
  syncMode: z.string().min(1),
  baseUrl: z.string().max(2000).optional(),
  testPath: z.string().max(500).optional(),
  deliveryUrl: z.string().max(2000).optional(),
  delimiter: z.string().max(4).optional(),
});

export async function createConnectionAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireUser();
  const parsed = createSchema.safeParse({
    name: formData.get("name"),
    kind: formData.get("kind"),
    syncMode: formData.get("syncMode"),
    baseUrl: formData.get("baseUrl") ?? undefined,
    testPath: formData.get("testPath") ?? undefined,
    deliveryUrl: formData.get("deliveryUrl") ?? undefined,
    delimiter: formData.get("delimiter") ?? undefined,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check the form and try again." };
  }

  const headers = readHeaders(formData);
  try {
    await createConnection(actor, {
      name: parsed.data.name,
      kind: parsed.data.kind,
      resources: formData.getAll("resources").map(String),
      syncMode: parsed.data.syncMode,
      intervalMinutes: readNumber(formData.get("intervalMinutes")),
      config: {
        baseUrl: parsed.data.baseUrl?.trim() || undefined,
        testPath: parsed.data.testPath?.trim() || undefined,
        deliveryUrl: parsed.data.deliveryUrl?.trim() || undefined,
        delimiter: parsed.data.delimiter?.trim() || undefined,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      },
    });
  } catch (error) {
    return describe(error, "That integration could not be created.");
  }

  refresh();
  return { message: "Integration added. Test the connection before turning it on." };
}

const updateSchema = createSchema.extend({
  connectionId: z.string().min(1),
  name: z.string().min(1).max(120).optional(),
  kind: z.string().optional(),
  syncMode: z.string().optional(),
});

export async function updateConnectionAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireUser();
  const parsed = updateSchema.safeParse({
    connectionId: formData.get("connectionId"),
    name: formData.get("name") ?? undefined,
    syncMode: formData.get("syncMode") ?? undefined,
    baseUrl: formData.get("baseUrl") ?? undefined,
    testPath: formData.get("testPath") ?? undefined,
    deliveryUrl: formData.get("deliveryUrl") ?? undefined,
    delimiter: formData.get("delimiter") ?? undefined,
  });
  if (!parsed.success) return { error: "Check the form and try again." };

  const headers = readHeaders(formData);
  try {
    await updateConnection(actor, {
      connectionId: parsed.data.connectionId,
      name: parsed.data.name,
      resources: formData.getAll("resources").map(String),
      syncMode: parsed.data.syncMode,
      intervalMinutes: readNumber(formData.get("intervalMinutes")),
      // A header submitted blank means "leave the stored value alone" — the
      // form could not render the secret, so it cannot echo it back.
      // `removeHeaders` is how the admin says "actually, delete it".
      removeHeaders: formData.getAll("removeHeader").map(String),
      config: {
        baseUrl: parsed.data.baseUrl?.trim() || undefined,
        testPath: parsed.data.testPath?.trim() || undefined,
        deliveryUrl: parsed.data.deliveryUrl?.trim() || undefined,
        delimiter: parsed.data.delimiter?.trim() || undefined,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      },
    });
  } catch (error) {
    return describe(error, "Those changes could not be saved.");
  }

  refresh();
  return { message: "Saved." };
}

export async function setConnectionStatusAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireUser();
  const connectionId = String(formData.get("connectionId") ?? "");
  const status = String(formData.get("status") ?? "");
  if (status !== "ACTIVE" && status !== "PAUSED") return { error: "Unknown status." };

  try {
    await setConnectionStatus(actor, connectionId, status);
  } catch (error) {
    return describe(error, "That integration could not be updated.");
  }

  refresh();
  return { message: status === "PAUSED" ? "Integration paused." : "Integration resumed." };
}

export async function deleteConnectionAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireUser();
  try {
    await deleteConnection(actor, String(formData.get("connectionId") ?? ""));
  } catch (error) {
    return describe(error, "That integration could not be removed.");
  }

  refresh();
  return { message: "Integration removed. Students it imported are untouched." };
}

// ---------------------------------------------------------------------------
// Field mapping
// ---------------------------------------------------------------------------

export async function saveFieldMappingsAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireUser();
  const sources = formData.getAll("mappingSource").map(String);
  const targets = formData.getAll("mappingTarget").map(String);
  const fallbacks = formData.getAll("mappingFallback").map(String);

  const mappings: FieldMapping[] = [];
  for (let i = 0; i < targets.length; i += 1) {
    const target = targets[i]?.trim();
    const source = sources[i]?.trim();
    // A row with neither half filled in is an empty row the admin added and
    // did not use, not an error to report back at them.
    if (!target || !source) continue;
    const fallback = fallbacks[i]?.trim();
    mappings.push({ source, target, ...(fallback ? { fallback } : {}) });
  }

  const parsed = z.array(mappingSchema).safeParse(mappings);
  if (!parsed.success) return { error: "Check the mapping rows and try again." };

  try {
    await saveFieldMappings(actor, {
      connectionId: String(formData.get("connectionId") ?? ""),
      resource: String(formData.get("resource") ?? "students"),
      mappings: parsed.data,
    });
  } catch (error) {
    return describe(error, "That field mapping could not be saved.");
  }

  refresh();
  return { message: "Field mapping saved." };
}

// ---------------------------------------------------------------------------
// Test and sync
// ---------------------------------------------------------------------------

export async function testConnectionAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireUser();
  let result;
  try {
    result = await testConnection(actor, String(formData.get("connectionId") ?? ""));
  } catch (error) {
    return describe(error, "That connection could not be tested.");
  }

  refresh();
  // A failed test is a successful action — the admin asked a question and got
  // an answer. It renders as an error because that is the answer.
  return result.ok ? { message: result.message } : { error: result.message };
}

export interface SyncActionState extends ActionState {
  run?: SyncRunResult;
}

export async function runSyncAction(
  _prev: SyncActionState,
  formData: FormData,
): Promise<SyncActionState> {
  const actor = await requireUser();
  let run: SyncRunResult;
  try {
    run = await runSync(actor, {
      connectionId: String(formData.get("connectionId") ?? ""),
      trigger: "manual",
      force: formData.get("force") === "on",
    });
  } catch (error) {
    return describe(error, "That sync could not be started.");
  }

  refresh();
  const summary = describeRunForForm(run);
  return run.status === "FAILED" ? { error: summary, run } : { message: summary, run };
}

function describeRunForForm(run: SyncRunResult): string {
  if (run.status === "SKIPPED") return run.reason ?? "Nothing to sync.";
  const totals = run.resources.reduce(
    (acc, resource) => ({
      created: acc.created + resource.created,
      updated: acc.updated + resource.updated,
      unchanged: acc.unchanged + resource.unchanged,
      errors: acc.errors + resource.errors,
    }),
    { created: 0, updated: 0, unchanged: 0, errors: 0 },
  );
  const parts = [
    `${totals.created} created`,
    `${totals.updated} updated`,
    `${totals.unchanged} unchanged`,
  ];
  // Failures are named even when the run is reported as a success, so a
  // partial sync can never read as a clean one.
  if (totals.errors > 0) parts.push(`${totals.errors} failed`);
  return `${run.status === "PARTIAL" ? "Sync finished with errors" : "Sync complete"}: ${parts.join(", ")}.`;
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/**
 * Reads the uploaded file off the form.
 *
 * The size ceiling is enforced before the bytes are parsed, not after: a 400 MB
 * upload should be refused on the strength of its `size` field, rather than
 * read into a string first to find out how big it was.
 */
async function readUpload(formData: FormData): Promise<{ bytes: Buffer; filename: string } | ActionState> {
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "Choose a CSV or Excel file to upload." };
  if (file.size > MAX_UPLOAD_BYTES) {
    return { error: `That file is larger than ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB. Split it and import in parts.` };
  }
  return { bytes: Buffer.from(await file.arrayBuffer()), filename: file.name };
}

function isActionState(value: unknown): value is ActionState {
  return typeof value === "object" && value !== null && !("bytes" in value);
}

export interface PreviewActionState extends ActionState {
  preview?: ImportPreviewResult;
}

export async function previewImportAction(
  _prev: PreviewActionState,
  formData: FormData,
): Promise<PreviewActionState> {
  const actor = await requireUser();
  const upload = await readUpload(formData);
  if (isActionState(upload)) return upload;

  try {
    const preview = await previewImport(actor, {
      bytes: upload.bytes,
      filename: upload.filename,
      resource: String(formData.get("resource") ?? "students"),
      delimiter: String(formData.get("delimiter") ?? "") || undefined,
    });
    // No `refresh()`: a preview writes nothing, so there is nothing on the
    // page behind it that has changed.
    return { preview };
  } catch (error) {
    return describe(error, "That file could not be read.");
  }
}

export interface CommitActionState extends ActionState {
  result?: {
    created: number;
    updated: number;
    unchanged: number;
    failed: number;
    description: string;
    failures: Array<{ line: number; key: string | null; messages: string[] }>;
    /**
     * The error report as base64 rather than a Buffer: a Server Action result
     * is serialized to the client, and a CSV an admin downloads is small
     * enough that handing it back inline beats storing it somewhere with a
     * lifetime and an access rule of its own.
     */
    errorReport: { filename: string; contentType: string; base64: string } | null;
  };
}

export async function commitImportAction(
  _prev: CommitActionState,
  formData: FormData,
): Promise<CommitActionState> {
  const actor = await requireUser();
  const upload = await readUpload(formData);
  if (isActionState(upload)) return upload;

  const sources = formData.getAll("mappingSource").map(String);
  const targets = formData.getAll("mappingTarget").map(String);
  const mappings: FieldMapping[] = [];
  for (let i = 0; i < targets.length; i += 1) {
    const target = targets[i]?.trim();
    const source = sources[i]?.trim();
    if (!target || !source) continue;
    mappings.push({ source, target });
  }
  if (mappings.length === 0) return { error: "Map at least the student code column before importing." };

  try {
    // The file is re-uploaded and re-planned rather than resumed from a
    // server-side stash. The roster can change between preview and commit, and
    // re-planning against the roster as it is now is the honest answer — the
    // summary returned here is what actually happened, not what the preview
    // predicted would happen.
    const result = await commitImport(actor, {
      bytes: upload.bytes,
      filename: upload.filename,
      resource: String(formData.get("resource") ?? "students"),
      delimiter: String(formData.get("delimiter") ?? "") || undefined,
      mappings,
    });

    refresh();
    return {
      message: result.description,
      result: {
        created: result.created,
        updated: result.updated,
        unchanged: result.summary.unchanged,
        failed: result.failed,
        description: result.description,
        failures: result.failures.slice(0, 50),
        errorReport: result.errorReport
          ? {
              filename: result.errorReport.filename,
              contentType: result.errorReport.contentType,
              base64: result.errorReport.body.toString("base64"),
            }
          : null,
      },
    };
  } catch (error) {
    return describe(error, "That import could not be completed.");
  }
}
