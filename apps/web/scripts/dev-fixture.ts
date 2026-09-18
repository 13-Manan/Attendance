/**
 * Development fixture — demo tenants, logins and rosters for manual testing.
 *
 * This is NOT `prisma/seed.ts`, which creates only the platform roles and
 * permission grants, and NOT `scripts/bootstrap-production.ts`, which is how
 * those same roles — and the first institution and administrator — reach a
 * production database. This file creates fake institutions, staff accounts and
 * students, and must never touch a production database — hence the localhost
 * guard below. docs/DATABASE_OPERATIONS.md §4 sets the four apart.
 *
 * It deliberately creates NO FaceEmbedding rows. Biometric templates are never
 * faked (ADR-0008); enrol a face through the UI against the mock face-ai
 * backend if you need one.
 *
 * Run:
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5433/attendance_dev \
 *     node --import ./scripts/register-test-loader.mjs scripts/dev-fixture.ts
 *
 * Idempotent: re-running converges rather than duplicating.
 */

export {}; // top-level await needs this file to be a module

const DEV_PASSWORD = "Password123!";

const url = process.env.DATABASE_URL ?? "";
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url)) {
  console.error("Refusing to run: DATABASE_URL does not point at localhost.");
  process.exit(1);
}

const { prisma } = await import("@/lib/prisma");
const { hashPassword } = await import("@/modules/auth-tenancy/password");

const passwordHash = await hashPassword(DEV_PASSWORD);

async function roleId(key: string, institutionId: string | null) {
  const role = await prisma.role.findFirst({ where: { key, institutionId } });
  if (!role) throw new Error(`Role ${key} not found — run \`npm run prisma:seed\` first.`);
  return role.id;
}

async function makeUser(opts: {
  email: string;
  name: string;
  institutionId: string | null;
  roleKey: string;
  employeeCode?: string;
}) {
  const user = await prisma.user.upsert({
    where: { email: opts.email },
    update: { name: opts.name, institutionId: opts.institutionId, passwordHash, status: "ACTIVE" },
    create: {
      email: opts.email,
      name: opts.name,
      institutionId: opts.institutionId,
      employeeCode: opts.employeeCode,
      passwordHash,
      status: "ACTIVE",
    },
  });

  const rid = await roleId(opts.roleKey, null);
  const existing = await prisma.userRoleAssignment.findFirst({
    where: { userId: user.id, roleId: rid, institutionId: opts.institutionId, campusId: null },
  });
  if (!existing) {
    await prisma.userRoleAssignment.create({
      data: { userId: user.id, roleId: rid, institutionId: opts.institutionId },
    });
  }
  return user;
}

async function findOrCreateInstitution(name: string, type: "SCHOOL" | "COLLEGE", settings: object) {
  const found = await prisma.institution.findFirst({ where: { name } });
  if (found) {
    return prisma.institution.update({ where: { id: found.id }, data: { settings, type } });
  }
  return prisma.institution.create({
    data: { name, type, timezone: "Asia/Kolkata", settings },
  });
}

async function findOrCreateUnit(opts: {
  institutionId: string;
  parentId: string | null;
  kind: "DEPARTMENT" | "GRADE" | "SEMESTER" | "COURSE" | "SECTION" | "GENERIC";
  name: string;
  code?: string;
}) {
  const found = await prisma.academicUnit.findFirst({
    where: { institutionId: opts.institutionId, kind: opts.kind, name: opts.name, parentId: opts.parentId },
  });
  if (found) return found;
  return prisma.academicUnit.create({
    data: {
      institutionId: opts.institutionId,
      parentId: opts.parentId,
      kind: opts.kind,
      name: opts.name,
      code: opts.code,
    },
  });
}

async function findOrCreateCohort(opts: {
  institutionId: string;
  academicUnitId: string;
  academicSessionId: string;
  name: string;
  termLabel?: string;
}) {
  const found = await prisma.cohort.findFirst({
    where: { institutionId: opts.institutionId, name: opts.name, academicSessionId: opts.academicSessionId },
  });
  if (found) return found;
  return prisma.cohort.create({ data: opts });
}

