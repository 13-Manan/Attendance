"use client";

import { useActionState } from "react";
import {
  deleteConnectionAction,
  runSyncAction,
  saveFieldMappingsAction,
  setConnectionStatusAction,
  testConnectionAction,
  updateConnectionAction,
  type ActionState,
  type SyncActionState,
} from "@/modules/integrations/actions";
import type { ConnectionView } from "@/modules/integrations/center-service";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Disclosure, FormBanner, HeaderRows, LocalTime, Select, StatusBadge } from "./controls";

const empty: ActionState = {};
const emptySync: SyncActionState = {};

type TargetField = { key: string; label: string; storedAs: string; required: boolean };

/**
 * One connected system.
 *
 * Everything an administrator needs in order to answer "is this working?" is
 * on the face of the card — status, last sync, the most recent errors — and
 * everything that changes it is behind a disclosure. The ordering is
 * deliberate: the failure state is never one click away from being noticed.
 */
export function ConnectionCard({
  connection,
  targetFields,
  canManage,
}: {
  connection: ConnectionView;
  targetFields: TargetField[];
  canManage: boolean;
}) {
  return (
    <article className="flex flex-col gap-3 rounded-lg border border-neutral-200 bg-white p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-neutral-900">{connection.name}</h3>
            <StatusBadge status={connection.status} />
          </div>
          <p className="text-xs text-neutral-500">
            {connection.kindLabel} · {connection.resources.join(", ") || "no records selected"} ·{" "}
            {connection.syncMode === "MANUAL"
              ? "manual only"
              : `${connection.syncMode.toLowerCase()} every ${connection.intervalMinutes} min`}
          </p>
        </div>
        {canManage ? <SyncNow connection={connection} /> : null}
      </header>

      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
        <dt className="text-neutral-500">Last sync</dt>
        <dd className="text-neutral-900">
          <LocalTime iso={connection.lastSyncAt} />
        </dd>
        <dt className="text-neutral-500">Last success</dt>
        <dd className="text-neutral-900">
          <LocalTime iso={connection.lastSuccessAt} />
        </dd>
        {connection.syncMode !== "MANUAL" ? (
          <>
            <dt className="text-neutral-500">Next eligible</dt>
            <dd className="text-neutral-900">
              <LocalTime iso={connection.nextEligibleAt} fallback="now" />
            </dd>
          </>
        ) : null}
      </dl>

      {connection.mappingProblems.length > 0 ? (
        <p role="alert" className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">
          This field mapping will not run:{" "}
          {connection.mappingProblems.map((problem) => problem.message).join(" ")}
        </p>
      ) : null}

      {connection.recentErrors.length > 0 ? (
        <div className="rounded-md bg-red-50 px-3 py-2">
          <p className="text-xs font-medium text-red-800">Recent failures</p>
          <ul className="mt-1 flex flex-col gap-1">
            {connection.recentErrors.map((error, index) => (
              <li key={index} className="text-xs text-red-700">
                <LocalTime iso={error.at} /> — {error.message}
                {error.resource ? ` (${error.resource})` : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {canManage ? (
        <div className="flex flex-col gap-2">
          <Disclosure summary="Credentials and configuration">
            <ConfigForm connection={connection} />
          </Disclosure>
          <Disclosure summary="Field mapping">
            <MappingForm connection={connection} targetFields={targetFields} />
          </Disclosure>
          <ConnectionActions connection={connection} />
        </div>
      ) : (
        <ReadOnlyConfig connection={connection} />
      )}
    </article>
  );
}

// ---------------------------------------------------------------------------
// Sync now
// ---------------------------------------------------------------------------

function SyncNow({ connection }: { connection: ConnectionView }) {
  const [state, formAction, pending] = useActionState(runSyncAction, emptySync);

  return (
    <div className="flex flex-col items-end gap-1">
      <form action={formAction}>
        <input type="hidden" name="connectionId" value={connection.id} />
        {/* A manual run ignores the interval gate on purpose — the button
            exists precisely for "I know, run it anyway". */}
        <input type="hidden" name="force" value="on" />
        <Button type="submit" disabled={pending || !connection.canSyncNow}>
          {pending ? "Syncing…" : "Sync now"}
        </Button>
      </form>
      {!connection.canSyncNow && connection.syncBlockedReason ? (
        <p className="max-w-64 text-right text-xs text-neutral-500">{connection.syncBlockedReason}</p>
      ) : null}
      <div className="max-w-80">
        <FormBanner state={state} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function ConfigForm({ connection }: { connection: ConnectionView }) {
  const [state, formAction, pending] = useActionState(updateConnectionAction, empty);
  const { config, capabilities } = connection;

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="connectionId" value={connection.id} />

      <Field label="Name" htmlFor={`name-${connection.id}`}>
        <Input id={`name-${connection.id}`} name="name" defaultValue={connection.name} required />
      </Field>

      {capabilities.pull ? (
        <>
          <Field label="Base URL" htmlFor={`baseUrl-${connection.id}`}>
            <Input
              id={`baseUrl-${connection.id}`}
              name="baseUrl"
              defaultValue={config.baseUrl ?? ""}
              required
            />
          </Field>
          <Field label="Health-check path" htmlFor={`testPath-${connection.id}`}>
            <Input
              id={`testPath-${connection.id}`}
              name="testPath"
              defaultValue={config.testPath ?? ""}
            />
          </Field>
        </>
      ) : null}

      {capabilities.push ? (
        <Field label="Delivery URL" htmlFor={`deliveryUrl-${connection.id}`}>
          <Input
            id={`deliveryUrl-${connection.id}`}
            name="deliveryUrl"
            defaultValue={config.deliveryUrl ?? ""}
          />
        </Field>
      ) : null}

      {connection.kind === "csv" ? (
        <Field label="Delimiter" htmlFor={`delimiter-${connection.id}`}>
          <Input
            id={`delimiter-${connection.id}`}
            name="delimiter"
            defaultValue={config.delimiter ?? ""}
            maxLength={2}
            className="max-w-24"
          />
        </Field>
      ) : null}

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-neutral-700">Records to sync</legend>
        {connection.resources.map((resource) => (
          <label key={resource} className="flex items-center gap-2 text-sm text-neutral-700">
            <input type="checkbox" name="resources" value={resource} defaultChecked />
            {resource}
          </label>
        ))}
      </fieldset>

      <Field label="Sync mode" htmlFor={`syncMode-${connection.id}`}>
        <Select id={`syncMode-${connection.id}`} name="syncMode" defaultValue={connection.syncMode}>
          <option value="MANUAL">Manual</option>
          {capabilities.scheduled ? <option value="SCHEDULED">Scheduled</option> : null}
          {capabilities.incremental ? <option value="INCREMENTAL">Incremental</option> : null}
        </Select>
      </Field>

      <Field label="Interval (minutes)" htmlFor={`interval-${connection.id}`}>
        <Input
          id={`interval-${connection.id}`}
          name="intervalMinutes"
          type="number"
          min={5}
          defaultValue={connection.intervalMinutes ?? 60}
          className="max-w-32"
        />
      </Field>

      <HeaderRows
        description="Leave a value blank to keep the stored credential. Type a new one to replace it, or Remove to delete it — the saved value is never sent back to this page."
        initial={
          config.headers.length > 0
            ? config.headers.map((header) => ({ name: header.name, value: "", stored: true }))
            : [{ name: "", value: "" }]
        }
      />

      <FormBanner state={state} />

      <div>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save configuration"}
        </Button>
      </div>
    </form>
  );
}

/** What a read-only viewer sees: the same facts, none of the inputs. */
function ReadOnlyConfig({ connection }: { connection: ConnectionView }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
      {connection.config.baseUrl ? (
        <>
          <dt className="text-neutral-500">Base URL</dt>
          <dd className="break-all text-neutral-900">{connection.config.baseUrl}</dd>
        </>
      ) : null}
      <dt className="text-neutral-500">Credentials</dt>
      <dd className="text-neutral-900">
        {connection.config.hasCredentials ? "configured" : "none"}
      </dd>
    </dl>
  );
}

// ---------------------------------------------------------------------------
// Field mapping
// ---------------------------------------------------------------------------

/**
 * The mapping editor.
 *
 * The left column is free text because the external system's column names are
 * the external system's business — `student_id`, `ADM_NO` and `Roll No.` are
 * all real. The right column is a fixed list, because those are the fields
 * this platform actually has, and letting someone type one means letting them
 * save a mapping that fails at 2am instead of now.
 */
function MappingForm({
  connection,
  targetFields,
}: {
  connection: ConnectionView;
  targetFields: TargetField[];
}) {
  const [state, formAction, pending] = useActionState(saveFieldMappingsAction, empty);
  // One row per target, pre-filled from what is saved. A fixed row set beats
  // add/remove here: the question "which column is the student code?" always
  // needs an answer, so the row should always be visible.
  const rows = targetFields.map((field) => ({
    field,
    source: connection.fieldMappings.find((mapping) => mapping.target === field.key)?.source ?? "",
  }));

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="connectionId" value={connection.id} />
      <input type="hidden" name="resource" value={connection.resources[0] ?? "students"} />

      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-neutral-500">
            <th className="pb-1 font-medium">Their column</th>
            <th className="pb-1 font-medium">Our field</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.field.key}>
              <td className="py-1 pr-2">
                <Input
                  aria-label={`Source column for ${row.field.label}`}
                  name="mappingSource"
                  defaultValue={row.source}
                  placeholder={row.field.required ? "required" : "optional"}
                />
              </td>
              <td className="py-1">
                <input type="hidden" name="mappingTarget" value={row.field.key} />
                <span className="text-neutral-800">
                  {row.field.label}
                  {row.field.required ? <span className="text-red-600"> *</span> : null}
                </span>
                <span className="block text-xs text-neutral-500">{row.field.storedAs}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <FormBanner state={state} />

      <div>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save mapping"}
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Test / pause / delete
// ---------------------------------------------------------------------------

function ConnectionActions({ connection }: { connection: ConnectionView }) {
  const [testState, testAction, testing] = useActionState(testConnectionAction, empty);
  const [statusState, statusAction, statusPending] = useActionState(setConnectionStatusAction, empty);
  const [deleteState, deleteAction, deleting] = useActionState(deleteConnectionAction, empty);

  const nextStatus = connection.status === "PAUSED" ? "ACTIVE" : "PAUSED";

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <form action={testAction}>
          <input type="hidden" name="connectionId" value={connection.id} />
          <Button type="submit" variant="secondary" disabled={testing || !connection.capabilities.testConnection}>
            {testing ? "Testing…" : "Test connection"}
          </Button>
        </form>

        <form action={statusAction}>
          <input type="hidden" name="connectionId" value={connection.id} />
          <input type="hidden" name="status" value={nextStatus} />
          <Button type="submit" variant="secondary" disabled={statusPending}>
            {nextStatus === "PAUSED" ? "Pause" : "Resume"}
          </Button>
        </form>

        <form
          action={deleteAction}
          onSubmit={(event) => {
            // A browser confirm, not a modal: removing an integration stops
            // every future sync for it, and that is worth one deliberate click.
            if (!window.confirm(`Remove "${connection.name}"? Students it already imported stay.`)) {
              event.preventDefault();
            }
          }}
        >
          <input type="hidden" name="connectionId" value={connection.id} />
          <Button type="submit" variant="danger" disabled={deleting}>
            {deleting ? "Removing…" : "Remove"}
          </Button>
        </form>
      </div>

      <FormBanner state={testState} />
      <FormBanner state={statusState} />
      <FormBanner state={deleteState} />
    </div>
  );
}
