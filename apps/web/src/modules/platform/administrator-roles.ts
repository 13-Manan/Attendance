/**
 * The administrator role vocabulary, with no server dependency.
 *
 * Split out from `administrators.ts` because the form that offers these roles
 * is a client component, and `administrators.ts` reaches Prisma, `node:crypto`
 * and the audit service. Importing a *value* from it into the browser bundle
 * drags all of that with it, and the failure is not a helpful one — Node's
 * `promisify` lands in the browser and throws `The "original" argument must be
 * of type Function` from inside a render, which names nothing involved.
 *
 * A type-only import would have been erased and been fine. The allow-list has
 * to exist at runtime in both places, so it lives here instead: server code
 * validates against it, the form renders the options from it, and there is one
 * list rather than two that can drift.
 */

/**
 * The three roles the platform administrator workflow may grant.
 *
 * All three carry exactly `ADMIN_PERMISSIONS` — the difference is what an
 * administrator is called in a school versus a college, which matters on
 * screen and in an audit log.
 *
 * PLATFORM_SUPER_ADMIN is absent and must stay absent: this is the list that
 * decides what a platform user can hand to somebody inside a tenant, and a
 * platform role handed downward would put a second platform user in existence
 * without anyone intending it. The staff and student roles are absent too —
 * those are created inside the institution, by its own administrator.
 */
export const GRANTABLE_ADMIN_ROLES = [
  "INSTITUTION_ADMIN",
  "SCHOOL_ADMIN",
  "COLLEGE_ADMIN",
] as const;

export type GrantableAdminRole = (typeof GRANTABLE_ADMIN_ROLES)[number];

/**
 * What a given institution type is offered first. Both other roles remain
 * available: an institution may prefer the generic title, and nothing behind
 * the three differs.
 */
export function defaultAdminRoleFor(type: "SCHOOL" | "COLLEGE"): GrantableAdminRole {
  return type === "COLLEGE" ? "COLLEGE_ADMIN" : "SCHOOL_ADMIN";
}

/** One administrator, as the platform tier displays them. Carries no secret. */
export interface InstitutionAdministrator {
  id: string;
  name: string;
  email: string;
  status: "ACTIVE" | "INACTIVE";
  roleKeys: string[];
  institutionId: string | null;
  createdAt: string;
}
