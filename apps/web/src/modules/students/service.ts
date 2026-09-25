import { prisma } from "@/lib/prisma";
import { recordAuditLog } from "@/modules/audit/service";
import { requirePermission, requireSameInstitution } from "@/modules/authorization/service";
import { requireCohortAccess } from "@/modules/authorization/cohort-access";
import type { SessionUser } from "@/modules/auth-tenancy/types";
import type { EnrollmentStatus } from "@prisma/client";
import { buildEnvelope } from "@/modules/integrations/webhook-delivery";
import { emitWebhookEvent } from "@/modules/integrations/webhook-dispatcher";
import type { WebhookEvent } from "@/modules/integrations/types";
import { listStudentsByCohort as listStudentsByCohortRepo } from "./repository";
import type { Student } from "./types";

/**
 * Notifies subscribed endpoints that a student changed.
 *
 * Three properties, each deliberate:
 *
 * - **After the transaction, never inside it.** A notification emitted inside
 *   `$transaction` would fire for a write that then rolls back, and a
 *   receiver cannot un-create a student.
 * - **Cannot fail the operation.** `emitWebhookEvent` swallows and logs; the
 *   dispatcher retries on its own ladder. A school's ERP being down must not
 *   stop a clerk from admitting a child.
 * - **Injectable.** `deps.emit` lets the service tests assert what was emitted
 *   without a network or a dispatcher, the same way every other dependency in
 *   this module is passed in rather than imported at the call site.
 */
export interface StudentWebhookDeps {
  emit?: (event: WebhookEvent, student: Student) => void;
}

function emitStudentEvent(deps: StudentWebhookDeps, event: WebhookEvent, student: Student): void {
  if (deps.emit) {
    deps.emit(event, student);
    return;
  }
  emitWebhookEvent(
    buildEnvelope(student.institutionId, event, student.id, student.updatedAt.toISOString(), {
      id: student.id,
      studentCode: student.studentCode,
      firstName: student.firstName,
      lastName: student.lastName,
      fullName: [student.firstName, student.lastName].filter(Boolean).join(" "),
      email: student.email,
      phone: student.phone,
      status: student.status,
    }),
  );
}

export interface CreateStudentInput {
  institutionId: string;
  campusId?: string | null;
  studentCode: string;
  firstName: string;
  lastName: string;
  email?: string | null;
  phone?: string | null;
  /**
   * The institution's own admission record, optional at both ends: some
   * institutions issue a number at intake and some use the student code for
   * everything. Absent means "not on file", never "".
   */
  admissionNumber?: string | null;
  admissionDate?: Date | null;
}

/** The only code path that creates a Student — always inside a transaction
 * that also writes the "student.created" audit row. */
export async function createStudent(
  actor: SessionUser,
  input: CreateStudentInput,
  deps: StudentWebhookDeps = {},
): Promise<Student> {
  requirePermission(actor, "student.create");
  requireSameInstitution(actor, input.institutionId);

  const student = await prisma.$transaction(async (tx) => {
    const student = await tx.student.create({ data: input });

    await recordAuditLog(
      {
        action: "student.created",
        entityType: "Student",
        entityId: student.id,
        institutionId: input.institutionId,
        actorUserId: actor.userId,
        afterJson: student,
      },
      tx,
    );

    return student;
  });

  emitStudentEvent(deps, "student.created", student);
  return student;
}

export interface UpdateStudentInput {
  studentId: string;
  studentCode?: string;
  firstName?: string;
  lastName?: string;
  email?: string | null;
  phone?: string | null;
  campusId?: string | null;
  admissionNumber?: string | null;
  admissionDate?: Date | null;
  status?: EnrollmentStatus;
}

/**
 * The audit action for a status change, or an ordinary edit.
 *
 * Picked from the transition rather than from the caller, exactly as the
 * webhook event below is, so the log and the delivery cannot disagree about
 * what happened. A student leaving and a student coming back are questions
 * people actually ask the audit log — "who took this child off the register?"
 * — and answering them should not require diffing two JSON blobs.
 */
