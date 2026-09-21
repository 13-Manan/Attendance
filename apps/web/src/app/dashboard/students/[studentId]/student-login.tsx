"use client";

import { useActionState, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, Panel } from "@/components/ui/panel";
import {
  provisionStudentLoginAction,
  resetStudentLoginAction,
  type StudentLoginFormState,
} from "@/modules/students/directory-actions";
import type { StudentLoginAccount } from "@/modules/students/login-provisioning";

/**
 * The student's own way in.
 *
 * A student row and a login are separate things: most students never need an
 * account, and creating one for every enrolment would be a pile of credentials
 * nobody asked for. So this panel is opt-in, one student at a time, and says
 * plainly what the account can and cannot reach — because "give the student a
 * login" is the point at which somebody reasonably worries what else it opens.
 *
 * The password is shown once, from the action's return value. Reloading the
 * page does not bring it back; there is no stored copy to bring back.
 */

const INITIAL: StudentLoginFormState = { error: null, issued: null };

interface Props {
  studentId: string;
  studentName: string;
  login: StudentLoginAccount | null;
  canManage: boolean;
}

export function StudentLogin({ studentId, studentName, login, canManage }: Props) {
  const [adding, setAdding] = useState(false);
  const [createState, createAction, creating] = useActionState(provisionStudentLoginAction, INITIAL);
  const [resetState, resetAction] = useActionState(resetStudentLoginAction, INITIAL);

  const issued = createState.issued ?? resetState.issued;
  const error = createState.error ?? resetState.error;

  return (
    <Panel
      title="Portal login"
      description={`Whether ${studentName} can sign in to see their own attendance.`}
    >
      {issued ? (
        <div
          role="status"
          className="flex flex-col gap-2 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-3"
        >
          <p className="text-sm font-medium text-emerald-900">
            Temporary password for {issued.email}
          </p>
          <code className="select-all break-all rounded border border-emerald-200 bg-white px-2 py-1.5 font-mono text-sm text-neutral-900">
            {issued.password}
          </code>
          <p className="text-xs text-emerald-900">{issued.notice}</p>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900">
          {error}
        </p>
      ) : null}

      {login ? (
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-neutral-900">
              {login.email}
              {login.status === "ACTIVE" ? (
                <Badge tone="positive">Active</Badge>
              ) : (
                <Badge tone="neutral">Deactivated</Badge>
              )}
            </p>
            <p className="text-xs text-neutral-500">
              Signs in to the student portal only — their own attendance and
              nothing else.
            </p>
          </div>
          {canManage ? (
            <form action={resetAction}>
              <input type="hidden" name="studentId" value={studentId} />
              <input type="hidden" name="email" value={login.email} />
              <Button type="submit" variant="secondary">
                Issue new password
              </Button>
            </form>
          ) : null}
        </div>
      ) : (
        <EmptyState>
          This student has no login. They appear on registers and in reports
          either way — an account only lets them see their own attendance.
        </EmptyState>
      )}

      {!login && canManage ? (
        adding ? (
          <form action={createAction} className="flex flex-col gap-3">
            <input type="hidden" name="studentId" value={studentId} />
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-neutral-600">
                Email the student will sign in with
              </span>
              <input
                name="email"
                type="email"
                required
                maxLength={255}
                autoComplete="off"
                className="rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-900 focus:border-neutral-900 focus:outline-none sm:max-w-sm"
              />
            </label>
            <p className="text-xs text-neutral-500">
              The account receives the STUDENT role: their own attendance, their
              own record, and face enrollment for themselves. It cannot open any
              staff screen or read another student.
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
    </Panel>
  );
}
