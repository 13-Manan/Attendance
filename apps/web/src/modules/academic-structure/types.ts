import type { AcademicUnit, AcademicUnitKind } from "@prisma/client";

export type { AcademicUnit, AcademicUnitKind };

// Which AcademicUnitKind values a given InstitutionType is allowed to build
// its tree from. Enforcement lives in modules/academic-structure/service.ts —
// the SCHOOL / COLLEGE guard on createAcademicUnit — so a SCHOOL admin cannot
// invent a SEMESTER unit and a COLLEGE admin cannot invent a GRADE unit.
// Kept in types.ts (not service.ts) because the UI needs the same list to
// render its "kind" dropdown, and both layers must agree.
export const KINDS_BY_INSTITUTION_TYPE = {
  SCHOOL: ["GRADE", "SECTION", "GENERIC"] as const,
  COLLEGE: ["DEPARTMENT", "SEMESTER", "COURSE", "SECTION", "GENERIC"] as const,
} satisfies Record<"SCHOOL" | "COLLEGE", readonly AcademicUnitKind[]>;
