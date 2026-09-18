import type { Student } from "@prisma/client";

export type { Student };

export function studentDisplayName(student: Pick<Student, "firstName" | "lastName">): string {
  return `${student.firstName} ${student.lastName}`.trim();
}
