"use client";

import { useActionState, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, Panel } from "@/components/ui/panel";
import { formatSessionDate } from "@/components/ui/attendance-stat";
import {
  createInstitutionAdministratorAction,
  resetAdministratorPasswordAction,
  setAdministratorStatusAction,
  type AdministratorFormState,
} from "@/modules/platform/actions";
import {
  GRANTABLE_ADMIN_ROLES,
  type InstitutionAdministrator,
} from "@/modules/platform/administrator-roles";

/**
 * The administrators of one institution, managed from the platform tier.
 *
 * This is the only screen that can put an administrator inside a tenant, and
 * it exists here rather than in the tenant because of the ordering problem it
 * solves: a brand-new institution has nobody in it, so there is no one inside
 * to do the inviting. Everything *below* an administrator — teachers,
 * students, classes — is created by that administrator on their own screens,
 * which is why this panel stops at administrators and links onward rather than
 * growing a second copy of the faculty directory.
 *
 * The temporary password is rendered once, from the action's return value. It
 * is never in the URL, never re-fetchable, and disappears on the next
 * interaction — so a shoulder-surfed screen is the only way it leaks, and the
 * notice beside it says exactly that.
 */

const INITIAL: AdministratorFormState = { error: null, issued: null };

interface Props {
  institutionId: string;
  institutionName: string;
  institutionType: "SCHOOL" | "COLLEGE";
  defaultRoleKey: string;
  administrators: InstitutionAdministrator[];
}

export function Administrators({
  institutionId,
  institutionName,
  institutionType,
  defaultRoleKey,
  administrators,
}: Props) {
  const [adding, setAdding] = useState(false);
  const [createState, createAction, creating] = useActionState(
    createInstitutionAdministratorAction,
    INITIAL,
  );
  const [resetState, resetAction] = useActionState(resetAdministratorPasswordAction, INITIAL);
  const [statusState, statusAction] = useActionState(setAdministratorStatusAction, INITIAL);

  // Whichever action last produced one. Only one can be present at a time —
  // each action resets the others' state by re-rendering from its own.
  const issued = createState.issued ?? resetState.issued;
  const error = createState.error ?? resetState.error ?? statusState.error;

  return (
    <Panel
      title="Administrators"
      description={`Who may administer ${institutionName}. Only the platform tier can add one.`}
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

      {administrators.length === 0 ? (
        <EmptyState>
          This institution has no administrator yet, so nobody can sign in and
          set it up. Add one below — they can then create teachers, students
          and the academic structure themselves.
        </EmptyState>
      ) : (
        <ul className="flex flex-col divide-y divide-neutral-100">
          {administrators.map((admin) => (
            <li key={admin.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-neutral-900">
                  {admin.name}
                  {admin.status === "ACTIVE" ? (
                    <Badge tone="positive">Active</Badge>
                  ) : (
                    <Badge tone="neutral">Deactivated</Badge>
                  )}
                </p>
                <p className="truncate text-xs text-neutral-500">{admin.email}</p>
                <p className="text-xs text-neutral-500">
                  {admin.roleKeys.join(", ")} · added {formatSessionDate(admin.createdAt)}
                </p>
              </div>

              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <form action={resetAction}>
                  <input type="hidden" name="institutionId" value={institutionId} />
                  <input type="hidden" name="userId" value={admin.id} />
                  <input type="hidden" name="email" value={admin.email} />
                  <Button type="submit" variant="secondary">
                    Issue new password
                  </Button>
                </form>
                <form action={statusAction}>
                  <input type="hidden" name="institutionId" value={institutionId} />
                  <input type="hidden" name="userId" value={admin.id} />
                  <input type="hidden" name="active" value={admin.status === "ACTIVE" ? "false" : "true"} />
                  <Button type="submit" variant="secondary">
                    {admin.status === "ACTIVE" ? "Deactivate" : "Reactivate"}
                  </Button>
                </form>
              </div>
            </li>
          ))}
        </ul>
      )}

      {adding ? (
        <form action={createAction} className="flex flex-col gap-3 border-t border-neutral-200 pt-4">
          <input type="hidden" name="institutionId" value={institutionId} />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-neutral-600">Full name</span>
              <input
                name="name"
                required
                maxLength={120}
                autoComplete="off"
                className="rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-900 focus:border-neutral-900 focus:outline-none"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-neutral-600">Email</span>
              <input
                name="email"
                type="email"
                required
                maxLength={255}
                autoComplete="off"
                className="rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-900 focus:border-neutral-900 focus:outline-none"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-neutral-600">Role</span>
              <select
                name="roleKey"
                defaultValue={defaultRoleKey}
                className="rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-900 focus:border-neutral-900 focus:outline-none"
              >
                {GRANTABLE_ADMIN_ROLES.map((key) => (
                  <option key={key} value={key}>
                    {key}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="text-xs text-neutral-500">
            All three roles carry the same permissions inside{" "}
            {institutionType === "COLLEGE" ? "a college" : "a school"} — the
            difference is what the administrator is called on screen and in the
            audit log. They receive no platform-level access and cannot reach
            another institution.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={creating}>
              {creating ? "Adding…" : "Add administrator"}
            </Button>
            <Button type="button" variant="secondary" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div>
          <Button type="button" onClick={() => setAdding(true)}>
            Add administrator
          </Button>
        </div>
      )}
    </Panel>
  );
}
