"use server";

import { z } from "zod";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { hasPermission } from "@/modules/authorization/service";
import {
  changeOwnPasswordService,
  loginService,
  loginWithStudentIdService,
  logoutService,
  type LoginResult,
} from "./service";
import { DEFAULT_POST_LOGIN_PATH, safeNextPath } from "./redirect";
import { SESSION_COOKIE_NAME, SESSION_COOKIE_OPTIONS, requireUser } from "./session";
import {
  SCHOOL_COOKIE_NAME,
  STUDENT_LOGIN_THROTTLE,
  normalizeSchoolId,
  normalizeStudentId,
} from "./student-login-policy";

/**
 * What the login form renders.
 *
 * `kind` exists because the two failures need different words and different
 * affordances: "incorrect password" asks the user to change what they typed,
 * "the service is down" asks them to change nothing and try again. Collapsing
 * both into one red line tells somebody their password is wrong when it isn't.
 */
export interface LoginState {
  error?: string;
  kind?: "invalid" | "unavailable";
  /**
   * The address that was submitted, echoed back so a failed attempt does not
   * make the user retype it. Only ever their own input, returned to their own
   * browser — it reveals nothing they did not just type.
   */
  email?: string;
  /** The student ID that was submitted, echoed back the same way. */
  studentId?: string;
  /**
   * Counts submissions. React resets a form when its action completes, so the
   * field needs a changing `key` to be remounted with the value above —
   * otherwise a second failure with the same address would not re-fill it.
   */
  attempt?: number;
}

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

/** Bounded because it is rendered back into the page; 320 is the practical
 *  ceiling for an address (RFC 3696 erratum: 64 local + @ + 255 domain). */
function submittedEmail(formData: FormData): string {
  return String(formData.get("email") ?? "").slice(0, 320);
}

async function requestContext() {
  const headerStore = await headers();
  return {
    ipAddress: headerStore.get("x-forwarded-for"),
    userAgent: headerStore.get("user-agent"),
  };
}

export async function login(prevState: LoginState, formData: FormData): Promise<LoginState> {
  const attempt = (prevState.attempt ?? 0) + 1;

  // A student sign-in link carries the institution; the student ID is read
  // within it. Without one, this is the email sign-in it always was.
  const school = normalizeSchoolId(formData.get("school"));
  if (school) return studentLogin(formData, school, attempt);

  const email = submittedEmail(formData);

  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    // Somebody typing "013" here is a student or parent on the staff form.
    const typedId = email.trim() !== "" && !email.includes("@");
    return {
      error: typedId
        ? "Students and parents sign in with the student ID on their school's student sign-in link."
        : "Enter a valid email and password.",
      kind: "invalid",
      email,
      attempt,
    };
  }

  // Re-sanitised here and not merely on the page that rendered the field: a
  // form body is as forgeable as a query string, so the value arriving back
  // has proven nothing by having been in a hidden input.
  const next = safeNextPath(formData.get("next")?.toString());

  let result: LoginResult;
  try {
    result = await loginService(parsed.data.email, parsed.data.password, await requestContext());
  } catch (error) {
    // The database, or anything else this depends on, is unreachable. Without
    // this the Server Action rejects and React shows the generic error
    // boundary — which reads, to the person in front of it, exactly like the
    // app being broken rather than temporarily unavailable.
    console.error("auth: login could not be attempted", error);
    return {
      error: "We can't sign you in right now. The service is unavailable — please try again.",
      kind: "unavailable",
      email,
      attempt,
    };
  }

  if (!result.ok) {
    return {
      error:
        result.reason === "account_inactive"
          ? "This account is inactive. Contact your administrator."
          : "Incorrect email or password.",
      kind: "invalid",
      email,
      attempt,
    };
  }

  (await cookies()).set(SESSION_COOKIE_NAME, result.rawToken, SESSION_COOKIE_OPTIONS);
  // Outside the try/catch above on purpose: redirect() signals by throwing,
  // and catching it here would turn a successful login into "unavailable".
  redirect(next);
}

/** How long a browser remembers the school it last signed a student in to. */
const SCHOOL_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 400;

async function studentLogin(formData: FormData, school: string, attempt: number): Promise<LoginState> {
  const typed = String(formData.get("studentId") ?? "").slice(0, 64);
  const studentId = normalizeStudentId(typed);
  const password = String(formData.get("password") ?? "");
  if (!studentId || password.length === 0) {
    return { error: "Enter your student ID and password.", kind: "invalid", studentId: typed, attempt };
  }

  const next = safeNextPath(formData.get("next")?.toString());

  let result: LoginResult;
  try {
    result = await loginWithStudentIdService(school, studentId, password, await requestContext());
  } catch (error) {
    console.error("auth: student login could not be attempted", error);
    return {
      error: "We can't sign you in right now. The service is unavailable — please try again.",
      kind: "unavailable",
      studentId: typed,
      attempt,
    };
  }

  if (!result.ok) {
    const minutes = STUDENT_LOGIN_THROTTLE.windowMs / 60_000;
    return {
      error:
        result.reason === "throttled"
          ? `Too many attempts. Wait ${minutes} minutes and try again, or ask your school for a new password.`
          : result.reason === "account_inactive"
            ? "This student account is not active. Contact your school."
            : "Incorrect student ID or password.",
      kind: "invalid",
      studentId: typed,
      attempt,
    };
  }

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE_NAME, result.rawToken, SESSION_COOKIE_OPTIONS);
  // Not a credential — which school's sign-in to show next time, so a parent
  // whose session has lapsed is asked for the student ID again rather than
  // for an email address they were never given.
  cookieStore.set(SCHOOL_COOKIE_NAME, school, {
    ...SESSION_COOKIE_OPTIONS,
    maxAge: SCHOOL_COOKIE_MAX_AGE_SECONDS,
  });
  redirect(next === DEFAULT_POST_LOGIN_PATH ? "/portal" : next);
}

export interface ChangePasswordState {
  error?: string;
  /** Set once the password has changed; how many other devices were signed out. */
  changed?: { otherSessionsEnded: number };
  attempt?: number;
}

/**
 * A student — or a parent using the student's account — replacing its
 * password. Only a student account may: the staff screens have no
 * self-service change, and this does not add one by the back door.
 */
export async function changePasswordAction(
  prevState: ChangePasswordState,
  formData: FormData,
): Promise<ChangePasswordState> {
  const attempt = (prevState.attempt ?? 0) + 1;
  const user = await requireUser();
  if (!hasPermission(user, "student.read.own")) redirect("/unauthorized");

  const rawToken = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  if (!rawToken) redirect("/login");

  const result = await changeOwnPasswordService(user.userId, rawToken, {
    current: String(formData.get("currentPassword") ?? ""),
    next: String(formData.get("newPassword") ?? ""),
    confirm: String(formData.get("confirmPassword") ?? ""),
  });
  if (!result.ok) return { error: result.error, attempt };
  return { changed: { otherSessionsEnded: result.otherSessionsEnded }, attempt };
}

export async function logout(): Promise<void> {
  const cookieStore = await cookies();
  const rawToken = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (rawToken) {
    try {
      await logoutService(rawToken);
    } catch (error) {
      // The cookie is dropped below regardless. A logout that fails to revoke
      // the row server-side must still end the session in this browser —
      // leaving somebody signed in because the database hiccuped is the worse
      // of the two outcomes. The orphaned row expires on its own.
      console.error("auth: session could not be revoked server-side", error);
    }
  }
  cookieStore.delete(SESSION_COOKIE_NAME);
  redirect("/login?signedOut=1");
}
