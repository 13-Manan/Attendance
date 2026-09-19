import type { SelectHTMLAttributes } from "react";

/**
 * A `<select>` styled to match `Input`.
 *
 * Shared rather than copied because the GET filter forms that need it are
 * server components — the local copies in the client control files exist to
 * keep those files independent of each other, but a server-rendered filter bar
 * cannot import from a `"use client"` module without dragging it along.
 */
export function Select({ className = "", ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={`w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-500 focus:ring-1 focus:ring-neutral-500 ${className}`}
      {...props}
    />
  );
}
