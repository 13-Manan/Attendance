import type { InputHTMLAttributes } from "react";

export function Input({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`w-full rounded-md border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-500 focus:ring-1 focus:ring-neutral-500 ${className}`}
      {...props}
    />
  );
}
