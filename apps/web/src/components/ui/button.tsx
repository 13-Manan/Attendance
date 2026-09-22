import type { ButtonHTMLAttributes } from "react";

type ButtonVariant = "primary" | "secondary" | "danger";

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: "bg-neutral-900 text-white hover:bg-neutral-700 disabled:bg-neutral-300",
  secondary:
    "bg-white text-neutral-900 border border-neutral-300 hover:bg-neutral-50 disabled:text-neutral-400",
  danger: "bg-red-600 text-white hover:bg-red-700 disabled:bg-red-300",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

export function Button({ variant = "primary", className = "", ...props }: ButtonProps) {
  return (
    <button
      className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 focus-visible:ring-offset-2 disabled:cursor-not-allowed sm:min-h-10 ${VARIANT_CLASSES[variant]} ${className}`}
      {...props}
    />
  );
}
