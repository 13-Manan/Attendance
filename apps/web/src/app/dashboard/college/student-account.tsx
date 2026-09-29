"use client";

import Link from "next/link";
import { useActionState, useEffect, useId, useRef, useState } from "react";
import {
  createDepartmentStudentLoginAction,
  resetDepartmentStudentPasswordAction,
  type CollegeActionState,
} from "@/modules/college-setup/actions";
import type { StudentLoginState } from "@/modules/college-setup/types";
import { MAX_STUDENT_EMAIL } from "@/modules/students/directory-types";
import { PortalPasswordReveal } from "@/components/account/portal-password-reveal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { usePageLeft } from "@/components/ui/use-page-left";

const INITIAL: CollegeActionState = {};

/** A student's Student Portal account, with its dates already formatted by the page. */
export interface StudentAccountView {
  state: StudentLoginState;
  loginId: string;
  email: string | null;
  mustChangePassword: boolean;
  lastPasswordChange: { at: string; by: "staff" | "student" } | null;
  lastLoginAt: string | null;
  /** Whether the current password can be revealed — the fact only; the page never carries the password. */
  passwordRecoverable: boolean;
  canManage: boolean;
}

/**
 * The student's Student Portal account on their department page: the address
 * it signs in with, whether it is on, whether its password is still the
 * temporary one — and, for whoever may, the current password on request, a
 * new temporary password, or a login for a student who has none.
 *
 * A temporary password appears once, from the action that issued it, and Done
 * remounts the controls, dropping it from the page's memory. Both actions'
 * states live here, above the part of the panel that changes when the page
 * refreshes after them, so the password survives the refresh that shows the
 * new account. The current password is only ever fetched by "Show current
 * password" (`PortalPasswordReveal`), audited, and never part of the page.
 */
export function StudentAccountPanel(props: {
  departmentId: string;
  studentId: string;
  studentName: string;
  /** The email on the student's record, offered when a login is created. */
  recordEmail: string | null;
  onRoll: boolean;
  account: StudentAccountView;
  /** The student's full record, where an administrator switches the login off or on; null for a head. */
  recordHref: string | null;
}) {
  const [round, setRound] = useState(0);
  return <AccountControls key={round} {...props} onDone={() => setRound((value) => value + 1)} />;
}

