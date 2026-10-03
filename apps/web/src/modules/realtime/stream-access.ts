import { getSessionUserByRawToken } from "@/modules/auth-tenancy/service";
import { requireCohortAccess } from "@/modules/authorization/cohort-access";
import { hasPermission, requireSameInstitution } from "@/modules/authorization/service";
import { ForbiddenError } from "@/modules/authorization/types";

/**
 * Whether a session may still watch one register's live channel.
 *
 * The connect-time checks of /api/realtime/attendance/[sessionId], asked
 * again of a stream that is already open. Every page and Server Action is
 * authorized afresh on each request, from the database; a stream is one
 * request that lasts as long as the tab. Without asking again, an account
 * switched off — or a receptionist whose attendance access the principal just
 * removed — would go on receiving the class's corrections until the tab
 * closed. With it, the stream ends within one interval, the client's
 * reconnect meets the full checks, and a 403 there stops it for good
 * (use-live-stream.ts).
 */
export const STREAM_REAUTHORIZE_INTERVAL_MS = 60_000;

export async function mayWatchRegister(
  rawToken: string | undefined,
  register: { institutionId: string; cohortId: string },
): Promise<boolean> {
  const user = rawToken ? await getSessionUserByRawToken(rawToken) : null;
  // `getCurrentUser`'s rule as well: a password somebody else issued is
  // replaced before the account reaches anything.
  if (!user || user.mustChangePassword) return false;
  if (!hasPermission(user, "attendanceRecord.read")) return false;
  try {
    requireSameInstitution(user, register.institutionId);
    await requireCohortAccess(user, register.cohortId);
    return true;
  } catch (error) {
    if (error instanceof ForbiddenError) return false;
    throw error;
  }
}
