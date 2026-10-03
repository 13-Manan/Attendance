"use client";

import Link from "next/link";
import { useActionState, useId, useState } from "react";
import {
  createReceptionistAction,
  resetReceptionistPasswordAction,
  setReceptionistAccessAction,
  setReceptionistActiveAction,
  updateReceptionistAction,
  type ReceptionistActionState,
} from "@/modules/receptionists/actions";
import type { AccessGroup, AccessItem as CatalogItem } from "@/modules/receptionists/catalog";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

/**
 * The principal's controls for receptionist accounts. Presentation only: every
 * button posts to a Server Action, and the service behind it decides who may,
 * which school, which account and what access — nothing here is trusted.
 */

const INITIAL: ReceptionistActionState = {};

function Feedback({ state }: { state: ReceptionistActionState }) {
  if (state.error) {
    return (
      <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">
        {state.error}
      </p>
    );
  }
  if (state.message && !state.password) {
    return (
      <p role="status" className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
        {state.message}
      </p>
    );
  }
  return null;
}

/**
 * A temporary password, shown once. It came back in the action's state and
 * lives nowhere else: staff passwords are never stored readably, so a lost
 * one is reset, not recovered.
 */
export function PasswordOnce({ email, password, heading }: { email: string; password: string; heading: string }) {
  const [dismissed, setDismissed] = useState(false);
  const [copied, setCopied] = useState(false);
  if (dismissed) return null;
  return (
    <div role="status" className="flex flex-col gap-2 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-3">
      <p className="text-sm font-medium text-emerald-900">{heading}</p>
      <dl className="grid gap-1 text-sm text-emerald-950 sm:grid-cols-[auto_1fr] sm:gap-x-3">
        <dt className="font-medium">Email</dt>
        <dd className="break-all font-mono">{email}</dd>
      </dl>
      <div className="flex flex-wrap items-center gap-2">
        <code className="min-w-0 flex-1 select-all break-all rounded border border-emerald-200 bg-white px-2 py-1.5 font-mono text-sm text-neutral-900">
          {password}
        </code>
        <Button
          type="button"
          variant="secondary"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(password);
              setCopied(true);
            } catch {
              setCopied(false);
            }
          }}
        >
          {copied ? "Copied" : "Copy password"}
        </Button>
        <span aria-live="polite" className="sr-only">
          {copied ? "Password copied" : ""}
        </span>
      </div>
      <p className="text-xs text-emerald-900">
        Copy this now — it is shown once and nobody can read it back. Hand it over in person. They choose their own
        password the first time they sign in; if this one is lost, reset it.
      </p>
      <div>
        <Button type="button" variant="secondary" onClick={() => setDismissed(true)}>
          Done
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Adding
// ---------------------------------------------------------------------------

