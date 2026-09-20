import type { BlockerKind, ReadinessItem } from "@/modules/platform/service";

/**
 * The blocker list, rendered so it cannot be skimmed as reassurance.
 *
 * Two deliberate choices:
 *
 * **No green.** There is no "all clear" state and no tick. A readiness list
 * whose happy path looks like success invites the reading it exists to
 * prevent, and this deployment's happy path does not exist yet anyway.
 *
 * **Kind is a word, not a colour.** "Licensing" and "security hardening" are
 * answered by different people and on different timescales; a colour says only
 * "bad". The amber tint on blocking items is redundant with the word
 * "Blocking" beside them, which is what makes it safe to use at all.
 */

const KIND_LABEL: Record<BlockerKind, string> = {
  licensing: "Licensing / provenance",
  technical: "Technical",
  "security-hardening": "Security hardening",
  configuration: "Configuration required",
  policy: "Policy decision required",
};

export function ReadinessList({ items }: { items: ReadinessItem[] }) {
  if (items.length === 0) {
    return (
      <p className="text-sm text-neutral-600">
        No readiness items are recorded for this build.
      </p>
    );
  }

  return (
    <ul className="flex flex-col divide-y divide-neutral-100">
      {items.map((item) => (
        <li key={item.id} className="flex flex-col gap-1.5 py-3 first:pt-0 last:pb-0">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <h3 className="text-sm font-medium text-neutral-900">{item.title}</h3>
            {item.blocking ? (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-900 ring-1 ring-inset ring-amber-300">
                Blocking release
              </span>
            ) : (
              <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-medium text-neutral-700 ring-1 ring-inset ring-neutral-300">
                Not blocking
              </span>
            )}
            <span className="text-xs text-neutral-500">{KIND_LABEL[item.kind]}</span>
          </div>
          <p className="text-sm text-neutral-600">{item.detail}</p>
          {item.evidence ? (
            <p className="text-xs text-neutral-500">
              Evidence: <code className="font-mono">{item.evidence}</code>
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
