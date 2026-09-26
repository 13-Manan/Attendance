import Link from "next/link";
import {
  studentClassHref,
  studentSectionHref,
} from "@/modules/students/class-navigation-paths";
import type {
  SectionClassTeacher,
  StudentClassCard,
  StudentSectionSummary,
} from "@/modules/students/class-navigation-types";
import { Badge } from "@/components/ui/badge";
import { LINK_SECONDARY } from "../../academic/classes/shared";

/**
 * The pieces of the class-first Students screens. Server components only;
 * the styles are the Classes screens' own (`academic/classes/shared.tsx`), so
 * the two read as one product.
 */

const FOCUS =
  "rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 focus-visible:ring-offset-2";

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

/** Each class as a card to open: its name, sections and students on roll. */
export function ClassGrid({ classes, yearId }: { classes: StudentClassCard[]; yearId: string }) {
  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
      {classes.map((card) => (
        <li key={card.id}>
          <Link
            href={studentClassHref(card.id, yearId)}
            className={`flex h-full min-h-11 flex-col gap-1 rounded-lg border border-neutral-200 bg-white px-4 py-3 transition-colors hover:border-neutral-400 hover:bg-neutral-50 ${FOCUS}`}
          >
            <span className="text-base font-semibold text-neutral-900">{card.name}</span>
            <span className="text-xs text-neutral-500">
              {plural(card.sectionCount, "section", "sections")} ·{" "}
              {plural(card.studentCount, "student", "students")}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** The class teacher, or the plain fact that there is none. Never an invented name. */
export function ClassTeacherName({ teacher }: { teacher: SectionClassTeacher | null }) {
  if (!teacher) return <span className="text-amber-800">No class teacher assigned</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span className="text-neutral-900">{teacher.name}</span>
      {teacher.active ? null : <Badge tone="danger">Can&apos;t sign in</Badge>}
    </span>
  );
}

/** A class's sections, each with its class teacher, students on roll and the way in. */
export function SectionCards({
  classId,
  sections,
}: {
  classId: string;
  sections: StudentSectionSummary[];
}) {
  return (
    <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {sections.map((section) => {
        const href = studentSectionHref(classId, section.id);
        return (
          <li
            key={section.id}
            className="flex flex-col gap-3 rounded-lg border border-neutral-200 bg-white p-4"
          >
            <div className="flex flex-col gap-0.5">
              <h2 className="text-base font-semibold text-neutral-900">
                <Link href={href} className={`${FOCUS} hover:underline`}>
                  {section.label}
                </Link>
              </h2>
              <p className="text-xs text-neutral-500">Shown elsewhere as {section.groupName}</p>
            </div>
            <dl className="flex flex-col gap-1.5 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                <dt className="text-neutral-500">Class teacher</dt>
                <dd>
                  <ClassTeacherName teacher={section.classTeacher} />
                </dd>
              </div>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                <dt className="text-neutral-500">Students</dt>
                <dd className="tabular-nums text-neutral-900">
                  {plural(section.studentCount, "student", "students")}
                </dd>
              </div>
            </dl>
            <div className="mt-auto">
              <Link href={href} className={LINK_SECONDARY}>
                View students<span className="sr-only"> in {section.label}</span>&nbsp;→
              </Link>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
