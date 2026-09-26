"use client";

import { useActionState, useState, useSyncExternalStore } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, Panel } from "@/components/ui/panel";
import {
  provisionStudentLoginAction,
  resetStudentLoginAction,
  setStudentLoginEnabledAction,
  type StudentLoginFormState,
  type StudentLoginToggleState,
} from "@/modules/students/directory-actions";
import type { StudentLoginAccount } from "@/modules/students/login-provisioning";

/**
 * The student's own way in — and their parents', on any device.
 *
 * A student row and a login are separate things: most students never need an
 * account, and creating one for every enrolment would be a pile of credentials
 * nobody asked for. So this panel is opt-in, one student at a time, and says
 * plainly what the account can and cannot reach.
 *
 * The student signs in with their student ID on the school's student sign-in
 * link; an email address is optional. A password is shown once, from the
 * action's return value. Reloading the page does not bring it back; there is
 * no stored copy to bring back, and no screen that can reveal the current one.
 */

const INITIAL: StudentLoginFormState = { error: null, issued: null };
const TOGGLE_INITIAL: StudentLoginToggleState = { error: null };

interface Props {
  studentId: string;
  studentName: string;
  login: StudentLoginAccount | null;
  /** Whether the student is on roll; a login is only created for one who is. */
  studentOnRoll: boolean;
  institutionId: string;
  /** When the login last signed in, formatted on the server like every other time on the record. */
  lastSignIn: string | null;
  canManage: boolean;
}

/** This page's origin, read in the browser; empty while rendering on the server. */
function useOrigin(): string {
  return useSyncExternalStore(
    () => () => {},
    () => window.location.origin,
    () => "",
  );
}

export function StudentLogin({
  studentId,
  studentName,
  login,
  studentOnRoll,
  institutionId,
  lastSignIn,
  canManage,
}: Props) {
  const [adding, setAdding] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [createState, createAction, creating] = useActionState(provisionStudentLoginAction, INITIAL);
  const [resetState, resetAction, resetting] = useActionState(resetStudentLoginAction, INITIAL);
  const origin = useOrigin();

  const issued = createState.issued ?? resetState.issued;
  const showIssued = issued && dismissed !== issued.password ? issued : null;
  const error = createState.error ?? resetState.error;
  const signInPath = `/login?school=${encodeURIComponent(login?.institutionId ?? institutionId)}`;
  const signInUrl = origin ? `${origin}${signInPath}` : signInPath;

  return (
    <Panel
      title="Student login"
      description={`Whether ${studentName} — or a parent, on any device — can sign in to see their own attendance.`}
    >
      {showIssued ? (
        <div
          role="status"
          className="flex flex-col gap-2 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-3"
        >
          <p className="text-sm font-medium text-emerald-900">
            New password for student ID <span className="font-mono">{showIssued.loginId}</span>
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 select-all break-all rounded border border-emerald-200 bg-white px-2 py-1.5 font-mono text-sm text-neutral-900">
              {showIssued.password}
            </code>
            <CopyButton text={showIssued.password} label="Copy password" />
          </div>
          <p className="text-xs text-emerald-900">{showIssued.notice}</p>
          <p className="text-xs text-emerald-900">
            Once signed in, they can choose their own password under Account.
          </p>
          <div>
            <Button type="button" variant="secondary" onClick={() => setDismissed(showIssued.password)}>
              Done
            </Button>
          </div>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900">
          {error}
        </p>
      ) : null}

      {login ? (
        <div className="flex flex-col gap-4">
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div className="flex flex-col gap-0.5">
              <dt className="text-xs uppercase tracking-wide text-neutral-500">Student ID (sign-in)</dt>
              <dd className="font-mono text-neutral-900">{login.loginId}</dd>
            </div>
            <div className="flex flex-col gap-0.5">
              <dt className="text-xs uppercase tracking-wide text-neutral-500">Status</dt>
              <dd className="flex flex-wrap items-center gap-2">
                {!login.studentOnRoll ? (
                  <>
                    <Badge tone="warning">Blocked</Badge>
                    <span className="text-xs text-neutral-500">
                      The student is not on roll, so this login cannot sign in.
                    </span>
                  </>
                ) : login.status === "ACTIVE" ? (
                  <Badge tone="positive">Active</Badge>
                ) : (
                  <Badge tone="neutral">Disabled</Badge>
                )}
              </dd>
            </div>
            <div className="flex min-w-0 flex-col gap-0.5 sm:col-span-2">
              <dt className="text-xs uppercase tracking-wide text-neutral-500">Student sign-in link</dt>
              <dd className="flex min-w-0 flex-wrap items-center gap-2">
                <a
                  href={signInPath}
                  className="min-w-0 break-all font-mono text-xs text-neutral-700 underline underline-offset-2"
                >
                  {signInUrl}
                </a>
                <CopyButton text={signInUrl} label="Copy link" />
              </dd>
            </div>
            <div className="flex flex-col gap-0.5">
              <dt className="text-xs uppercase tracking-wide text-neutral-500">Email</dt>
              <dd className="text-neutral-900">
                {login.email ?? <span className="text-neutral-400">None — signs in with the student ID</span>}
              </dd>
            </div>
            <div className="flex flex-col gap-0.5">
              <dt className="text-xs uppercase tracking-wide text-neutral-500">Last sign-in</dt>
              <dd className="text-neutral-900">
                {lastSignIn ?? <span className="text-neutral-400">Never</span>}
              </dd>
            </div>
          </dl>
          <p className="text-xs text-neutral-500">
            Signs in to the student portal only — their own attendance and nothing else. The same
            student ID and password work on several phones and computers at once.
          </p>

          {canManage ? (
            <div className="flex flex-wrap items-start gap-2">
              <form action={resetAction}>
                <input type="hidden" name="studentId" value={studentId} />
                <Button type="submit" variant="secondary" disabled={resetting}>
                  {resetting ? "Issuing…" : "Reset password"}
                </Button>
              </form>
              {/* Keyed on the status, so a finished change starts the next
                  one from the plain button rather than a stale confirmation. */}
              <LoginToggle key={login.status} studentId={studentId} enabled={login.status === "ACTIVE"} />
            </div>
          ) : null}
        </div>
      ) : (
        <EmptyState>
          This student has no login. They appear on registers and in reports either way — a login
          only lets them, or a parent, see their own attendance.
        </EmptyState>
      )}

      {!login && canManage && studentOnRoll ? (
        adding ? (
          <form action={createAction} className="flex flex-col gap-3">
            <input type="hidden" name="studentId" value={studentId} />
            <p className="text-sm text-neutral-700">
              They will sign in with their student ID on your school&apos;s student sign-in link,
              and a password shown to you once.
            </p>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-neutral-600">Email (optional)</span>
              <input
                name="email"
                type="email"
                maxLength={255}
                autoComplete="off"
                className="rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-900 focus:border-neutral-900 focus:outline-none sm:max-w-sm"
              />
              <span className="text-xs text-neutral-500">
                Only if the student has an address of their own; it becomes a second way to sign in.
              </span>
            </label>
            <p className="text-xs text-neutral-500">
              The account receives the STUDENT role: their own attendance and their own record. It
              cannot open any staff screen or read another student.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" disabled={creating}>
                {creating ? "Creating…" : "Create login"}
              </Button>
              <Button type="button" variant="secondary" onClick={() => setAdding(false)}>
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <div>
            <Button type="button" onClick={() => setAdding(true)}>
              Create login
            </Button>
          </div>
        )
      ) : null}
      {!login && canManage && !studentOnRoll ? (
        <p className="text-xs text-neutral-500">
          A login can be created once the student is back on roll.
        </p>
      ) : null}
    </Panel>
  );
}

