import { test } from "node:test";
import assert from "node:assert/strict";
import { attendanceUxLine, logAttendanceUx, type AttendanceUxFields } from "./ux-events.ts";

test("a UX line is one JSON object keyed by log, with the event and the allowed fields", () => {
  const line = JSON.parse(
    attendanceUxLine("recognition_complete", { sessionId: "s1", photos: 2, present: 31, needsReview: 3, total: 34, merged: false }),
  );
  assert.deepEqual(line, {
    log: "attendance.ux",
    event: "recognition_complete",
    sessionId: "s1",
    photos: 2,
    merged: false,
    present: 31,
    needsReview: 3,
    total: 34,
  });
});

test("nothing outside the allowed list is ever written — not an image, a vector, a face's position or a credential", () => {
  const careless = {
    sessionId: "s1",
    imageBase64: "AAAA",
    embedding: [0.1, 0.2],
    boundingBox: { x: 1, y: 2, width: 3, height: 4 },
    studentId: "stu-1",
    name: "Priya",
    password: "x",
    token: "y",
  } as unknown as AttendanceUxFields;
  const line = attendanceUxLine("capture", careless);
  assert.deepEqual(JSON.parse(line), { log: "attendance.ux", event: "capture", sessionId: "s1" });
  assert.doesNotMatch(line, /AAAA|0\.1|boundingBox|stu-1|Priya|password|token/);
});

test("a value that is not a plain string, number or boolean is dropped, not stringified", () => {
  const line = JSON.parse(
    attendanceUxLine("capture", { sessionId: "s1", faces: Number.NaN, status: { nested: true } } as unknown as AttendanceUxFields),
  );
  assert.deepEqual(line, { log: "attendance.ux", event: "capture", sessionId: "s1" });
});

test("logging never throws into the flow it observes", () => {
  const original = console.info;
  console.info = () => {
    throw new Error("stdout closed");
  };
  try {
    assert.doesNotThrow(() => logAttendanceUx("attendance_start", { sessionId: "s1" }));
  } finally {
    console.info = original;
  }
});
