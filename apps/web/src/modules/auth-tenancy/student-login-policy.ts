// The rules a student account signs in by, kept where a test can reach them.
//
// Import-free, like `session-policy.ts`: the service that applies these reaches
// for Prisma and the validated environment when it loads, and the rules are
// the part worth testing on their own.
//
// ## Signing in with a student ID
//
// A student signs in with the ID their school already gives them — the
// student code, "013" — not an email address, which many students do not
// have. A student code is unique within one institution only, and a login must
// resolve to exactly one account, so a student ID is always read together with
// the institution it belongs to: the school's student sign-in link carries it
// (`/login?school=<institution id>`), and a browser that has signed in that way
// remembers it. Nothing here lets a student ID reach an account in another
// institution.
//
// ## The account's email column
//
// `User.email` is required and unique. A student with no email address still
// needs a value there, so their account gets `student-<student id>@students.invalid`
// — unique because the student id is, and undeliverable by definition: `.invalid`
// is reserved (RFC 2606) and can never be a real address. It is never shown and
// never accepted as a sign-in email; the student ID is the way in.

/** Reserved-domain suffix for accounts whose student has no email address. */
export const PLACEHOLDER_EMAIL_DOMAIN = "students.invalid";

/** The account email for a student with no address of their own. */
export function placeholderLoginEmail(studentId: string): string {
  return `student-${studentId.toLowerCase()}@${PLACEHOLDER_EMAIL_DOMAIN}`;
}

/** Whether an account's email is a stand-in rather than an address. */
export function isPlaceholderLoginEmail(email: string): boolean {
  return email.trim().toLowerCase().endsWith(`@${PLACEHOLDER_EMAIL_DOMAIN}`);
}

/**
 * A student ID as typed, trimmed, or null if it cannot be one: empty, longer
 * than any student code, or carrying whitespace or control characters inside.
 */
export function normalizeStudentId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (value.length === 0 || value.length > 64) return null;
  if (/[\s\u0000-\u001f\u007f]/.test(value)) return null;
  return value;
}

/**
 * Which of an institution's students a typed ID means, or null.
 *
 * The lookup ignores case, because "gw8a001" typed on a phone means
 * "GW8A001"; but case can, in principle, be all that separates two codes, so
 * an exact match wins, and more than one inexact match means none — a student
 * ID must lead to exactly one account or to nothing.
 */
export function pickByStudentCode<T extends { studentCode: string }>(
  typed: string,
  candidates: readonly T[],
): T | null {
  const exact = candidates.filter((candidate) => candidate.studentCode === typed);
  if (exact.length === 1) return exact[0];
  return candidates.length === 1 ? candidates[0] : null;
}

/**
 * An institution id as it appears in a student sign-in link, or null. Only
 * the shape is checked here — whether it names an institution is the page's
 * question, asked of the database.
 */
export function normalizeSchoolId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  return /^[A-Za-z0-9_-]{8,64}$/.test(value) ? value : null;
}

/**
 * Failed student-ID sign-ins allowed per account within the window before
 * further attempts are refused unchecked. A student ID is short and often
 * sequential, so it is easy to guess; this is what keeps a guessable ID from
 * becoming a guessable account. Counted from the `auth.login.failure` rows the
 * sign-in already writes, so there is no second store to keep in step.
 */
export const STUDENT_LOGIN_THROTTLE = { maxFailures: 10, windowMs: 15 * 60 * 1000 } as const;

export function isThrottled(recentFailures: number): boolean {
  return recentFailures >= STUDENT_LOGIN_THROTTLE.maxFailures;
}

/** Bounds on a password a student chooses for themselves. */
export const PASSWORD_RULES = { minLength: 8, maxLength: 128 } as const;

/**
 * Why a new password cannot be used, or null if it can.
 *
 * Deliberately short: long enough to resist guessing, not a composition
 * puzzle. The ID is refused because it is printed next to the password on
 * every hand-out sheet.
 */
export function newPasswordProblem(input: {
  current: string;
  next: string;
  confirm: string;
  loginId?: string | null;
}): string | null {
  const { current, next, confirm, loginId } = input;
  if (next.length < PASSWORD_RULES.minLength) {
    return `Use at least ${PASSWORD_RULES.minLength} characters.`;
  }
  if (next.length > PASSWORD_RULES.maxLength) {
    return `Use ${PASSWORD_RULES.maxLength} characters or fewer.`;
  }
  if (next.trim().length === 0) return "A password cannot be only spaces.";
  if (next !== confirm) return "The new password and its confirmation do not match.";
  if (next === current) return "Choose a password different from the current one.";
  if (loginId && next.trim().toLowerCase() === loginId.trim().toLowerCase()) {
    return "A password cannot be the same as the student ID.";
  }
  return null;
}

/** The cookie a browser keeps to remember which school's student sign-in it used. */
export const SCHOOL_COOKIE_NAME = "attendance_school";
