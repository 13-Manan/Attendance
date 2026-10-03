import Link from "next/link";
import type { ReactNode } from "react";
import type {
  TwinConfirmationDetail,
  TwinConfirmationList,
  TwinHistoryEntry,
  TwinPairState,
  TwinReviewItem,
  TwinStudentSummary,
} from "@/modules/twin-confirmation/types";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { EmptyState, Panel } from "@/components/ui/panel";
import { TwinDecisionForm } from "./decision-form";

/**
 * Twin / lookalike confirmations, as the school's Students area and a college
 * department's Students page both show them. The pages differ only in where
 * they sit and what they link back to; the content and its rules are here.
 *
 * Metadata only: names, student IDs, classes, sample counts and dates. No
 * photograph, template or similarity score is shown — a reviewer decides from
 * knowing the students, not from the model's number.
 */

const STATE_LABEL: Record<TwinPairState, string> = {
  pending: "Pending confirmation",
  confirmed: "Confirmed different people",
  rejected: "Not confirmed",
};

const STATE_TONE: Record<TwinPairState, BadgeTone> = {
  pending: "warning",
  confirmed: "positive",
  rejected: "danger",
};

export const MOMENT_FORMAT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export const TWIN_REASON = "Face enrollment appears similar to an existing enrolled student.";

export function name(student: { firstName: string; lastName: string }): string {
  return `${student.firstName} ${student.lastName}`.trim();
}

export function classes(student: { classes: string[] }): string {
  return student.classes.length > 0 ? student.classes.join(", ") : "Not in a class";
}

/** A decision in a pair's history, in words. */
function historyLabel(entry: TwinHistoryEntry): string {
  if (entry.kind === "withdrawn") return "Known twin/lookalike declaration removed";
  if (entry.kind === "confirmed") {
    return entry.source === "declared" ? "Marked as known twin/lookalike" : "Confirmed different people";
  }
  return "Not confirmed";
}

function faceStatus(student: TwinStudentSummary): string {
  if (student.activeFaceSamples === 0) return "Face not enrolled";
  const count = `${student.activeFaceSamples} face ${student.activeFaceSamples === 1 ? "sample" : "samples"}`;
  return student.lastFaceEnrolledAt
    ? `Face enrolled · ${count} · last ${MOMENT_FORMAT.format(student.lastFaceEnrolledAt)}`
    : `Face enrolled · ${count}`;
}

function StudentLine({ label, student }: { label: string; student: TwinStudentSummary }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-xs uppercase tracking-wide text-neutral-500">{label}</span>
      <span className="text-sm font-medium text-neutral-900">
        {name(student)} <span className="font-mono text-xs font-normal text-neutral-500">{student.studentCode}</span>
      </span>
      <span className="text-xs text-neutral-600">Class: {classes(student)}</span>
    </div>
  );
}

function ItemCard({ item, href }: { item: TwinReviewItem; href: string }) {
  return (
    <li className="flex flex-col gap-3 py-4 first:pt-0 sm:flex-row sm:items-start sm:justify-between">
      <div className="grid min-w-0 flex-1 gap-3 sm:grid-cols-2">
        <StudentLine label="Student" student={item.blocked} />
        <StudentLine label="Potential match" student={item.matched} />
        <p className="text-xs text-neutral-600 sm:col-span-2">
          {TWIN_REASON} Detected {MOMENT_FORMAT.format(item.lastDetectedAt)}
          {item.attempts > 1 ? ` · ${item.attempts} attempts` : ""}
          {item.lastChannel === "SELF" ? " · student self-enrollment" : item.lastChannel === "STAFF" ? " · staff enrollment" : ""}
          {item.decidedAt
            ? ` · decided ${MOMENT_FORMAT.format(item.decidedAt)}${item.decidedByName ? ` by ${item.decidedByName}` : ""}`
            : ""}
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <Badge tone={STATE_TONE[item.state]}>{STATE_LABEL[item.state]}</Badge>
        <Link
          href={href}
          className="inline-flex min-h-11 items-center justify-center rounded-md border border-neutral-300 bg-white px-4 py-2 text-sm font-medium text-neutral-900 hover:bg-neutral-50 sm:min-h-10"
        >
          {item.state === "pending" ? "Review" : "Open"}
          <span className="sr-only">
            {" "}
            {name(item.blocked)} and {name(item.matched)}
          </span>
        </Link>
      </div>
    </li>
  );
}

/** Who reviews here, in a sentence — and who reviews what this page does not show. */
function scopeNote(list: TwinConfirmationList["reviewer"]): string {
  if (list.department) {
    return `Pairs where both students are in ${list.department.name}'s current sections. A pair with a student in another department is confirmed by the Director.`;
  }
  if (list.kind === "class_teacher") {
    return "Pairs where both students are in a class you are the class teacher of. A pair across two classes is confirmed by the principal.";
  }
  return list.institutionType === "SCHOOL"
    ? "Every pair in the school. Class teachers can also confirm pairs within their own class."
    : "Every pair in the college. Heads of department can also confirm pairs within their department.";
}

