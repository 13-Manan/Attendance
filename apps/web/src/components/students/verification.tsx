import type { ReactNode } from "react";
import { missingSummary, type StudentVerification } from "@/modules/students/verification";
import { Badge } from "@/components/ui/badge";

/**
 * A student's verification, as a compact badge for a list and as a checklist
 * for a student's own page — the same computed state either way
 * (modules/students/verification.ts). Counts and states only.
 */

export function VerificationBadge({ verification }: { verification: StudentVerification | undefined }) {
  if (!verification || verification.overall === "off_roll") {
    return <span className="text-sm text-neutral-400">—</span>;
  }
  if (verification.overall === "complete") {
    return <Badge tone="positive">✓ Complete</Badge>;
  }
  return (
    <span className="flex flex-col items-start gap-1">
      <Badge tone="warning">⚠ Incomplete</Badge>
      <span className="text-xs text-neutral-500">{missingSummary(verification)}</span>
    </span>
  );
}

export function VerificationChecklist({
  verification,
  actions,
}: {
  verification: StudentVerification;
  /** The way to finish what is missing, shown under the checklist. */
  actions?: ReactNode;
}) {
  if (verification.overall === "off_roll") {
    return (
      <p className="text-sm text-neutral-600">
        Not on roll, so there is nothing to verify: they are out of every register and out of recognition.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-2" aria-label="Verification checklist">
        {verification.items.map((item) => (
          <li key={item.key} className="flex items-start gap-2 text-sm">
            <span
              aria-hidden
              className={`mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                item.complete ? "bg-green-100 text-green-800" : "bg-amber-100 text-amber-900"
              }`}
            >
              {item.complete ? "✓" : "!"}
            </span>
            <span className="flex flex-col">
              <span className="font-medium text-neutral-900">
                {item.label}
                <span className="sr-only">{item.complete ? ": complete" : ": incomplete"}</span>
              </span>
              <span className="text-xs text-neutral-600">{item.detail}</span>
            </span>
          </li>
        ))}
      </ul>
      <p className="flex flex-wrap items-center gap-2 border-t border-neutral-100 pt-3 text-sm text-neutral-700">
        Overall:
        {verification.overall === "complete" ? (
          <Badge tone="positive">✓ Complete</Badge>
        ) : (
          <Badge tone="warning">⚠ Incomplete</Badge>
        )}
      </p>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