async function enrolStudents(opts: {
  institutionId: string;
  cohortId: string;
  codePrefix: string;
  people: Array<[string, string]>;
}) {
  const created = [];
  let n = 0;
  for (const [firstName, lastName] of opts.people) {
    n += 1;
    const code = `${opts.codePrefix}${String(n).padStart(3, "0")}`;
    const student = await prisma.student.upsert({
      where: { institutionId_studentCode: { institutionId: opts.institutionId, studentCode: code } },
      update: { firstName, lastName, status: "ACTIVE" },
      create: {
        institutionId: opts.institutionId,
        studentCode: code,
        firstName,
        lastName,
        email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}@students.example.test`,
        status: "ACTIVE",
      },
    });
    await prisma.enrollment.upsert({
      where: { studentId_cohortId: { studentId: student.id, cohortId: opts.cohortId } },
      update: { status: "ACTIVE" },
      create: {
        institutionId: opts.institutionId,
        studentId: student.id,
        cohortId: opts.cohortId,
        status: "ACTIVE",
      },
    });
    created.push(student);
  }
  return created;
}

// ---------------------------------------------------------------------------
// Platform
// ---------------------------------------------------------------------------

await makeUser({
  email: "superadmin@platform.test",
  name: "Platform Super Admin",
  institutionId: null,
  roleKey: "PLATFORM_SUPER_ADMIN",
});

// ---------------------------------------------------------------------------
// School tenant
// ---------------------------------------------------------------------------

const school = await findOrCreateInstitution("Greenwood High School", "SCHOOL", {
  attendanceMode: "DAILY",
  academicUnitLabels: { grade: "Grade", section: "Section" },
  confidenceThresholds: { presentMin: 0.62, reviewMin: 0.45 },
});

await prisma.campus.upsert({
  where: { institutionId_code: { institutionId: school.id, code: "MAIN" } },
  update: { name: "Main Campus" },
  create: { institutionId: school.id, code: "MAIN", name: "Main Campus", isActive: true },
});

const schoolYear = await prisma.academicSession.upsert({
  where: { institutionId_name: { institutionId: school.id, name: "2026-2027" } },
  update: { isActive: true },
  create: {
    institutionId: school.id,
    name: "2026-2027",
    startDate: new Date("2026-06-01T00:00:00Z"),
    endDate: new Date("2027-03-31T00:00:00Z"),
    isActive: true,
  },
});

const grade8 = await findOrCreateUnit({
  institutionId: school.id,
  parentId: null,
  kind: "GRADE",
  name: "Grade 8",
  code: "G8",
});
const sectionA = await findOrCreateUnit({
  institutionId: school.id,
  parentId: grade8.id,
  kind: "SECTION",
  name: "Section A",
  code: "G8A",
});
const sectionB = await findOrCreateUnit({
  institutionId: school.id,
  parentId: grade8.id,
  kind: "SECTION",
  name: "Section B",
  code: "G8B",
});

const g8a = await findOrCreateCohort({
  institutionId: school.id,
  academicUnitId: sectionA.id,
  academicSessionId: schoolYear.id,
  name: "Grade 8 - Section A",
  termLabel: "2026-2027",
});
const g8b = await findOrCreateCohort({
  institutionId: school.id,
  academicUnitId: sectionB.id,
  academicSessionId: schoolYear.id,
  name: "Grade 8 - Section B",
  termLabel: "2026-2027",
});

await makeUser({
  email: "admin@greenwood.test",
  name: "Anita Deshpande",
  institutionId: school.id,
  roleKey: "INSTITUTION_ADMIN",
  employeeCode: "GW-ADM-01",
});
await makeUser({
  email: "principal@greenwood.test",
  name: "Rajiv Menon",
  institutionId: school.id,
  roleKey: "SCHOOL_ADMIN",
  employeeCode: "GW-ADM-02",
});
const classTeacher = await makeUser({
  email: "classteacher@greenwood.test",
  name: "Priya Nair",
  institutionId: school.id,
  roleKey: "CLASS_TEACHER",
  employeeCode: "GW-FAC-01",
});
const schoolFaculty = await makeUser({
  email: "teacher@greenwood.test",
  name: "Suresh Iyer",
  institutionId: school.id,
  roleKey: "FACULTY",
  employeeCode: "GW-FAC-02",
});
await makeUser({
  email: "operator@greenwood.test",
  name: "Meena Rao",
  institutionId: school.id,
  roleKey: "ATTENDANCE_OPERATOR",
  employeeCode: "GW-OPS-01",
});

for (const [cohort, user, role] of [
  [g8a, classTeacher, "PRIMARY"],
  [g8a, schoolFaculty, "ASSISTANT"],
  [g8b, schoolFaculty, "PRIMARY"],
] as const) {
  const existing = await prisma.cohortFaculty.findUnique({
    where: { cohortId_userId: { cohortId: cohort.id, userId: user.id } },
  });
  if (!existing) {
    await prisma.cohortFaculty.create({ data: { cohortId: cohort.id, userId: user.id, role } });
  }
}

const schoolStudents = await enrolStudents({
  institutionId: school.id,
  cohortId: g8a.id,
  codePrefix: "GW8A",
  people: [
    ["Aarav", "Sharma"],
    ["Diya", "Patel"],
    ["Ishaan", "Verma"],
    ["Kavya", "Reddy"],
    ["Rohan", "Gupta"],
    ["Saanvi", "Joshi"],
    ["Vihaan", "Kulkarni"],
    ["Ananya", "Bose"],
  ],
});

await enrolStudents({
  institutionId: school.id,
  cohortId: g8b.id,
  codePrefix: "GW8B",
  people: [
    ["Arjun", "Nair"],
    ["Meera", "Pillai"],
    ["Kabir", "Singh"],
    ["Tara", "Chopra"],
  ],
});

// One school student with a portal login, linked to their Student row.
const schoolStudentUser = await makeUser({
  email: "student@greenwood.test",
  name: "Aarav Sharma",
  institutionId: school.id,
  roleKey: "STUDENT",
});
await prisma.student.update({
  where: { id: schoolStudents[0].id },
  data: { userId: schoolStudentUser.id },
});

// ---------------------------------------------------------------------------
// College tenant
// ---------------------------------------------------------------------------

const college = await findOrCreateInstitution("Northfield Institute of Technology", "COLLEGE", {
  attendanceMode: "SUBJECT_WISE",
  academicUnitLabels: { department: "Department", semester: "Semester", course: "Course" },
  confidenceThresholds: { presentMin: 0.62, reviewMin: 0.45 },
});

const collegeYear = await prisma.academicSession.upsert({
  where: { institutionId_name: { institutionId: college.id, name: "2026 Odd Semester" } },
  update: { isActive: true },
  create: {
    institutionId: college.id,
    name: "2026 Odd Semester",
    startDate: new Date("2026-07-01T00:00:00Z"),
    endDate: new Date("2026-12-31T00:00:00Z"),
    isActive: true,
  },
});

const cseDept = await findOrCreateUnit({
  institutionId: college.id,
  parentId: null,
  kind: "DEPARTMENT",
  name: "Computer Science",
  code: "CSE",
});
const sem3 = await findOrCreateUnit({
  institutionId: college.id,
  parentId: cseDept.id,
  kind: "SEMESTER",
  name: "Semester 3",
  code: "S3",
});
const cs301Unit = await findOrCreateUnit({
  institutionId: college.id,
  parentId: sem3.id,
  kind: "COURSE",
  name: "CS301 Data Structures",
  code: "CS301",
});

const cs301 = await findOrCreateCohort({
  institutionId: college.id,
  academicUnitId: cs301Unit.id,
  academicSessionId: collegeYear.id,
  name: "CSE Sem 3 - Section 1",
  termLabel: "2026 Odd",
});

await makeUser({
  email: "admin@northfield.test",
  name: "Dr. Lakshmi Sundaram",
  institutionId: college.id,
  roleKey: "COLLEGE_ADMIN",
  employeeCode: "NF-ADM-01",
});
const collegeFaculty = await makeUser({
  email: "faculty@northfield.test",
  name: "Dr. Vikram Shetty",
  institutionId: college.id,
  roleKey: "FACULTY",
  employeeCode: "NF-FAC-01",
});

const existingLink = await prisma.cohortFaculty.findUnique({
  where: { cohortId_userId: { cohortId: cs301.id, userId: collegeFaculty.id } },
});
if (!existingLink) {
  await prisma.cohortFaculty.create({
    data: { cohortId: cs301.id, userId: collegeFaculty.id, role: "PRIMARY" },
  });
}

const subjects = [
  { code: "CS301", name: "Data Structures" },
  { code: "CS302", name: "Operating Systems" },
  { code: "CS303", name: "Database Systems" },
];

const cohortSubjects = [];
for (const s of subjects) {
  const subject = await prisma.subject.upsert({
    where: { institutionId_code: { institutionId: college.id, code: s.code } },
    update: { name: s.name },
    create: { institutionId: college.id, code: s.code, name: s.name },
  });
  const cs = await prisma.cohortSubject.upsert({
    where: { cohortId_subjectId: { cohortId: cs301.id, subjectId: subject.id } },
    update: { facultyId: collegeFaculty.id },
    create: { cohortId: cs301.id, subjectId: subject.id, facultyId: collegeFaculty.id },
  });
  cohortSubjects.push(cs);
}

const collegeStudents = await enrolStudents({
  institutionId: college.id,
  cohortId: cs301.id,
  codePrefix: "NF23CS",
  people: [
    ["Nikhil", "Raman"],
    ["Sneha", "Kapoor"],
    ["Aditya", "Mishra"],
    ["Pooja", "Bhat"],
    ["Rahul", "Dutta"],
    ["Ishita", "Ghosh"],
  ],
});

for (const student of collegeStudents) {
  for (const cs of cohortSubjects) {
    await prisma.studentSubjectEnrollment.upsert({
      where: { studentId_cohortSubjectId: { studentId: student.id, cohortSubjectId: cs.id } },
      update: {},
      create: { studentId: student.id, cohortSubjectId: cs.id },
    });
  }
}

const collegeStudentUser = await makeUser({
  email: "student@northfield.test",
  name: "Nikhil Raman",
  institutionId: college.id,
  roleKey: "STUDENT",
});
await prisma.student.update({
  where: { id: collegeStudents[0].id },
  data: { userId: collegeStudentUser.id },
});

// ---------------------------------------------------------------------------

const counts = {
  institutions: await prisma.institution.count(),
  users: await prisma.user.count(),
  students: await prisma.student.count(),
  cohorts: await prisma.cohort.count(),
  enrollments: await prisma.enrollment.count(),
  subjects: await prisma.subject.count(),
  faceEmbeddings: await prisma.faceEmbedding.count(),
};

console.log("Dev fixture ready:", JSON.stringify(counts));
console.log(`All accounts share the password: ${DEV_PASSWORD}`);
await prisma.$disconnect();
