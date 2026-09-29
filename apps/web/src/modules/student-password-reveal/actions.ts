"use server";

import { z } from "zod";
import { requestMetadata, requireUser } from "@/modules/auth-tenancy/session";
import { revealStudentPassword } from "./service";

/**
 * "Show current password", from a student's page on the staff side.
 *
 * A boundary only: the session, one student id, the service's answer. The
 * password travels in this action's response and nowhere else — never in a
 * page's props or its HTML, a URL, a cookie or storage — and Next.js marks
 * every Server Action response `Cache-Control: no-store`. A session that must
 * still change its own password never reaches here (`requireUser`), and any
 * other field a request carries is dropped by the schema.
 */

export type RevealPasswordResult =
  | { ok: true; password: string }
  | { ok: false; unavailable: boolean; message: string };

const revealSchema = z.object({ studentId: z.string().min(1).max(64) });

export async function revealStudentPasswordAction(input: unknown): Promise<RevealPasswordResult> {
  const actor = await requireUser();
  const parsed = revealSchema.safeParse(input);
  const outcome = await revealStudentPassword(actor, parsed.success ? parsed.data.studentId : "", await requestMetadata());
  if (outcome.status === "revealed") return { ok: true, password: outcome.password };
  if (outcome.status === "unavailable") {
    return { ok: false, unavailable: true, message: "Password recovery information is not available." };
  }
  return { ok: false, unavailable: false, message: outcome.message };
}
