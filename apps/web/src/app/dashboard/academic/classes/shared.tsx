import type { BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import type { SectionStatus, YearChoice } from "@/modules/school-setup/types";

/** Pieces shared by the Classes pages. Server components only — nothing here holds state. */

export const LINK_PRIMARY =
  "inline-flex min-h-11 items-center justify-center rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 focus-visible:ring-offset-2 sm:min-h-10";

export const LINK_SECONDARY =
  "inline-flex min-h-11 items-center justify-center rounded-md border border-neutral-300 bg-white px-4 py-2 text-sm font-medium text-neutral-900 hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 focus-visible:ring-offset-2 sm:min-h-10";

export const STATUS_TONE: Record<SectionStatus, BadgeTone> = {
  ready: "positive",
  needs_teacher: "warning",
  teacher_inactive: "danger",
};

export function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Which academic year the page shows. A plain GET form, so it works before
 * the page's JavaScript has loaded and the chosen year is in the URL to share.
 */
export function YearSwitcher({
  action,
  years,
  selectedId,
}: {
  action: string;
  years: YearChoice[];
  selectedId: string;
}) {
  if (years.length < 2) return null;
  return (
    <form method="get" action={action} className="flex items-end gap-2">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="year-switcher" className="text-xs font-medium text-neutral-500">
          Academic year
        </label>
        <Select id="year-switcher" name="year" defaultValue={selectedId} className="min-w-40">
          {years.map((year) => (
            <option key={year.id} value={year.id}>
              {year.name}
              {year.isCurrent ? " (current)" : year.isActive ? "" : " (archived)"}
            </option>
          ))}
        </Select>
      </div>
      <Button type="submit" variant="secondary">
        Show
      </Button>
    </form>
  );
}
