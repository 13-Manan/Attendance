import type { InputHTMLAttributes, ReactNode } from "react";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /**
   * Optional element rendered inside the input's right edge — a password
   * visibility toggle, a clear button, a unit label. When present the input's
   * trailing padding is enlarged so the value never runs into the slot.
   *
   * Additive and opt-in: every existing call site is a plain `<Input />` and
   * behaves exactly as before.
   */
  trailing?: ReactNode;
}

export function Input({ className = "", trailing, ...props }: InputProps) {
  const baseClasses =
    "w-full rounded-md border border-neutral-300 py-2 text-sm outline-none focus:border-neutral-500 focus:ring-1 focus:ring-neutral-500 aria-[invalid=true]:border-red-500 aria-[invalid=true]:focus:border-red-500 aria-[invalid=true]:focus:ring-red-500 disabled:cursor-not-allowed disabled:bg-neutral-50 disabled:text-neutral-400 read-only:cursor-default read-only:bg-neutral-50 read-only:text-neutral-500";

  if (!trailing) {
    return <input className={`${baseClasses} px-3 ${className}`} {...props} />;
  }

  // Positioning wrapper: the input remains the focusable target; the trailing
  // slot floats on top. `pr-10` keeps the value clear of a 40px tap zone.
  return (
    <span className="relative block">
      <input className={`${baseClasses} pr-10 pl-3 ${className}`} {...props} />
      <span className="absolute inset-y-0 right-0 flex items-center pr-1">{trailing}</span>
    </span>
  );
}
