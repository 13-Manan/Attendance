-- Synthetic data for measuring Phase 8 report queries.
-- Scratch database only. Nothing here touches the project's schema or dev DB.
BEGIN;

INSERT INTO "Institution" (id, name, type, timezone, settings, "updatedAt") VALUES
  ('inst_c', 'Bench College', 'COLLEGE', 'UTC', '{}', now()),
  ('inst_s', 'Bench School',  'SCHOOL',  'UTC', '{}', now());

INSERT INTO "AcademicSession" (id, "institutionId", name, "startDate", "endDate", "isActive") VALUES
  ('as_c', 'inst_c', '2026-27', '2026-06-01', '2027-05-31', true),
  ('as_s', 'inst_s', '2026-27', '2026-06-01', '2027-05-31', true);

INSERT INTO "User" (id, "institutionId", email, name, status, "updatedAt")
SELECT 'u_c_' || i, 'inst_c', 'fac' || i || '@college.test', 'Faculty C' || i, 'ACTIVE', now()
FROM generate_series(1, 40) i;

INSERT INTO "User" (id, "institutionId", email, name, status, "updatedAt")
SELECT 'u_s_' || i, 'inst_s', 'fac' || i || '@school.test', 'Faculty S' || i, 'ACTIVE', now()
FROM generate_series(1, 40) i;

-- ---------------------------------------------------------------------------
-- COLLEGE: DEPARTMENT -> SEMESTER -> COURSE -> Cohort
-- ---------------------------------------------------------------------------
INSERT INTO "AcademicUnit" (id, "institutionId", "parentId", kind, name, code, "sortOrder")
SELECT 'au_c_d' || d, 'inst_c', NULL, 'DEPARTMENT', 'Department ' || d, 'D' || d, d
FROM generate_series(1, 3) d;

INSERT INTO "AcademicUnit" (id, "institutionId", "parentId", kind, name, code, "sortOrder")
SELECT 'au_c_d' || d || '_s' || s, 'inst_c', 'au_c_d' || d, 'SEMESTER', 'Semester ' || s, 'S' || s, s
FROM generate_series(1, 3) d, generate_series(1, 4) s;

INSERT INTO "AcademicUnit" (id, "institutionId", "parentId", kind, name, code, "sortOrder")
SELECT 'au_c_d' || d || '_s' || s || '_c' || c, 'inst_c', 'au_c_d' || d || '_s' || s,
       'COURSE', 'Course ' || d || '.' || s || '.' || c, 'C' || d || s || c, c
FROM generate_series(1, 3) d, generate_series(1, 4) s, generate_series(1, 3) c;

INSERT INTO "Cohort" (id, "institutionId", "academicUnitId", "academicSessionId", name, "termLabel")
SELECT 'co_c_' || d || s || c, 'inst_c', 'au_c_d' || d || '_s' || s || '_c' || c, 'as_c',
       'BC ' || d || '.' || s || '.' || c, 'Semester ' || s
FROM generate_series(1, 3) d, generate_series(1, 4) s, generate_series(1, 3) c;

INSERT INTO "Subject" (id, "institutionId", code, name)
SELECT 'sub_c_' || i, 'inst_c', 'SUB' || i, 'Subject ' || i FROM generate_series(1, 8) i;

INSERT INTO "CohortSubject" (id, "cohortId", "subjectId", "facultyId")
SELECT 'cs_' || co.id || '_' || i, co.id, 'sub_c_' || i,
       'u_c_' || (1 + (abs(hashtext(co.id || i::text)) % 40))
FROM "Cohort" co, generate_series(1, 6) i
WHERE co."institutionId" = 'inst_c';

INSERT INTO "CohortFaculty" (id, "cohortId", "userId", role)
SELECT 'cf_' || co.id, co.id, 'u_c_' || (1 + (abs(hashtext(co.id)) % 40)), 'PRIMARY'
FROM "Cohort" co WHERE co."institutionId" = 'inst_c';

CREATE TEMP TABLE tmp_students AS
SELECT co.id AS cohort_id, co."institutionId" AS institution_id,
       'st_' || co.id || '_' || i AS student_id, i AS n
FROM "Cohort" co, generate_series(1, 60) i
WHERE co."institutionId" = 'inst_c';

-- ---------------------------------------------------------------------------
-- SCHOOL: GRADE -> SECTION -> Cohort
-- ---------------------------------------------------------------------------
INSERT INTO "AcademicUnit" (id, "institutionId", "parentId", kind, name, code, "sortOrder")
SELECT 'au_s_g' || g, 'inst_s', NULL, 'GRADE', 'Grade ' || g, 'G' || g, g
FROM generate_series(1, 12) g;

INSERT INTO "AcademicUnit" (id, "institutionId", "parentId", kind, name, code, "sortOrder")
SELECT 'au_s_g' || g || '_' || sec, 'inst_s', 'au_s_g' || g, 'SECTION', 'Section ' || sec, sec, ascii(sec)
FROM generate_series(1, 12) g, unnest(ARRAY['A','B','C']) sec;

INSERT INTO "Cohort" (id, "institutionId", "academicUnitId", "academicSessionId", name, "termLabel")
SELECT 'co_s_' || g || sec, 'inst_s', 'au_s_g' || g || '_' || sec, 'as_s',
       'Grade ' || g || ' ' || sec, NULL
FROM generate_series(1, 12) g, unnest(ARRAY['A','B','C']) sec;

