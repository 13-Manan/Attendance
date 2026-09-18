# Multi-tenancy: schools and colleges on one schema

## Problem

The platform must serve both K-12 schools (Grade → Section) and colleges
(Department → Semester → Course) from a shared attendance engine, without
forking the schema or the codebase per institution type — a school and a
college should get bug fixes, the recognition pipeline, and the correction
workflow for free from each other, not maintain parallel implementations.

## Approach

Every tenant is an `Institution` row with a `type` (`SCHOOL | COLLEGE`).
Institution-type-specific *vocabulary* and *hierarchy depth* are handled by
one generic tree, not by separate tables:

- `AcademicUnit` — self-referential (`parentId`), discriminated by `kind`
  (`DEPARTMENT | GRADE | SEMESTER | COURSE | SECTION | GENERIC`). Depth and
  which `kind`s are used is entirely up to how an institution's admin builds
  their tree — the schema doesn't hardcode "schools have exactly 2 levels."
- `Cohort` — the actual attendance-taking unit, attached to one
  `AcademicUnit`. Sessions, enrollments, and faculty assignments all key off
  `Cohort`, never off `AcademicUnit` directly — so the pipeline code never
  needs to know or care whether it's looking at a school or a college.
- `Institution.settings.academicUnitLabels` — UI-facing label overrides
  (e.g. `{ "GRADE": "Grade", "SECTION": "Division" }`) so the product can
  say "Grade 8" for a school and "Semester 3" for a college without an
  `if (institution.type === "SCHOOL")` branch anywhere in the pipeline or
  attendance logic. Defaults live in
  `modules/institutions/service.ts#resolveAcademicUnitLabels`.

## What this buys

- One migration, one set of indexes, one Prisma client shape for both
  institution types.
- Adding a third institution type later (e.g. a training center with
  `Cohort` → `Batch`) means adding an `AcademicUnitKind` enum value, not a
  new table or a fork.
- The recognition pipeline, confidence engine, and correction audit trail
  (`modules/recognition-results`, `modules/attendance`) operate purely on
  `Cohort`/`AttendanceSession`/`AttendanceRecord` and never reference
  `AcademicUnitKind` at all — school/college specificity stays contained to
  the institution/academic-unit layer.

## What's explicitly NOT solved by this abstraction

- Row-level tenant isolation (every query must still filter by
  `institutionId`; this phase does not add a database-level RLS policy or
  a query-layer guard — that's a hardening item for a later phase, tracked
  alongside the auth phase in `modules/auth-tenancy`).
- Cross-institution reporting/rollups (out of scope entirely for now).
