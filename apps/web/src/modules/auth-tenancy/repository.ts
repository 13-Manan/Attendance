import { prisma } from "@/lib/prisma";

const USER_WITH_ROLES_INCLUDE = {
  roleAssignments: {
    include: { role: { include: { permissions: true } } },
  },
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
