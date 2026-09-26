import { prisma } from "@/lib/prisma";

const USER_WITH_ROLES_INCLUDE = {
  roleAssignments: {
    include: { role: { include: { permissions: true } } },
  },
  // Only what sign-in and the per-request session check need: whether this is
  // a student's account, and whether that student is still on roll.
  studentProfile: { select: { id: true, status: true, institutionId: true, studentCode: true } },
} as const;

export function findUserByEmail(email: string) {
  return prisma.user.findUnique({
    where: { email },
    include: USER_WITH_ROLES_INCLUDE,
  });
}

export function findActiveSessionByTokenHash(tokenHash: string) {
  return prisma.session.findUnique({
    where: { tokenHash },
    include: { user: { include: USER_WITH_ROLES_INCLUDE } },
  });
}

/**
 * The student accounts in one institution whose student code reads as `code`,
 * ignoring case — at most three, which is enough to tell "exactly one" from
 * "ambiguous". Scoped by institution first: a student ID never reaches another
 * institution's student.
 */
export function findStudentAccountsByCode(institutionId: string, code: string) {
  return prisma.student.findMany({
    where: {
      institutionId,
      userId: { not: null },
      studentCode: { equals: code, mode: "insensitive" },
    },
    select: {
      id: true,
      studentCode: true,
      status: true,
      user: { include: USER_WITH_ROLES_INCLUDE },
    },
    take: 3,
  });
}

/** Failed sign-ins recorded against one account since `since`. */
export function countRecentLoginFailures(userId: string, since: Date) {
  return prisma.auditLog.count({
    where: {
      entityType: "User",
      entityId: userId,
      action: "auth.login.failure",
      createdAt: { gte: since },
    },
  });
}