INSERT INTO "CohortFaculty" (id, "cohortId", "userId", role)
SELECT 'cf_' || co.id, co.id, 'u_s_' || (1 + (abs(hashtext(co.id)) % 40)), 'PRIMARY'
FROM "Cohort" co WHERE co."institutionId" = 'inst_s';

INSERT INTO tmp_students
SELECT co.id, co."institutionId", 'st_' || co.id || '_' || i, i
FROM "Cohort" co, generate_series(1, 45) i
WHERE co."institutionId" = 'inst_s';

-- ---------------------------------------------------------------------------
-- Students + enrollments
-- ---------------------------------------------------------------------------
INSERT INTO "Student" (id, "institutionId", "studentCode", "firstName", "lastName", status, "updatedAt")
SELECT t.student_id, t.institution_id,
       upper(replace(replace(t.cohort_id, 'co_', ''), '_', '')) || lpad(t.n::text, 3, '0'),
       'First' || t.n, 'Last' || (abs(hashtext(t.student_id)) % 400), 'ACTIVE', now()
FROM tmp_students t;

INSERT INTO "Enrollment" (id, "institutionId", "studentId", "cohortId", status)
SELECT 'en_' || t.student_id, t.institution_id, t.student_id, t.cohort_id, 'ACTIVE'
FROM tmp_students t;

-- ---------------------------------------------------------------------------
-- Attendance sessions
--   college: one session per cohort-subject every 3 days, 26 of them
--   school:  one daily session per cohort, 90 of them
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE tmp_sessions AS
SELECT 'sess_' || cs.id || '_' || d AS id,
       'inst_c'::text               AS institution_id,
       cs."cohortId"                AS cohort_id,
       cs.id                        AS cohort_subject_id,
       cs."facultyId"               AS faculty_id,
       (DATE '2026-09-16' - (d * 3))::timestamp AS session_date,
       (CASE WHEN d <= 1 AND (abs(hashtext(cs.id)) % 10) < 4 THEN 'REVIEW' ELSE 'FINALIZED' END) AS status
FROM "CohortSubject" cs, generate_series(0, 25) d;

INSERT INTO tmp_sessions
SELECT 'sess_' || co.id || '_' || d, 'inst_s', co.id, NULL,
       'u_s_' || (1 + (abs(hashtext(co.id)) % 40)),
       (DATE '2026-09-16' - d)::timestamp,
       (CASE WHEN d = 0 AND (abs(hashtext(co.id)) % 10) < 4 THEN 'REVIEW' ELSE 'FINALIZED' END)
FROM "Cohort" co, generate_series(0, 89) d
WHERE co."institutionId" = 'inst_s';

INSERT INTO "AttendanceSession"
  (id, "institutionId", "cohortId", "cohortSubjectId", "facultyId", "sessionDate", "startedAt", "endedAt", status, metadata)
SELECT s.id, s.institution_id, s.cohort_id, s.cohort_subject_id, s.faculty_id,
       s.session_date, s.session_date + interval '9 hours',
       CASE WHEN s.status = 'FINALIZED' THEN s.session_date + interval '10 hours' END,
       s.status::"SessionStatus",
       '{"generationSource":"recognition","captureCount":3}'
FROM tmp_sessions s;

-- ---------------------------------------------------------------------------
-- Attendance records
--
-- Absence rate varies per student (8%-37%) so the low-attendance report has
-- something real to find. Finalized registers contain no unresolved rows,
-- which is what the engine guarantees.
-- ---------------------------------------------------------------------------
INSERT INTO "AttendanceRecord"
  (id, "institutionId", "sessionId", "studentId", "aiResult", "aiConfidence",
   "finalResult", "isManuallyCorrected", "updatedAt")
SELECT md5(s.id || t.student_id),
       s.institution_id, s.id, t.student_id,
       r.result::"AttendanceResult",
       CASE WHEN r.result = 'PRESENT' THEN 0.70 + (h % 25) / 100.0 ELSE NULL END,
       r.result::"AttendanceResult",
       (h % 50) = 0,
       now()
FROM tmp_sessions s
JOIN tmp_students t ON t.cohort_id = s.cohort_id
CROSS JOIN LATERAL (SELECT abs(hashtext(s.id || t.student_id)) AS h) hv
CROSS JOIN LATERAL (
  SELECT CASE
    WHEN s.status <> 'FINALIZED' AND (h % 100) < 12 THEN 'NEEDS_REVIEW'
    WHEN (h % 100) < 8 + (abs(hashtext(t.student_id)) % 30) THEN 'ABSENT'
    ELSE 'PRESENT'
  END AS result
) r;

-- A few manual corrections, so correction-aware reports are not measured empty.
INSERT INTO "AttendanceCorrection"
  (id, "attendanceRecordId", "previousResult", "newResult", "changedByUserId", reason, source)
SELECT md5('corr' || ar.id), ar.id, 'ABSENT', ar."finalResult",
       CASE WHEN ar."institutionId" = 'inst_c' THEN 'u_c_1' ELSE 'u_s_1' END,
       'Late arrival', 'FACULTY_REVIEW'
FROM "AttendanceRecord" ar
WHERE ar."isManuallyCorrected";

COMMIT;

ANALYZE;

SELECT 'students'  AS t, count(*) FROM "Student"
UNION ALL SELECT 'cohorts',     count(*) FROM "Cohort"
UNION ALL SELECT 'sessions',    count(*) FROM "AttendanceSession"
UNION ALL SELECT 'records',     count(*) FROM "AttendanceRecord"
UNION ALL SELECT 'corrections', count(*) FROM "AttendanceCorrection";
