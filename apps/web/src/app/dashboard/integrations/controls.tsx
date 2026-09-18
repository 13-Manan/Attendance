"use client";

import { useState, type ReactNode, type SelectHTMLAttributes } from "react";
import type { ActionState } from "@/modules/integrations/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Small shared controls for the Integration Center.
 *
 * They live here rather than in `components/ui` because they encode decisions
 * specific to this screen — chiefly that a credential input is never
 * pre-filled and a blank one means "leave it alone".
 */

export function Select({ className = "", ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={`w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-500 focus:ring-1 focus:ring-neutral-500 ${className}`}
      {...props}
    />
  );
}

/**
 * The one place a form result is rendered.
 *
 * `role="alert"` on the failure and `role="status"` on the success: a screen
 * reader should interrupt for "that sync failed" and not for "saved".
 */
export function FormBanner({ state }: { state: ActionState }) {
  if (state.error) {
    return (
      <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
        {state.error}
      </p>
    );
  }
  if (state.message) {
    return (
      <p role="status" className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-800">
        {state.message}
      </p>
    );
  }
  return null;
}

export interface HeaderRow {
  name: string;
  value: string;
  /** True when the server holds a value for this header that it will not send back. */
  stored?: boolean;
}

/**
 * Editor for the request headers a connection sends — in practice, the
 * credential.
 *
 * The value box for a stored header starts empty and stays empty. The server
 * cannot render the secret back (`describeConfig` masks it) and should not,
 * so the contract is: type something to replace it, leave it blank to keep it,
 * press Remove to delete it. Anything else — a length-preserving mask, a
 * "last 4 characters" hint — turns the form into a slow oracle for the value.
 */
export function HeaderRows({
  initial,
  description,
}: {
  initial: HeaderRow[];
  description: string;
}) {
  const [rows, setRows] = useState<HeaderRow[]>(initial.length > 0 ? initial : [{ name: "", value: "" }]);
  const [removed, setRemoved] = useState<string[]>([]);

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-sm font-medium text-neutral-700">Credentials and headers</legend>
      <p className="text-xs text-neutral-500">{description}</p>

      {rows.map((row, index) => (
        <div key={index} className="flex flex-wrap items-center gap-2">
          <Input
            aria-label="Header name"
            name="headerName"
            defaultValue={row.name}
            placeholder="Authorization"
            className="max-w-56 flex-1"
          />
          <Input
            aria-label="Header value"
            name="headerValue"
            type="password"
            autoComplete="off"
            defaultValue=""
            placeholder={row.stored ? "unchanged" : "Bearer …"}
            className="max-w-72 flex-1"
          />
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              if (row.name) setRemoved((current) => [...current, row.name]);
              setRows((current) => current.filter((_, position) => position !== index));
            }}
          >
            Remove
          </Button>
        </div>
      ))}

      {/* Names of headers the admin deleted, so the server can tell "clear
          this" apart from "I left the box blank". */}
      {removed.map((name) => (
        <input key={name} type="hidden" name="removeHeader" value={name} />
      ))}

      <div>
        <Button
          type="button"
          variant="secondary"
          onClick={() => setRows((current) => [...current, { name: "", value: "" }])}
        >
          + Add header
        </Button>
      </div>
    </fieldset>
  );
}

const STATUS_CLASSES: Record<string, string> = {
  ACTIVE: "bg-green-100 text-green-800",
  DRAFT: "bg-neutral-100 text-neutral-700",
  PAUSED: "bg-amber-100 text-amber-800",
  ERROR: "bg-red-100 text-red-800",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
        STATUS_CLASSES[status] ?? STATUS_CLASSES.DRAFT
      }`}
    >
      {status}
    </span>
  );
}

/** A collapsible section. Used so one card can hold config, mapping and history without becoming a wall. */
export function Disclosure({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details className="rounded-md border border-neutral-200">
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-neutral-800">
        {summary}
      </summary>
      <div className="border-t border-neutral-200 px-3 py-3">{children}</div>
    </details>
  );
}

/**
 * Renders a stored timestamp in the reader's locale.
 *
 * `null` renders as a word, not an empty cell: "last sync — never" and a blank
 * space next to "last sync" mean very different things to someone deciding
 * whether an integration is working, and only one of them is legible.
 */
export function LocalTime({ iso, fallback = "never" }: { iso: string | null; fallback?: string }) {
  if (!iso) return <span className="text-neutral-500">{fallback}</span>;
  return <time dateTime={iso}>{new Date(iso).toLocaleString()}</time>;
}
