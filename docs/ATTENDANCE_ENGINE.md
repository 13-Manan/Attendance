# Attendance Engine

How an advisory recognition run becomes an attendance register that a human
owns, confirms, and can correct — and every place the design refuses to guess.

Written in Phase 6. Companion documents:
[`RECOGNITION_ENGINE.md`](RECOGNITION_ENGINE.md) (what produces the advisory
input), [`DATA_MODEL.md`](DATA_MODEL.md) (the AI-advisory / faculty-
authoritative split in the schema), and
[`adr/0004-realtime-sse-in-memory-pubsub.md`](adr/0004-realtime-sse-in-memory-pubsub.md)
(how a finalized result reaches a student's screen).

> **Recognition suggests. Faculty decide. Nothing becomes final without a
> human pressing Confirm.**

---

## 1. The pipeline

```
Captured images (1–3, browser, never persisted)
   │
   ▼
Recognition results                    modules/recognition-engine  ── advisory
   │   per-student aggregate: bestSimilarity, wasAmbiguous, advisoryResult
   ▼
Attendance candidate generation        modules/attendance-review/service.ts
   │   ONE AttendanceRecord per ENROLLED student — roster-driven, not
   │   recognition-driven
   ▼
Present / Absent / Needs Review        finalResult seeded from the advisory
   │
   ▼
Faculty review + correction            AttendanceCorrection appended, aiResult
   │                                   never overwritten
   ▼
Final attendance                       session FINALIZED, visible in the
                                       student portal
```

Recognition and generation run inside **one** server action
(`processSessionAttendanceAction`). They are not two round trips on purpose: a
browser that could post recognition results back for storage could simply
claim that everyone was matched. Attendance would then be asserted by the
device rather than measured by the server. The summary the browser receives is
display-only.

---

## 2. Where the code lives

| Concern | Location |
| --- | --- |
| Candidate generation, review board, correction, finalization | `apps/web/src/modules/attendance-review/service.ts` |
| Roster loading, register writes, session detail | `apps/web/src/modules/attendance-review/repository.ts` |
| Server actions (the only client entry points) | `apps/web/src/modules/attendance-review/actions.ts` |
| Types shared by service and UI | `apps/web/src/modules/attendance-review/types.ts` |
| The single writer of `finalResult` | `apps/web/src/modules/attendance/service.ts#correctAttendanceRecord` |
| Finalization guard (state machine + unresolved check) | `apps/web/src/modules/sessions/service.ts#finalizeAttendanceSession` |
| Faculty review board UI | `apps/web/src/app/dashboard/attendance/[cohortId]/review/[sessionId]/` |
| Student portal | `apps/web/src/app/portal/attendance/` |
| Realtime channels | `apps/web/src/app/api/realtime/attendance/[sessionId]/`, `.../realtime/student/[studentId]/` |
| Tests | `apps/web/src/modules/attendance-review/service.test.ts` (27), `apps/web/src/modules/sessions/service.test.ts` (12) |

---

## 3. What an attendance session carries

Phase 6 asks a session to record institution, academic session, class/section,
subject where applicable, faculty, date, start time, capture-image metadata,
processing status, attendance status, `finalizedBy` and `finalizedAt`.

Most of that is already columns on `AttendanceSession` (`institutionId`,
`cohortId`, `cohortSubjectId`, `facultyId`, `sessionDate`, `startedAt`,
`endedAt`, `status`); the academic session is reached through the cohort.

The rest lives in the existing `metadata Json` column under a single
`attendanceReview` key:

```jsonc
{
  "attendanceReview": {
    "rosterScope": "cohort" | "cohortSubject",
    "generationSource": "recognition" | "manual",
    "generatedAt": "2026-09-15T04:31:07.412Z",
    "captureImages": [{ "sequenceNumber": 1, "facesDetected": 27, "qualityScore": 0.71 }],
    "recognition": { "modelName": "...", "modelVersion": "...", "presentMin": 0.62, ... },
    "studentNotes": { "<studentId>": { "reason": "low_confidence", "wasComparable": true, ... } },
    "finalizedByUserId": "...",
    "finalizedAt": "2026-09-15T04:44:02.001Z"
  }
}
```

### Why `finalizedBy` / `finalizedAt` are not columns

The phase brief also says *"do NOT change or break any existing … database
schema."* Adding two columns is a schema change, so they are written to
`metadata` instead.

This is a deliberate trade, not an oversight:

- The **authoritative** record of who finalized is the `AuditLog` row
  (`attendance.finalized`, `actorUserId`, `occurredAt`). That is the
  tamper-evident copy and it predates this phase.
- The `metadata` copy exists so the review header can render "Finalized by X
  at Y" without a second query against the audit table.
- Json is not indexable here and not type-checked by the database. Promoting
  both to real columns (`finalizedByUserId String?`, `finalizedAt DateTime?`)
  is a purely additive migration and is the recommended follow-up the moment
  a schema change is in scope.

`captureImages` is recomputed from the recognition run's per-face rows rather
than accepted from the browser. The client already knows how many faces were
in photo 2, but that number is provenance for an attendance record, so the
server derives it from what it actually received.

---

## 4. School vs college

`resolveAttendanceMode(institution)` decides, exactly as it does for capture:

| Mode | Institution | Session granularity | Roster |
| --- | --- | --- | --- |
| `DAILY` | SCHOOL | one session per class per day | every ACTIVE enrollment in the cohort |
| `SUBJECT_WISE` | COLLEGE | one session per subject/lecture | students enrolled in that `CohortSubject` |

`resolveSessionRoster` falls back from subject to cohort when a
`CohortSubject` has no per-student enrollment rows. A non-elective subject
legitimately has none, and reading that as "nobody is enrolled" would produce
an empty register for a full classroom. The fallback mirrors the recognition
engine's `candidateScope` decision exactly, so **the population that is
searched and the population that gets rows are always the same set of
people** — a student cannot be searched for and then denied a row, or given a
row and never searched for.

---

## 5. "Do not lose them"

Candidates are generated from the **enrolled roster**, never from whoever
recognition happened to return. Fifty enrolled students produce fifty
attendance rows even if recognition matched ten.

The decision table (`decideCandidate`, a pure function, tested directly):

| Situation | `aiResult` | `finalResult` | Reason shown |
| --- | --- | --- | --- |
| Recognition did not run (manual roll call) | `NOT_EVALUATED` | `NEEDS_REVIEW` | `recognition_unavailable` |
| No active face template | `NOT_EVALUATED` | `NEEDS_REVIEW` | `no_face_template` |
| Template exists but for another model build | `NOT_EVALUATED` | `NEEDS_REVIEW` | `incompatible_face_template` |
| Best similarity ≥ `presentMin` | `PRESENT` | `PRESENT` | — |
| Between `reviewMin` and `presentMin`, or within the ambiguity margin of a runner-up | `NEEDS_REVIEW` | `NEEDS_REVIEW` | `low_confidence` / `ambiguous_match` |
| Compared, nothing above `reviewMin` | `ABSENT` | `ABSENT` | `no_match` |

Rows 2 and 3 are the point of the table. **A student who could not be compared
is not marked absent.** "We never looked" and "we looked and you were not
there" are different claims, and only the second is evidence of absence. The
review UI says so in words: *"…so this is not evidence of absence."*

This extends Phase 5's rule — *AI must never silently convert uncertainty into
a confident Present* — to the symmetric case, because a wrongly recorded
absence is the error a student actually pays for.

---

## 6. Idempotence and reprocessing

`upsertAttendanceCandidates` runs in a transaction that:

1. snapshots which students already have a row,
2. `createMany(..., skipDuplicates: true)` for the rest — the
   `@@unique([sessionId, studentId])` index is the real guard against a
   retake or two faculty devices submitting at once,
3. refreshes the advisory on pre-existing rows **`where isManuallyCorrected:
   false`**.

Step 3's filter is the rule that a faculty decision outranks any later AI run.
Re-running recognition after a retake updates the machine's opinion about
students nobody has judged, and leaves every human decision untouched.

A student appears **once** per session regardless of how many captured frames
they were detected in; deduplication happens upstream in the recognition
engine's per-student aggregate, and the unique index makes it structural here.

---

## 7. The review board

Three lists over one register: **Needs Review** (rendered first — it is what
blocks finalization), **Present**, **Absent**.

| List | Shows |
| --- | --- |
| Present | avatar, student ID, name, recognition status, confidence indicator, `[Mark Absent]` |
| Absent | avatar, student ID, name, status, reason, `[Mark Present]` |
| Needs Review | student, reason in prose, confidence, which frame produced the best match, `[Verify → Present / Absent]` |

Notes on two deliberate gaps:

- **Profile photos.** `AttendanceReviewStudent.photoUrl` is always `null` in
  this build. `Student` has no photo column and adding one is a schema change;
  the UI falls back to an initials monogram. The field exists so that wiring a
  photo later is a data change, not a component change.
- **Confidence for a student who was never compared** renders as *"not
  compared"*, never as `0%`. Zero is a score; absence of a score is not.

Corrections are **optimistic**: the counters and the lists move the instant the
button is pressed, then the server's authoritative counts replace the
optimistic ones. A rejected correction snaps back rather than lingering as a
lie. The counts are recomputed from the rendered lists, so the tally can never
disagree with the rows a user is looking at.

---

## 8. Corrections preserve the original AI result

Every correction goes through `correctAttendanceRecord`, the only code path
allowed to write `finalResult`. It appends an `AttendanceCorrection` row
carrying student, session, **previous** status, **new** status, actor,
timestamp, and optional reason, and sets `isManuallyCorrected = true`.

`aiResult` and `aiConfidence` are never written by a correction. The machine's
original opinion survives for the life of the record — that is what makes
later benchmarking (and any dispute) possible.

Re-asserting a status a record already has is a **no-op**: it writes no
correction, because an `AttendanceCorrection` whose previous and new result are
identical is a non-event that would pollute the audit trail.

### After finalization

A finalized register is still correctable, but the path is narrower:

- the caller needs `attendanceSession.finalize`, not merely
  `attendanceRecord.correct` — whoever may close a register may reopen a line
  in it;
- the correction is recorded with `source: "ADMIN_OVERRIDE"` rather than
  `"FACULTY_REVIEW"`, so a post-hoc change is distinguishable from an
  in-review one for the rest of time;
- a `CANCELLED` session rejects corrections outright.

---

## 9. Finalization

Before confirming, the faculty member sees Total Students / Present / Absent /
Needs Review. Confirmation is two-step — summary, then "Yes, finalize
attendance".

`finalizeAttendanceSession` refuses when:

- any record is `NEEDS_REVIEW` or `NOT_EVALUATED` → `unresolved_review_states:N`
- the register is empty → `no_attendance_records`
- the session is not in `REVIEW` (the state machine's `ALLOWED_TRANSITIONS`)
- the caller lacks `attendanceSession.finalize` → `ForbiddenError`

The guard lives in `modules/sessions/service.ts`, not in the UI and not in the
review module, so that **every** finalization path — this one and any future
API or admin path — is blocked by the same check. An unresolved
`NEEDS_REVIEW` can never become `PRESENT` by omission.

`attendanceSession.finalize` was added to the `FACULTY` permission set in this
phase (and is inherited by `CLASS_TEACHER`) so that "faculty confirms" is
actually reachable. The grant is additive and still scoped per session by
`requireCohortAccess` — it confers the ability to close a register you teach,
not any register. `prisma/seed.ts` converges `RolePermission` rows on every
run, so applying it is a re-seed.

---

## 10. Realtime

Two channel families, and the split is an **authorization boundary**, not a
performance one:

| Channel | Audience | Carries |
| --- | --- | --- |
| `session:<id>` → `GET /api/realtime/attendance/[sessionId]` | faculty reviewing that register | `attendance-record-updated`, `attendance-session-finalized`, with whole-class counts |
| `student:<id>` → `GET /api/realtime/student/[studentId]` | that one student | `student-attendance-updated` — their own result only |

Both routes authenticate before subscribing. The session channel requires
`attendanceRecord.read` plus same-institution plus cohort access. The student
channel requires `attendanceRecord.read.own` and then checks that the resolved
student for the logged-in user *is* the `studentId` in the URL — a path
segment is never taken as a claim of identity, so guessing another student's
id returns 403, not their attendance.

The student portal treats an event as a **signal, not as data**: on any event
it refetches through `getOwnAttendanceAction()`, the same authorized action
that rendered the page. Nothing in the payload is trusted to be displayable.

Neither client reloads the application. The review board applies the event's
counts immediately and refetches only the board; the portal refetches only its
own list.

Transport is SSE over an in-memory `EventEmitter` (ADR-0004), which is
single-process. Running more than one Next.js instance requires swapping the
publisher for Redis/Postgres `LISTEN/NOTIFY`; the `AttendanceEventPublisher`
interface exists so that is a one-file change.

---

## 11. Student visibility

`getOwnAttendance` takes no `studentId` — the student is resolved from the
server session, so the function structurally cannot be pointed at somebody
else's record.

Only `FINALIZED` sessions are returned. A register still in review is a draft,
and telling a student they were absent from a class the teacher has not
confirmed — a claim a correction is about to overturn — is worse than telling
them nothing yet.

---

## 12. Tests

`apps/web/src/modules/attendance-review/service.test.ts` (27 tests) runs
against an in-memory register harness that behaves like the real one: rows
keyed by student, corrections appended, `aiResult` never overwritten, guarded
status transitions, events captured on both channels.

Covered: the decision table; roster scoping and the subject→cohort fallback;
"every enrolled student gets a row" (50 enrolled, recognition returns 10 → 10
present, 40 rows that are *not* silently absent); deduplication; reprocessing
preserving `isManuallyCorrected`; manual roll call; `session_locked:FINALIZED`;
the correction audit trail; the no-op re-assertion; dual-channel publishing;
permission and cross-institution denial; post-finalization `ADMIN_OVERRIDE`.

### The Phase 6 scenario, and its arithmetic

The brief's scenario is asserted directly: 50 students → 43 present, 5 absent,
2 needs review; the teacher marks one absent student present → **44 / 4 / 2**,
which matches the brief.

The brief then expects "Present 45, Absent 5, Review 1" after resolving one
review row. That totals **51** for a class of 50. Resolving a review row moves
exactly one student out of Review, so the two consistent outcomes are
**45 / 4 / 1** (resolved as present) and **44 / 5 / 1** (resolved as absent).
Both branches are implemented and asserted, and the discrepancy is documented
in the test itself rather than papered over.

---

## 13. Known limitations

- `finalizedBy` / `finalizedAt` are Json, not columns (§3). Additive migration
  recommended.
- No profile photos anywhere in the UI — no column exists to hold one (§7).
- SSE publisher is in-process (§10).
- Attendance percentages in the student portal cover only the sessions listed,
  and are not an official attendance statistic.
- No recognition model in `services/face-ai` is production-cleared; see
  `services/face-ai/app/models/LICENSING.md`. License verification required
  before production deployment.
- End-to-end browser verification of the review board and portal has **not**
  been run: the local Postgres (Homebrew 16) has no `vector` extension
  available, so the Prisma schema cannot be applied and no fixture data
  exists. See README "Local database" for the two supported ways to get a
  pgvector-capable Postgres.
