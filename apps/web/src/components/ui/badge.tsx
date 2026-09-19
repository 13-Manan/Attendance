import type { ReactNode } from "react";

/**
 * A small status pill.
 *
 * Tones are named for what they mean to a reader, not for a colour: a campus
 * that is open and a student who is enrolled are both `positive`, and if the
 * palette changes they change together. Colour is never the only signal —
 * every badge carries its own word, so it still reads correctly in greyscale
 * and to somebody who cannot distinguish the hues.
 */
export type BadgeTone = "neutral" | "positive" | "warning" | "danger" | "info";

const TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: "bg-neutral-100 text-neutral-700",
  positive: "bg-green-100 text-green-800",
  warning: "bg-amber-100 text-amber-800",
  danger: "bg-red-100 text-red-800",
  info: "bg-blue-100 text-blue-800",
};

export function Badge({
  tone = "neutral",
  children,
}: {
  tone?: BadgeTone;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${TONE_CLASSES[tone]}`}
    >
      {children}
    </span>
  );
}