export function AddReceptionistForm() {
  const [state, action, pending] = useActionState(createReceptionistAction, INITIAL);
  const id = useId();
  return (
    <div className="flex flex-col gap-4">
      {/* A fresh form after each account, so the next one starts empty. */}
      <form key={state.receptionistId ?? "new"} action={action} className="grid gap-3 sm:grid-cols-2">
        <Field label="Full name" htmlFor={`${id}-name`}>
          <Input id={`${id}-name`} name="name" required autoComplete="off" maxLength={120} />
        </Field>
        <Field label="School email (their login)" htmlFor={`${id}-email`}>
          <Input id={`${id}-email`} name="email" type="email" required autoComplete="off" inputMode="email" />
        </Field>
        <Field label="Phone (optional)" htmlFor={`${id}-phone`}>
          <Input id={`${id}-phone`} name="phone" type="tel" autoComplete="off" inputMode="tel" />
        </Field>
        <div className="flex items-end">
          <Button type="submit" disabled={pending} className="w-full sm:w-auto">
            {pending ? "Creating…" : "Create receptionist"}
          </Button>
        </div>
      </form>
      <p className="text-xs text-neutral-500">
        They start with everyday school work switched on — students, admissions, face enrollment, attendance and
        reports — and settings, integrations and security switched off. You can change any of it at any time.
      </p>
      <Feedback state={state} />
      {state.password && state.email ? (
        <div className="flex flex-col gap-2">
          <PasswordOnce heading={state.message ?? "Receptionist created"} email={state.email} password={state.password} />
          {state.receptionistId ? (
            <Link
              href={`/dashboard/receptionists/${state.receptionistId}#access`}
              className="inline-flex min-h-11 items-center text-sm font-medium text-neutral-900 underline underline-offset-4"
            >
              Review their access
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Details
// ---------------------------------------------------------------------------

export function EditDetailsForm({
  receptionistId,
  name,
  email,
  phone,
}: {
  receptionistId: string;
  name: string;
  email: string;
  phone: string | null;
}) {
  const [state, action, pending] = useActionState(updateReceptionistAction, INITIAL);
  const id = useId();
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-2">
      <input type="hidden" name="id" value={receptionistId} />
      <Field label="Full name" htmlFor={`${id}-name`}>
        <Input id={`${id}-name`} name="name" defaultValue={name} required maxLength={120} />
      </Field>
      <Field label="Phone (optional)" htmlFor={`${id}-phone`}>
        <Input id={`${id}-phone`} name="phone" type="tel" defaultValue={phone ?? ""} inputMode="tel" />
      </Field>
      <Field label="School email (their login)" htmlFor={`${id}-email`}>
        <Input id={`${id}-email`} value={email} readOnly aria-describedby={`${id}-email-note`} />
      </Field>
      <p id={`${id}-email-note`} className="self-end text-xs text-neutral-500">
        The email is what they sign in with. A different address is a different account.
      </p>
      <div className="flex flex-col gap-2 sm:col-span-2">
        <div>
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : "Save details"}
          </Button>
        </div>
        <Feedback state={state} />
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Switching off and on, and a new password
// ---------------------------------------------------------------------------

export function AccountActions({
  receptionistId,
  name,
  active,
  compact = false,
}: {
  receptionistId: string;
  name: string;
  active: boolean;
  /** In the list: smaller, side by side. */
  compact?: boolean;
}) {
  const [confirming, setConfirming] = useState<null | "status" | "reset">(null);
  // The question closes once the server has answered — not on submit, which
  // would unmount the form while its action is still on its way.
  const [statusState, statusAction, statusPending] = useActionState(
    async (previous: ReceptionistActionState, formData: FormData) => {
      const result = await setReceptionistActiveAction(previous, formData);
      setConfirming(null);
      return result;
    },
    INITIAL,
  );
  const [resetState, resetAction, resetPending] = useActionState(
    async (previous: ReceptionistActionState, formData: FormData) => {
      const result = await resetReceptionistPasswordAction(previous, formData);
      setConfirming(null);
      return result;
    },
    INITIAL,
  );

  const question =
    confirming === "status"
      ? active
        ? `Switch off ${name}'s account? They are signed out everywhere at once and cannot sign in until you switch it back on.`
        : `Switch ${name}'s account back on? They can sign in again with their current password.`
      : confirming === "reset"
        ? `Issue ${name} a new temporary password? Their current password stops working and they are signed out everywhere.`
        : null;

  return (
    <div className="flex flex-col gap-2">
      {confirming === null ? (
        <div className={`flex flex-wrap gap-2 ${compact ? "" : "sm:gap-3"}`}>
          <Button type="button" variant="secondary" onClick={() => setConfirming("reset")}>
            Reset password
          </Button>
          <Button type="button" variant={active ? "secondary" : "primary"} onClick={() => setConfirming("status")}>
            {active ? "Disable account" : "Enable account"}
          </Button>
        </div>
      ) : (
        <div role="group" aria-label={question ?? undefined} className="flex flex-col gap-2 rounded-md bg-neutral-50 p-3">
          <p className="text-sm text-neutral-800">{question}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="secondary" onClick={() => setConfirming(null)}>
              Cancel
            </Button>
            {confirming === "status" ? (
              <form action={statusAction}>
                <input type="hidden" name="id" value={receptionistId} />
                <input type="hidden" name="active" value={active ? "false" : "true"} />
                <Button type="submit" variant={active ? "danger" : "primary"} disabled={statusPending}>
                  {active ? "Disable account" : "Enable account"}
                </Button>
              </form>
            ) : (
              <form action={resetAction}>
                <input type="hidden" name="id" value={receptionistId} />
                <Button type="submit" disabled={resetPending}>
                  Issue a new password
                </Button>
              </form>
            )}
          </div>
        </div>
      )}
      <Feedback state={statusState} />
      <Feedback state={resetState} />
      {resetState.password && resetState.email ? (
        <PasswordOnce heading={`New temporary password for ${name}`} email={resetState.email} password={resetState.password} />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

/** A switch as the editor sees it: what it says and what it needs. */
type AccessItem = Pick<CatalogItem, "id" | "group" | "label" | "description" | "requires" | "confirm">;

/** On, plus everything it needs. */
function switchOn(on: ReadonlySet<string>, id: string, items: readonly AccessItem[]): Set<string> {
  const next = new Set(on);
  const visit = (key: string) => {
    if (next.has(key)) return;
    next.add(key);
    for (const dependency of items.find((item) => item.id === key)?.requires ?? []) visit(dependency);
  };
  visit(id);
  return next;
}

/** Off, and off with it everything that cannot work without it. */
function switchOff(on: ReadonlySet<string>, id: string, items: readonly AccessItem[]): Set<string> {
  const next = new Set(on);
  const visit = (key: string) => {
    if (!next.delete(key)) return;
    for (const item of items) if (item.requires.includes(key)) visit(item.id);
  };
  visit(id);
  return next;
}

export function AccessEditor({
  receptionistId,
  name,
  groups,
  items,
  initial,
  defaults,
}: {
  receptionistId: string;
  name: string;
  groups: readonly AccessGroup[];
  items: readonly AccessItem[];
  initial: readonly string[];
  defaults: readonly string[];
}) {
  const [state, action, pending] = useActionState(setReceptionistAccessAction, INITIAL);
  const [on, setOn] = useState<Set<string>>(() => new Set(initial));
  const [asking, setAsking] = useState<string | null>(null);
  const id = useId();
  const changed = items.some((item) => on.has(item.id) !== initial.includes(item.id));

  const toggle = (item: AccessItem, checked: boolean) => {
    if (checked && item.confirm) {
      setAsking(item.id);
      return;
    }
    setOn((current) => (checked ? switchOn(current, item.id, items) : switchOff(current, item.id, items)));
  };

  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="id" value={receptionistId} />
      {[...on].map((key) => (
        <input key={key} type="hidden" name="access" value={key} />
      ))}
      {groups.map((group) => {
        const groupItems = items.filter((item) => item.group === group.id);
        const count = groupItems.filter((item) => on.has(item.id)).length;
        return (
          <details key={group.id} open className="group rounded-lg border border-neutral-200 bg-white">
            <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-4 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-neutral-900">
              <span className="flex flex-col">
                <span className="text-sm font-semibold uppercase tracking-wide text-neutral-900">{group.label}</span>
                <span className="text-xs text-neutral-500">{group.description}</span>
              </span>
              <span className="flex shrink-0 items-center gap-2 whitespace-nowrap text-xs tabular-nums text-neutral-600">
                {count} of {groupItems.length} on
                <span aria-hidden className="text-neutral-400 transition-transform group-open:rotate-180">
                  ▾
                </span>
              </span>
            </summary>
            <ul className="flex flex-col divide-y divide-neutral-100 border-t border-neutral-100">
              {groupItems.map((item) => {
                const inputId = `${id}-${item.id}`;
                const checked = on.has(item.id);
                return (
                  <li key={item.id} className="px-4 py-3">
                    <div className="flex items-start gap-3">
                      <input
                        id={inputId}
                        type="checkbox"
                        checked={checked}
                        onChange={(event) => toggle(item, event.target.checked)}
                        aria-describedby={`${inputId}-help`}
                        className="mt-0.5 size-5 shrink-0 accent-neutral-900"
                      />
                      <label htmlFor={inputId} className="flex min-w-0 flex-col gap-0.5">
                        <span className="text-sm font-medium text-neutral-900">
                          {item.label}
                          {item.confirm ? (
                            <span className="ml-2 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-900">
                              Sensitive
                            </span>
                          ) : null}
                        </span>
                        <span id={`${inputId}-help`} className="text-xs text-neutral-600">
                          {item.description}
                        </span>
                      </label>
                    </div>
                    {asking === item.id ? (
                      <div role="group" aria-label={`Turn on ${item.label}?`} className="mt-3 flex flex-col gap-2 rounded-md bg-amber-50 p-3">
                        <p className="text-sm text-amber-950">{item.confirm}</p>
                        <div className="flex flex-wrap gap-2">
                          <Button type="button" variant="secondary" onClick={() => setAsking(null)}>
                            Keep off
                          </Button>
                          <Button
                            type="button"
                            onClick={() => {
                              setOn((current) => switchOn(current, item.id, items));
                              setAsking(null);
                            }}
                          >
                            Turn on
                          </Button>
                        </div>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </details>
        );
      })}
      <p className="rounded-md bg-neutral-50 px-3 py-2 text-xs text-neutral-600">
        Managing receptionists and what they may do stays with you: it cannot be given to a receptionist. Changes
        apply from {name}&apos;s next click — no need for them to sign out.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={pending || !changed}>
          {pending ? "Saving…" : "Save access"}
        </Button>
        <Button type="button" variant="secondary" onClick={() => setOn(new Set(defaults))} disabled={pending}>
          Use the standard access
        </Button>
        {changed ? <span className="text-xs text-amber-800">Unsaved changes</span> : null}
      </div>
      <Feedback state={state} />
    </form>
  );
}
