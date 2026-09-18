"use client";

import { useActionState } from "react";
import { deleteStudentFaceDataAction, type ActionState } from "@/modules/privacy/actions";
import { Panel } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

const initialState: ActionState = {};

/**
 * The erasure workflow: delete every face template this student has.
 *
 * ## Why this exists as its own control
 *
 * Deactivation is what the enrollment screen already offers, and it is the
 * right default — a template hidden from recognition, recoverable if the
 * deactivation was a mistake. It is not, however, an answer to "delete my
 * biometric data". Answering that request with a soft delete is answering it
 * untruthfully, so there has to be a control that actually destroys the rows,
 * and it has to be reachable by the administrator the request lands on rather
 * than by a database console.
 *
 * ## Why the student code has to be typed
 *
 * This is irreversible and the subject has to physically return to re-enroll,
 * so the cost of doing it to the wrong student is paid by that student. Typing
 * the code is friction against a misclick on the wrong row — it is not a
 * security control, because the expected value is rendered on this page. The
 * control is `faceEmbedding.manage` plus the institution check in the service.
 *
 * What survives: the attendance register. Deleting a template clears the
 * advisory match pointer and leaves every record's date, result and correction
 * history intact.
 */
export function DeleteFaceData({
  studentId,
  studentCode,
}: {
  studentId: string;
  studentCode: string;
}) {
  const [state, formAction, pending] = useActionState(deleteStudentFaceDataAction, initialState);

  return (
    <Panel
      title="Delete this student's face data"
      description="Removes every face template for this student, active and deactivated. This cannot be undone; the student can enroll again in person."
    >
      <form action={formAction} className="flex max-w-lg flex-col gap-3">
        <input type="hidden" name="studentId" value={studentId} />
        {/* The expected value, so the action can compare without a second
            lookup. It is not a secret — it is printed at the top of this page
            and this field guards against a misclick, not against its sender. */}
        <input type="hidden" name="studentCode" value={studentCode} />

        <Field label={`Type ${studentCode} to confirm`} htmlFor="confirm">
          <Input
            id="confirm"
            name="confirm"
            autoComplete="off"
            placeholder={studentCode}
            className="max-w-48"
          />
        </Field>

        {state.error ? (
          <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            {state.error}
          </p>
        ) : null}
        {state.message ? (
          <p role="status" className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-800">
            {state.message}
          </p>
        ) : null}

        <div>
          <Button type="submit" variant="danger" disabled={pending}>
            {pending ? "Deleting…" : "Delete face data"}
          </Button>
        </div>
      </form>
    </Panel>
  );
}