function AccountControls({
  departmentId,
  studentId,
  studentName,
  recordEmail,
  onRoll,
  account,
  recordHref,
  onDone,
}: Parameters<typeof StudentAccountPanel>[0] & { onDone: () => void }) {
  const [created, createAction, creating] = useActionState(createDepartmentStudentLoginAction, INITIAL);
  const [reset, resetAction, resetting] = useActionState(resetDepartmentStudentPasswordAction, INITIAL);
  const [adding, setAdding] = useState(false);
  const issued = reset.password ? reset : created.password ? created : null;
  const error = reset.error ?? created.error;
  const id = useId();

  return (
    <div className="flex flex-col gap-4 text-sm">
      {issued ? <IssuedPassword state={issued} onDone={onDone} /> : null}
      {error ? (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-red-700">
          {error}
        </p>
      ) : null}

      {account.state === "none" ? (
        <>
          <p className="text-neutral-700">
            No Student Portal account yet. {studentName} appears on registers either way; an account lets them see
            their own attendance.
          </p>
          {!account.canManage ? (
            <p className="text-neutral-600">
              A login can be created from here while they are in one of the department&apos;s sections in a current
              session.
            </p>
          ) : !onRoll ? (
            <p className="text-neutral-600">A login can be created once they are back on roll.</p>
          ) : adding ? (
            <form action={createAction} className="flex flex-col gap-3">
              <input type="hidden" name="departmentId" value={departmentId} />
              <input type="hidden" name="studentId" value={studentId} />
              <Field label="College email *" htmlFor={`${id}-email`}>
                <Input
                  key={`email-${created.attempt ?? 0}`}
                  id={`${id}-email`}
                  name="email"
                  type="email"
                  required
                  autoFocus
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  maxLength={MAX_STUDENT_EMAIL}
                  defaultValue={created.values?.email ?? recordEmail ?? ""}
                  aria-describedby={`${id}-email-help`}
                  className="sm:max-w-sm"
                />
                <p id={`${id}-email-help`} className="mt-1 text-xs text-neutral-500">
                  This email will be used by the student to sign in to the Student Portal.
                </p>
              </Field>
              <p className="text-xs text-neutral-500">
                The account can see {studentName}&apos;s own record and attendance and nothing else. A temporary
                password is shown to you once; they choose their own when they first sign in.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Button type="submit" disabled={creating}>
                  {creating ? "Creating…" : "Create portal account"}
                </Button>
                <Button type="button" variant="secondary" onClick={() => setAdding(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <div>
              <Button type="button" onClick={() => setAdding(true)}>
                Create portal account
              </Button>
            </div>
          )}
        </>
      ) : (
        <>
          <dl className="grid gap-3 sm:grid-cols-2">
            <Detail label="Email">
              {account.email ? (
                <span className="break-all">{account.email}</span>
              ) : (
                <span className="text-neutral-400">None — signs in with the student ID</span>
              )}
            </Detail>
            <Detail label="Student ID (sign-in)">
              <span className="font-mono">{account.loginId}</span>
            </Detail>
            <Detail label="Account">
              {!onRoll ? (
                <Badge tone="warning">Blocked — not on roll</Badge>
              ) : account.state === "enabled" ? (
                <Badge tone="positive">
                  <span aria-hidden="true">✓&nbsp;</span>Active
                </Badge>
              ) : (
                <Badge tone="danger">Disabled</Badge>
              )}
            </Detail>
            <Detail label="Password">
              {account.mustChangePassword ? (
                <>
                  <Badge tone="warning">Temporary</Badge>
                  <span className="text-xs text-neutral-600">They choose their own at next sign-in.</span>
                </>
              ) : (
                <Badge tone="positive">
                  <span aria-hidden="true">✓&nbsp;</span>Password set
                </Badge>
              )}
            </Detail>
            <Detail label="Last password change">
              {account.lastPasswordChange ? (
                <>
                  {account.lastPasswordChange.at}
                  <span className="text-neutral-500">
                    {account.lastPasswordChange.by === "student" ? " · by the student" : " · issued by staff"}
                  </span>
                </>
              ) : (
                <span className="text-neutral-400">Not recorded</span>
              )}
            </Detail>
            <Detail label="Last sign-in">
              {account.lastLoginAt ?? <span className="text-neutral-400">Never</span>}
            </Detail>
          </dl>
          {account.canManage ? (
            <PortalPasswordReveal studentId={studentId} recoverable={account.passwordRecoverable} />
          ) : null}
          <p className="text-xs text-neutral-500">
            A reset issues a new temporary password — the old one stops working at once — and they choose their own
            again when they sign in.
          </p>
          {account.canManage || recordHref ? (
            <div className="flex flex-wrap items-start gap-2">
              {account.canManage ? (
                <ResetPassword
                  departmentId={departmentId}
                  studentId={studentId}
                  studentName={studentName}
                  action={resetAction}
                  pending={resetting}
                  attempt={reset.attempt}
                />
              ) : null}
              {recordHref ? (
                <Link
                  href={recordHref}
                  className="inline-flex min-h-11 items-center rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-900 hover:bg-neutral-50 sm:min-h-10"
                >
                  Disable or enable on their record
                </Link>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

/**
 * Reset password, after asking once more in place. Opening the question moves
 * focus to Cancel, the safe answer; Escape and Cancel close it.
 */
function ResetPassword({
  departmentId,
  studentId,
  studentName,
  action,
  pending,
  attempt,
}: {
  departmentId: string;
  studentId: string;
  studentName: string;
  action: (formData: FormData) => void;
  pending: boolean;
  /** Changes when the action answers, which closes the question: its answer shows above. */
  attempt: number | undefined;
}) {
  const [confirming, setConfirming] = useState(false);
  const [settled, setSettled] = useState(attempt);
  if (attempt !== settled) {
    setSettled(attempt);
    setConfirming(false);
  }
  const box = useRef<HTMLDivElement>(null);
  const questionId = useId();
  useEffect(() => {
    if (confirming) box.current?.querySelector<HTMLElement>("[data-confirm-cancel]")?.focus();
  }, [confirming]);

  if (!confirming) {
    return (
      <div>
        <Button type="button" variant="secondary" onClick={() => setConfirming(true)}>
          Reset password
        </Button>
      </div>
    );
  }
  return (
    <div ref={box} className="w-full">
      <form
        action={action}
        role="group"
        aria-labelledby={questionId}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            setConfirming(false);
          }
        }}
        className="flex flex-col gap-3 rounded-md border border-amber-200 bg-amber-50 p-3"
      >
        <input type="hidden" name="departmentId" value={departmentId} />
        <input type="hidden" name="studentId" value={studentId} />
        <p id={questionId} className="text-sm text-neutral-800">
          Reset {studentName}&apos;s password? Their current password stops working at once and every device they are
          signed in on is signed out. A new temporary password is shown to you once.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={pending}>
            {pending ? "Issuing…" : "Reset password"}
          </Button>
          <Button type="button" variant="secondary" data-confirm-cancel="" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}

/**
 * A temporary password, shown once: what happened, the password, Copy, and
 * Done. Focus moves here when it appears. It is dropped from the screen if
 * the page is left, so the Back button cannot bring it back.
 */
function IssuedPassword({ state, onDone }: { state: CollegeActionState; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const left = usePageLeft();
  const heading = useRef<HTMLParagraphElement>(null);
  useEffect(() => heading.current?.focus(), []);
  const password = state.password ?? "";

  return (
    <div role="status" className="flex flex-col gap-2 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-3">
      {state.message ? <p className="text-sm text-emerald-900">{state.message}</p> : null}
      <p ref={heading} tabIndex={-1} className="text-sm font-medium text-emerald-900 outline-none">
        {state.passwordLabel ?? "Temporary password"}
      </p>
      {left ? (
        <p className="text-sm text-neutral-700">No longer shown. Reset the password again if it was not saved.</p>
      ) : (
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
      )}
      {state.passwordNote ? <p className="text-xs text-emerald-900">{state.passwordNote}</p> : null}
      <div>
        <Button type="button" variant="secondary" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-xs uppercase tracking-wide text-neutral-500">{label}</dt>
      <dd className="flex flex-wrap items-center gap-1 text-neutral-900">{children}</dd>
    </div>
  );
}
