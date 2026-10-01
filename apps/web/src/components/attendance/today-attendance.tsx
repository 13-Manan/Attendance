"use client";

import Link from "next/link";
import { useState } from "react";
import type { TeacherToday, TodayRegisterView } from "@/modules/attendance-today/types";
import { CameraIcon, CheckIcon } from "./icons";

/**
 * The teacher's Today card: today's date, the register to take, and one
 * dominant button.
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

const QUIET_LINK =
  "inline-flex min-h-11 items-center text-sm font-medium text-neutral-600 underline-offset-4 hover:text-neutral-900 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 rounded-sm";

const PRIMARY_LINK =
  "flex min-h-14 w-full items-center justify-center gap-2.5 rounded-xl bg-neutral-900 px-5 text-base font-semibold text-white shadow-sm transition-colors hover:bg-neutral-700 active:bg-neutral-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 focus-visible:ring-offset-2";

export function TodayAttendance({
  today,
  greeting,
  heading = "h1",
}: {
  today: TeacherToday;
  /** "Welcome, Priya Nair" — shown small, under the date. */
  greeting?: string | null;
  /** h1 when the card is the page; h2 when it sits inside another page. */
  heading?: "h1" | "h2";
}) {
  const Heading = heading;
  const [selectedKey, setSelectedKey] = useState(today.selectedKey);
  const selected = today.choices.find((c) => c.key === selectedKey) ?? today.choices[0] ?? null;
  const subjectWise = today.attendanceMode === "SUBJECT_WISE";

  return (
    <section aria-labelledby="today-heading" className="flex w-full flex-col gap-4 sm:max-w-xl">
      <header className="flex flex-col gap-0.5">
        <span className="text-xs font-semibold uppercase tracking-wider text-neutral-500">Today</span>
        <Heading id="today-heading" className="text-2xl font-semibold tracking-tight text-neutral-900">
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
                    name="today-register"
                    value={choice.key}
                    checked={choice.key === selected.key}
                    onChange={() => setSelectedKey(choice.key)}
                    className="size-5 shrink-0 accent-neutral-900"
                  />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-base font-medium text-neutral-900">
                      {registerTitle(choice)}
                    </span>
                    <span className="truncate text-xs text-neutral-500">{registerSubtitle(choice)}</span>
                  </span>
                  <span className="shrink-0 text-xs text-neutral-500">{choice.statusLabel}</span>
                </label>
              ))}
            </fieldset>
          ) : (
            <div className="flex flex-col gap-1">
              <p className="text-lg font-semibold leading-snug text-neutral-900">{registerTitle(selected)}</p>
              <p className="text-sm text-neutral-500">{registerSubtitle(selected)}</p>
              <p className="text-sm text-neutral-700">{selected.statusLabel}</p>
            </div>
          )}

          {selected.primary ? (
            <Link href={selected.primary.href} className={PRIMARY_LINK}>
              <CameraIcon className="size-5" />
              {selected.primary.label}
            </Link>
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
              <li key={r.key} className="flex flex-wrap items-center justify-between gap-x-3 py-1">
                <span className="min-w-0 text-sm text-emerald-900">
                  {registerTitle(r)}
                  {r.subjectName ? <span className="text-emerald-700"> · {r.className}</span> : null}
                  <span className="text-emerald-700"> · {r.statusLabel}</span>
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
