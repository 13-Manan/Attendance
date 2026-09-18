# ADR-0003: One schema for schools and colleges via AcademicUnit + Cohort

## Status

Accepted (foundation phase).

## Context

Schools organize students by Grade → Section; colleges by Department →
Semester → Course. The product must support both without forking the
schema or the attendance/recognition pipeline per institution type.

## Decision

Introduce a self-referential `AcademicUnit` tree discriminated by `kind`
(`DEPARTMENT | GRADE | SEMESTER | COURSE | SECTION | GENERIC`), plus a
`Cohort` table (the actual enrollable, attendance-taking group) that
attaches to one `AcademicUnit`. Institution-specific vocabulary comes from
`Institution.settings.academicUnitLabels`, not from separate tables or code
branches. Full detail: `docs/MULTI_TENANCY.md`.

## Rationale

A generic tree plus a fixed "attendance attaches here" anchor (`Cohort`)
means the attendance/recognition pipeline (`modules/sessions`,
`modules/recognition-results`, `modules/attendance`) never needs to know or
branch on institution type — it only ever sees `Cohort`. Alternatives
considered and rejected:

- **Separate `SchoolClass`/`CollegeCourse` tables**: doubles every join and
  query in the attendance pipeline, and any third institution type (e.g. a
  training center) would need a third fork.
- **A single flat `Class` table with nullable school/college-specific
  columns**: doesn't model arbitrary hierarchy depth (a college's
  Department → Semester → Course is three levels; a flat table can't
  represent the parent chain for reporting/rollups later).

## Consequences

- Every academic-hierarchy query has to walk `AcademicUnit.parentId`
  relationships rather than a fixed number of joins — acceptable given
  these trees are small (dozens of nodes per institution) and read
  infrequently compared to attendance operations.
- UI label logic must always go through
  `modules/institutions/service.ts#resolveAcademicUnitLabels` rather than
  hardcoding "Grade" or "Semester" anywhere.