export function TwinConfirmationListView({
  list,
  itemHref,
  decided,
  known,
}: {
  list: TwinConfirmationList;
  itemHref: (pair: string) => string;
  decided: string | null;
  /** Pairs marked in advance, and the way to mark one — between the queue and its history. */
  known?: ReactNode;
}) {
  return (
    <>
      {decided === "confirmed" || decided === "rejected" ? (
        <p role="status" className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-800">
          {decided === "confirmed"
            ? "Confirmed as different people. Face enrollment can now continue for these two students — the student just tries again."
            : "Recorded as not confirmed. Face enrollment stays blocked for this pair."}
        </p>
      ) : null}

      <Panel title="Pending confirmation" description={scopeNote(list.reviewer)}>
        {list.pending.length === 0 ? (
          <EmptyState>Nothing is waiting for a confirmation.</EmptyState>
        ) : (
          <ul className="flex flex-col divide-y divide-neutral-100">
            {list.pending.map((item) => (
              <ItemCard key={item.pair} item={item} href={itemHref(item.pair)} />
            ))}
          </ul>
        )}
      </Panel>

      {known}

      {list.decided.length > 0 ? (
        <Panel title="Decided" description="A decision can be changed: open the pair and decide again. Every decision is recorded.">
          <ul className="flex flex-col divide-y divide-neutral-100">
            {list.decided.map((item) => (
              <ItemCard key={item.pair} item={item} href={itemHref(item.pair)} />
            ))}
          </ul>
        </Panel>
      ) : null}
    </>
  );
}

function StudentPanel({ label, student }: { label: string; student: TwinStudentSummary }) {
  return (
    <section className="flex flex-col gap-2 rounded-lg border border-neutral-200 bg-white p-4">
      <p className="text-xs font-semibold uppercase tracking-wider text-neutral-500">{label}</p>
      <p className="text-base font-semibold text-neutral-900">{name(student)}</p>
      <dl className="grid gap-2 text-sm">
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs uppercase tracking-wide text-neutral-500">Student ID</dt>
          <dd className="font-mono text-neutral-900">{student.studentCode}</dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs uppercase tracking-wide text-neutral-500">Class / section</dt>
          <dd className="text-neutral-900">{classes(student)}</dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs uppercase tracking-wide text-neutral-500">Enrollment</dt>
          <dd className="text-neutral-900">{faceStatus(student)}</dd>
        </div>
      </dl>
    </section>
  );
}

export function TwinConfirmationReviewView({
  detail,
  departmentId,
  listHref,
}: {
  detail: TwinConfirmationDetail;
  departmentId: string | null;
  listHref: string;
}) {
  const { item, history } = detail;
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={STATE_TONE[item.state]}>{STATE_LABEL[item.state]}</Badge>
        <span className="text-xs text-neutral-500">
          Detected {MOMENT_FORMAT.format(item.lastDetectedAt)}
          {item.attempts > 1 ? ` · ${item.attempts} attempts since ${MOMENT_FORMAT.format(item.firstDetectedAt)}` : ""}
        </span>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <StudentPanel label="Student A — enrollment blocked" student={item.blocked} />
        <StudentPanel label="Student B — already enrolled" student={item.matched} />
      </div>

      <Panel
        title="Why this needs a decision"
        description="The face being enrolled for Student A is close enough to Student B's that recognition would treat them as the same person."
      >
        <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-neutral-700">
          <li>{TWIN_REASON}</li>
          <li>
            If they are the same person — one student entered twice — choose <strong>Not confirmed</strong> and
            merge or take the duplicate record off roll.
          </li>
          <li>
            If they are two different people — identical twins, or students who look alike — confirm it. Enrollment
            can then continue for these two students only; every other pair stays protected.
          </li>
        </ul>
      </Panel>

      <Panel
        title={item.state === "pending" ? "Decision" : "Change the decision"}
        description={
          item.state === "pending"
            ? "Recorded with your name and the time."
            : `Currently: ${STATE_LABEL[item.state]}${item.decidedByName ? `, by ${item.decidedByName}` : ""}${item.decidedAt ? ` on ${MOMENT_FORMAT.format(item.decidedAt)}` : ""}.`
        }
      >
        <TwinDecisionForm pair={item.pair} state={item.state} departmentId={departmentId} cancelHref={listHref} />
      </Panel>

      {history.length > 0 ? (
        <Panel title="History">
          <ol className="flex flex-col divide-y divide-neutral-100">
            {history.map((entry, index) => (
              <li key={index} className="flex flex-wrap items-baseline justify-between gap-2 py-2 text-sm first:pt-0">
                <span className="text-neutral-800">
                  {entry.kind === "conflict" ? entry.detail : `${historyLabel(entry)} — ${entry.detail}`}
                </span>
                <span className="text-xs text-neutral-500">{MOMENT_FORMAT.format(entry.at)}</span>
              </li>
            ))}
          </ol>
        </Panel>
      ) : null}
    </>
  );
}
