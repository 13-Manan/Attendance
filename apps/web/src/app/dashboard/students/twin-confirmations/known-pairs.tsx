import Link from "next/link";
import type { KnownTwinPairList, StudentKnownTwins, TwinStudentSummary } from "@/modules/twin-confirmation/types";
import { EmptyState, Panel } from "@/components/ui/panel";
import { DeclareKnownPairForm, KnownPairRows } from "./known-pair-controls";
import { MOMENT_FORMAT, classes, name } from "./twin-views";

/**
 * Known twin / lookalike pairs: the pairs staff marked in advance, on the
 * school's and a department's Twin / Lookalike page, and one student's on
 * their record. Names, student IDs, classes and who marked them — never a
 * photograph, a template or a score.
 */

const VIEW_LINK =
  "inline-flex min-h-11 items-center rounded-sm text-sm font-medium text-neutral-700 underline underline-offset-4 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 sm:min-h-0";

function marked(declaredAt: Date, declaredByName: string | null): string {
  return `Marked ${MOMENT_FORMAT.format(declaredAt)}${declaredByName ? ` by ${declaredByName}` : ""}`;
}

function scopeNote(reviewer: KnownTwinPairList["reviewer"]): string {
  const what =
    "Pairs staff know are twins or lookalikes, marked in advance. Face enrollment does not stop for these two, and attendance sends a match to either of them to review instead of marking them present.";
  if (reviewer.department) return `${what} Students in ${reviewer.department.name}'s current sections.`;
  if (reviewer.kind === "class_teacher") return `${what} Students in the classes you are the class teacher of.`;
  return what;
}

function StudentWithLink({ student, href }: { student: TwinStudentSummary; href: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-sm font-medium text-neutral-900">
        {name(student)} <span className="font-mono text-xs font-normal text-neutral-500">{student.studentCode}</span>
      </span>
      <span className="text-xs text-neutral-600">Class: {classes(student)}</span>
      <Link href={href} className={VIEW_LINK}>
        View<span className="sr-only"> {name(student)}</span>
      </Link>
    </div>
  );
}

/** The section on a Twin / Lookalike page: the pairs, and the way to mark another. */
export function KnownPairsSection({
  list,
  departmentId,
  initialStudentId,
  studentHref,
}: {
  list: KnownTwinPairList;
  departmentId: string | null;
  initialStudentId: string | null;
  studentHref: (studentId: string) => string;
}) {
  return (
    <Panel title="Known twin / lookalike pairs" description={scopeNote(list.reviewer)}>
      <KnownPairRows
        departmentId={departmentId}
        empty={<EmptyState>No pairs have been marked in advance.</EmptyState>}
        rows={list.pairs.map((pair) => ({
          pair: pair.pair,
          names: `${name(pair.students[0])} and ${name(pair.students[1])}`,
          content: (
            <div className="flex flex-col gap-2">
              <div className="grid gap-3 sm:grid-cols-2">
                <StudentWithLink student={pair.students[0]} href={studentHref(pair.students[0].studentId)} />
                <StudentWithLink student={pair.students[1]} href={studentHref(pair.students[1].studentId)} />
              </div>
              <p className="text-xs text-neutral-500">{marked(pair.declaredAt, pair.declaredByName)}</p>
            </div>
          ),
        }))}
      />
      <DeclareKnownPairForm students={list.students} departmentId={departmentId} initialStudentId={initialStudentId} />
    </Panel>
  );
}

/** One student's known pairs, on their record, for somebody who may manage them. */
export function StudentKnownTwinsPanel({
  known,
  departmentId,
  declareHref,
  studentHref,
}: {
  known: StudentKnownTwins;
  departmentId: string | null;
  declareHref: string;
  studentHref: (studentId: string) => string;
}) {
  return (
    <Panel
      title="Twin / Lookalike"
      description="A known twin or lookalike is reviewed at attendance rather than marked present on a face match."
      action={
        known.canDeclare ? (
          <Link
            href={declareHref}
            className="inline-flex min-h-11 items-center justify-center rounded-md border border-neutral-300 bg-white px-4 py-2 text-sm font-medium text-neutral-900 hover:bg-neutral-50 sm:min-h-10"
          >
            Mark as known twin/lookalike
          </Link>
        ) : null
      }
    >
      <KnownPairRows
        departmentId={departmentId}
        empty={<p className="text-sm text-neutral-600">No known twin/lookalike pair.</p>}
        rows={known.pairs.map((pair) => ({
          pair: pair.pair,
          names: name(pair.other),
          content: (
            <div className="flex flex-col gap-0.5">
              <p className="text-sm text-neutral-900">
                Known twin/lookalike: <span className="font-medium">{name(pair.other)}</span> — ID{" "}
                <span className="font-mono">{pair.other.studentCode}</span>
              </p>
              <p className="text-xs text-neutral-600">
                Class: {classes(pair.other)} · {marked(pair.declaredAt, pair.declaredByName)}
              </p>
              <Link href={studentHref(pair.other.studentId)} className={VIEW_LINK}>
                View<span className="sr-only"> {name(pair.other)}</span>
              </Link>
            </div>
          ),
        }))}
      />
    </Panel>
  );
}
