"use client";

import Link from "next/link";
import { useId, useState } from "react";
import type { TeacherToday, TodayRegisterState, TodayRegisterView } from "@/modules/attendance-today/types";
import { AlertIcon, CameraIcon, CheckIcon, CircleIcon, ClockIcon } from "./icons";

/**
 * The teacher's Today card: today's date, who is signed in, the register to
 * take with where it stands, and one dominant button — "Take today's
 * attendance", "Continue attendance", "Review attendance" — or, once it is
 * completed, "View attendance".
 *
 * A client component only for the "Which class?" selector. Every link it can
 * show was computed on the server from the teacher's own assignments, and the
 * pages they open authorize the class and subject again — choosing an option
 * here changes which link the button follows, nothing more.
 */

function registerTitle(r: TodayRegisterView): string {
  return r.subjectName ?? r.className;
}

function registerSubtitle(r: TodayRegisterView): string {
  const bits: string[] = [];
  if (r.subjectName) {
    if (r.subjectCode) bits.push(r.subjectCode);
    bits.push(r.className);
  } else if (r.termLabel) {
    bits.push(r.termLabel);
  }
  bits.push(`${r.studentCount} student${r.studentCount === 1 ? "" : "s"}`);
  return bits.join(" · ");
}

const STATUS_TONE: Record<TodayRegisterState, string> = {
  not_started: "bg-neutral-100 text-neutral-700",
  in_progress: "bg-sky-50 text-sky-800",
  in_review: "bg-amber-50 text-amber-900",
  done: "bg-emerald-50 text-emerald-800",
};