function studentAuditAction(
  previousStatus: EnrollmentStatus,
  nextStatus: EnrollmentStatus,
): "student.archived" | "student.restored" | "student.updated" {
  if (previousStatus === "ACTIVE" && nextStatus !== "ACTIVE") return "student.archived";
  if (previousStatus !== "ACTIVE" && nextStatus === "ACTIVE") return "student.restored";
  return "student.updated";
}

export async function updateStudent(
  actor: SessionUser,
  input: UpdateStudentInput,
  deps: StudentWebhookDeps = {},
): Promise<Student> {
  requirePermission(actor, "student.update");

  const { previousStatus, updated } = await prisma.$transaction(async (tx) => {
    const existing = await tx.student.findUniqueOrThrow({ where: { id: input.studentId } });
    requireSameInstitution(actor, existing.institutionId);

    const { studentId, ...data } = input;
    const updated = await tx.student.update({ where: { id: studentId }, data });

    const action = studentAuditAction(existing.status, updated.status);
    await recordAuditLog(
      {
        action,
        entityType: "Student",
        entityId: updated.id,
        institutionId: existing.institutionId,
        actorUserId: actor.userId,
        beforeJson: existing,
        afterJson: updated,
      },
      tx,
    );

    // Archiving ends recognition and restoring resumes it, with no change to
    // the templates: eligibility reads the student's status on every run
    // (modules/recognition-results/eligibility.ts). Said by name in the same
    // transaction, so the log cannot record one without the other.
    if (action !== "student.updated") {
      const liveTemplates = await tx.faceEmbedding.count({
        where: { studentId: updated.id, isActive: true },
      });
      if (liveTemplates > 0) {
        await recordAuditLog(
          {
            action:
              action === "student.archived"
                ? "face_enrollment.eligibility_revoked"
                : "face_enrollment.eligibility_restored",
            entityType: "Student",
            entityId: updated.id,
            institutionId: existing.institutionId,
            actorUserId: actor.userId,
            afterJson: {
              studentId: updated.id,
              studentStatus: updated.status,
              liveTemplates,
              recognitionEligible: updated.status === "ACTIVE",
            },
          },
          tx,
        );
      }
    }

    return { previousStatus: existing.status, updated };
  });

  // Most-specific event wins, one per change. A student leaving is the fact
  // downstream systems act on — a library revokes a card, a transport route
  // drops a stop — so it is not left for a receiver to infer by diffing a
  // generic update. Emitting both would double every delivery for an endpoint
  // subscribed to the pair.
  const deactivated = previousStatus === "ACTIVE" && updated.status !== "ACTIVE";
  emitStudentEvent(deps, deactivated ? "student.deactivated" : "student.updated", updated);
  return updated;
}

export interface ListStudentsForCohortDeps {
  listStudentsByCohort?: (cohortId: string) => Promise<Student[]>;
  checkCohortAccess?: (user: SessionUser, cohortId: string) => Promise<void>;
}

/**
 * The authorization boundary behind "college class only sees enrolled
 * students," "school student cannot appear in another institution," and
 * "faculty only sees assigned classes": requireSameInstitution and cohort
 * access are both checked BEFORE the injected repository call, so every
 * denial case is provable without a database (see service.test.ts). The
 * repository call itself (modules/students/repository.ts#listStudentsByCohort)
 * already scopes to active Enrollment rows for that one cohort — there is no
 * function anywhere in this codebase that lists students without a cohort
 * or institution scope.
 */
export async function listStudentsForCohortRequest(
  actor: SessionUser,
  params: { cohortId: string; institutionId: string },
  deps: ListStudentsForCohortDeps = {},
): Promise<Student[]> {
  requirePermission(actor, "student.read");
  requireSameInstitution(actor, params.institutionId);

  const checkAccess = deps.checkCohortAccess ?? requireCohortAccess;
  await checkAccess(actor, params.cohortId);

  const listStudents = deps.listStudentsByCohort ?? listStudentsByCohortRepo;
  return listStudents(params.cohortId);
}
