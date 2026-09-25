import { Prisma } from "@prisma/client";

/**
 * # Which face templates may take part in NEW recognition
 *
 * One rule, applied inside every query that can put a template in front of a
 * recogniser or a duplicate check — in SQL, so an ineligible vector is never
 * loaded and never takes a candidate slot:
 *
 * 1. **The template is live**: `FaceEmbedding.isActive`. Retired templates
 *    (replaced, withdrawn, removed by retention, retired with the student) and
 *    deleted ones are out.
 * 2. **The student is on roll**: `Student.status = 'ACTIVE'`. A student is
 *    never deleted in this product — "delete" in the directory archives them
 *    (INACTIVE, TRANSFERRED, COMPLETED), and their registers stay. Archiving
 *    ends recognition at once, with no data change: restoring the student
 *    brings their templates back, as it brings them back on roll.
 * 3. **One tenant**: the template, the student and the class belong to the
 *    same institution. Enforced by column equality, not assumed from the
 *    joins, so a mis-linked row cannot carry a student into another
 *    institution's classroom.
 * 4. **In scope**: an ACTIVE enrollment in the session's class (and, for a
 *    subject session, the subject) — each loader's own join.
 * 5. **Comparable**: the running model's name and version — each loader's own
 *    filter.
 *
 * Historical records are a different question, answered elsewhere: an
 * archived student's attendance, audit rows and retired templates all remain.
 * None of them makes the student eligible again.
 *
 * There is no cache anywhere between this rule and a recognition run: the web
 * app reads the database on every run and face-ai holds no templates, so a
 * change that has committed applies to the next run on every instance.
 */
export const RECOGNITION_ELIGIBLE_STUDENT_STATUS = "ACTIVE" as const;

/**
 * Rules 1-3 for a raw query that aliases `FaceEmbedding` as `fe`: joins the
 * owning student as `s`. Rules 4 and 5 stay in each query.
 */
export const ELIGIBLE_TEMPLATE_STUDENT_JOIN = Prisma.sql`
    INNER JOIN "Student" s
      ON s.id = fe."studentId"
     AND s.status = 'ACTIVE'
     AND s."institutionId" = fe."institutionId"`;

/**
 * Rules 1 and 2 as a Prisma filter, for the queries written with the client.
 * Rule 3's column equality cannot be expressed in a Prisma `where`; those
 * queries are institution-scoped by their callers.
 */
export const ELIGIBLE_TEMPLATE_WHERE = {
  isActive: true,
  student: { status: RECOGNITION_ELIGIBLE_STUDENT_STATUS },
} satisfies Prisma.FaceEmbeddingWhereInput;