/** Disable — after a confirming second click, since it signs every device out — or enable. */
function LoginToggle({ studentId, enabled }: { studentId: string; enabled: boolean }) {
  const [confirming, setConfirming] = useState(false);
  const [state, action, pending] = useActionState(setStudentLoginEnabledAction, TOGGLE_INITIAL);

  return (
    <div className="flex flex-col gap-1.5">
      {enabled ? (
        confirming ? (
          <form action={action} className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="studentId" value={studentId} />
            <input type="hidden" name="enabled" value="0" />
            <span className="text-xs text-neutral-600">
              Signs out every device now. Attendance is kept.
            </span>
            <Button type="submit" variant="danger" disabled={pending}>
              {pending ? "Disabling…" : "Disable login"}
            </Button>
            <Button type="button" variant="secondary" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </form>
        ) : (
          <Button type="button" variant="secondary" onClick={() => setConfirming(true)}>
            Disable login
          </Button>
        )
      ) : (
        <form action={action}>
          <input type="hidden" name="studentId" value={studentId} />
          <input type="hidden" name="enabled" value="1" />
          <Button type="submit" variant="secondary" disabled={pending}>
            {pending ? "Enabling…" : "Enable login"}
          </Button>
        </form>
      )}
      {state.error ? (
        <p role="alert" className="text-xs text-red-700">
          {state.error}
        </p>
      ) : null}
    </div>
  );
}

/** Copies text to the clipboard and says so, for a screen reader as well. */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <>
      <Button
        type="button"
        variant="secondary"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
          } catch {
            setCopied(false);
          }
        }}
      >
        {copied ? "Copied" : label}
      </Button>
      <span aria-live="polite" className="sr-only">
        {copied ? `${label.replace("Copy ", "")} copied` : ""}
      </span>
    </>
  );
}
