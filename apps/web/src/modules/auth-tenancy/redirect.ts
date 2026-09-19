// Where somebody lands after signing in.
//
// The `?next=` parameter exists so that a session expiring mid-task returns
// the user to the page they were on rather than dumping them at the dashboard
// — but it is a URL under an attacker's control, and "redirect to whatever the
// query string says" is an open redirect. Everything here is about refusing
// anything that is not a plain, same-origin path on this app.
//
// Pure and dependency-free so the refusals can be unit-tested directly; see
// redirect.test.ts. Both ends validate: the login page sanitises what it puts
// in the hidden field, and the Server Action sanitises again before
// redirecting, because the form body is just as forgeable as the URL.

export const DEFAULT_POST_LOGIN_PATH = "/dashboard";

/**
 * Header the proxy uses to tell a Server Component which path is being
 * rendered, since there is no other way to ask.
 *
 * Treated as untrusted on the way out: the proxy overwrites it on every route
 * it matches, but nothing stops a client sending it to a route the proxy does
 * not, so every reader passes it through `safeNextPath`.
 */
export const REQUESTED_PATH_HEADER = "x-requested-path";

/** Paths it makes no sense to bounce back to — they would loop or re-refuse. */
const NEVER_RETURN_TO = ["/login", "/logout", "/unauthorized"];

/**
 * A same-origin path safe to redirect to, or `DEFAULT_POST_LOGIN_PATH`.
 *
 * Never throws and never returns the caller's string unchanged unless it
 * passed every check, so a caller cannot accidentally use an unvalidated
 * value by ignoring an error.
 */
export function safeNextPath(candidate: string | null | undefined): string {
  if (typeof candidate !== "string" || candidate.length === 0) {
    return DEFAULT_POST_LOGIN_PATH;
  }

  // An absolute path and nothing else. This is what rejects "https://evil.com",
  // "javascript:alert(1)" and any other scheme outright.
  if (!candidate.startsWith("/")) return DEFAULT_POST_LOGIN_PATH;

  // "//evil.com" is a protocol-relative URL, not a path — it leaves the site.
  if (candidate.startsWith("//")) return DEFAULT_POST_LOGIN_PATH;

  // Browsers normalise backslashes to forward slashes in URLs, so "/\evil.com"
  // reaches the same place "//evil.com" does. Refuse the character entirely
  // rather than try to predict which normalisation applies.
  if (candidate.includes("\\")) return DEFAULT_POST_LOGIN_PATH;

  // Control characters (including the CR/LF that a header-splitting attempt
  // would carry) and whitespace have no business in a path we generated.
  if (/[\u0000-\u001f\u007f\s]/.test(candidate)) return DEFAULT_POST_LOGIN_PATH;

  const pathname = candidate.split(/[?#]/)[0];
  if (NEVER_RETURN_TO.includes(pathname)) return DEFAULT_POST_LOGIN_PATH;

  return candidate;
}

/**
 * The sign-in URL to send somebody to who was trying to reach `requestedPath`.
 *
 * Sanitises first, so a caller cannot hand an unvalidated string straight into
 * a redirect. A request for the default destination — or for nothing
 * identifiable — gets a bare `/login`, since `?next=/dashboard` only restates
 * where the login page already goes.
 */
export function loginPathFor(requestedPath: string | null | undefined): string {
  const next = safeNextPath(requestedPath);
  if (next === DEFAULT_POST_LOGIN_PATH) return "/login";
  return `/login?next=${encodeURIComponent(next)}`;
}