/** Where a register stands — an icon and a word, so colour is never the only signal. */
function StatusChip({ register, className = "" }: { register: TodayRegisterView; className?: string }) {
  const Icon =
    register.state === "done"
      ? CheckIcon
      : register.state === "in_review"
        ? AlertIcon
        : register.state === "in_progress"
          ? ClockIcon
          : CircleIcon;
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_TONE[register.state]} ${className}`}
    >
      <Icon className="size-3.5" />
      {register.statusLabel}
    </span>
  );
}

const QUIET_LINK =
  "inline-flex min-h-11 items-center text-sm font-medium text-neutral-600 underline-offset-4 hover:text-neutral-900 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 rounded-sm";

const PRIMARY_LINK =
  "flex min-h-14 w-full items-center justify-center gap-2 rounded-xl bg-neutral-900 px-4 text-base font-semibold text-white shadow-sm transition-colors hover:bg-neutral-700 active:bg-neutral-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 focus-visible:ring-offset-2";

export function TodayAttendance({
  today,
  greeting,
  heading = "h1",
}: {
  today: TeacherToday;
  /** Who is signed in — "Priya Nair · Class Teacher" — shown small, under the date. */
  greeting?: string | null;
  /** h1 when the card is the page; h2 when it sits inside another page. */
  heading?: "h1" | "h2";
}) {
  const Heading = heading;
  // Unique per card. A second copy of this card in the document — the router
  // can keep an earlier page mounted while hidden — must not share the radio
  // group: React refuses to sync radios it does not manage under one name
  // (error #90), which broke the tap that chooses a class.
  const headingId = useId();
  const groupName = useId();
  const [selectedKey, setSelectedKey] = useState(today.selectedKey);
  const selected = today.choices.find((c) => c.key === selectedKey) ?? today.choices[0] ?? null;
  const subjectWise = today.attendanceMode === "SUBJECT_WISE";

  return (
    <section aria-labelledby={headingId} className="flex w-full flex-col gap-4 sm:max-w-xl">
      <header className="flex flex-col gap-0.5">
        <span className="text-xs font-semibold uppercase tracking-wider text-neutral-500">Today</span>
        <Heading id={headingId} className="text-2xl font-semibold tracking-tight text-neutral-900">
          {today.date.long}
        </Heading>
        {greeting ? <p className="text-sm text-neutral-500">{greeting}</p> : null}
      </header>

      {selected ? (
        <div className="flex flex-col gap-4 rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm sm:p-5">
          {today.kind === "choose" ? (
            <fieldset className="flex min-w-0 flex-col gap-2">
              <legend className="mb-1 text-sm font-medium text-neutral-700">
                {subjectWise ? "Which class are you teaching?" : "Which class?"}
              </legend>
              {today.choices.map((choice) => (
                <label
                  key={choice.key}
                  className="flex min-h-14 cursor-pointer items-center gap-3 rounded-xl border border-neutral-200 px-3 py-2 transition-colors hover:bg-neutral-50 has-[input:checked]:border-neutral-900 has-[input:checked]:bg-neutral-50 has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-neutral-900"
                >
                  <input
                    type="radio"
                    name={groupName}
                    value={choice.key}
                    checked={choice.key === selected.key}
                    onChange={() => setSelectedKey(choice.key)}
                    className="size-5 shrink-0 accent-neutral-900"
                  />
                  {/* Wraps, never truncates: the section is often all that tells two rows of one subject apart.
                      On a phone the status sits under the name, so the name keeps the width. */}
                  <span className="flex min-w-0 flex-1 flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                    <span className="flex min-w-0 flex-col">
                      <span className="break-words text-base font-medium text-neutral-900">{registerTitle(choice)}</span>
                      <span className="break-words text-xs text-neutral-500">{registerSubtitle(choice)}</span>
                    </span>
                    <StatusChip register={choice} className="self-start sm:self-auto" />
                  </span>
                </label>
              ))}
            </fieldset>
          ) : (
            <div className="flex flex-col gap-1">
              <div className="flex items-start justify-between gap-3">
                <p className="min-w-0 text-lg font-semibold leading-snug text-neutral-900">{registerTitle(selected)}</p>
                <StatusChip register={selected} />
              </div>
              <p className="text-sm text-neutral-500">{registerSubtitle(selected)}</p>
            </div>
          )}

          {selected.primary ? (
            // With several classes to choose from, the button stays in reach
            // at the bottom of a phone screen while the list scrolls.
            <div
              className={
                today.kind === "choose"
                  ? "max-md:sticky max-md:bottom-[max(0.75rem,env(safe-area-inset-bottom))] max-md:z-10 max-md:rounded-xl max-md:bg-white max-md:shadow-[0_-4px_16px_rgba(0,0,0,0.08)]"
                  : ""
              }
            >
              <Link href={selected.primary.href} className={PRIMARY_LINK}>
                {selected.state === "in_review" ? <AlertIcon className="size-5" /> : <CameraIcon className="size-5" />}
                {selected.primary.label}
              </Link>
            </div>
          ) : null}
        </div>
      ) : today.kind === "all_done" ? (
        <div className="flex flex-col gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 sm:p-5">
          <p className="flex items-center gap-2 text-lg font-semibold text-emerald-900">
            <CheckIcon className="size-5" />
            Today&apos;s attendance is done
          </p>
          <ul className="flex flex-col divide-y divide-emerald-100">
            {today.done.map((r) => (
              <li key={r.key} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-1.5">
                <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm text-emerald-900">
                  {registerTitle(r)}
                  {r.subjectName ? <span className="text-emerald-700">· {r.className}</span> : null}
                  <StatusChip register={r} />
                </span>
                {r.viewToday ? (
                  <Link href={r.viewToday.href} className={QUIET_LINK}>
                    {r.viewToday.label}
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="flex flex-col gap-2 rounded-2xl border border-dashed border-neutral-300 p-4 sm:p-5">
          <p className="text-base font-semibold text-neutral-900">No class to take today</p>
          <p className="text-sm text-neutral-600">
            {today.withoutStudents.length > 0
              ? "Your classes have no students yet. Ask your administrator to add them."
              : "You aren't assigned to a class for this academic year. Ask your administrator to link you to your class."}
          </p>
        </div>
      )}

      <nav aria-label="More attendance" className="flex flex-wrap gap-x-5">
        {selected?.viewToday ? (
          <Link href={selected.viewToday.href} className={QUIET_LINK}>
            {selected.viewToday.label}
          </Link>
        ) : null}
        {selected ? (
          <Link href={selected.history.href} className={QUIET_LINK}>
            {selected.history.label}
          </Link>
        ) : null}
        <Link href="/dashboard/attendance/sessions" className={QUIET_LINK}>
          Other sessions
        </Link>
        <Link href="/dashboard/attendance" className={QUIET_LINK}>
          All classes
        </Link>
      </nav>

      {today.choices.length > 0 && today.done.length > 0 ? (
        <p className="text-xs text-neutral-500">
          Done today:{" "}
          {today.done.map((r, index) => (
            <span key={r.key}>
              {index > 0 ? ", " : ""}
              {r.viewToday ? (
                <Link href={r.viewToday.href} className="underline underline-offset-2 hover:text-neutral-900">
                  {registerTitle(r)}
                </Link>
              ) : (
                registerTitle(r)
              )}
            </span>
          ))}
        </p>
      ) : null}
      {today.withoutStudents.length > 0 && today.choices.length > 0 ? (
        <p className="text-xs text-neutral-500">
          {today.withoutStudents.map((w) => w.subjectName ?? w.className).join(", ")}{" "}
          {today.withoutStudents.length === 1 ? "has" : "have"} no students yet.
        </p>
      ) : null}
    </section>
  );
}
