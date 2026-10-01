"use client";

import type { ButtonHTMLAttributes, ReactNode, RefObject } from "react";
import { AlertIcon, ArrowLeftIcon, CheckIcon, Spinner } from "@/components/attendance/icons";
import type { PhotoStatus } from "@/modules/attendance-capture/capture-flow";

/**
 * The pieces the capture screens are built from. Presentation only — every
 * decision about what to show comes from `capture-flow.ts` and the wizard.
 *
 * On a phone the flow takes the whole screen: the camera is the task, and the
 * app's navigation, breadcrumbs and page title are in its way. From the `md`
 * breakpoint up it sits in the page as a card, so a laptop keeps its context.
 */

export type ShellTone = "dark" | "light";

function join(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

const FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2";

/**
 * Button looks for each tone. A dark step is dark only on a phone; on a wider
 * screen the same buttons sit on the white card, so they switch back.
 */
export function toneClasses(tone: ShellTone) {
  if (tone === "dark") {
    return {
      primary: join(
        "bg-white text-neutral-900 hover:bg-neutral-200 disabled:bg-white/25 disabled:text-white/70 focus-visible:ring-white focus-visible:ring-offset-neutral-950",
        "md:bg-neutral-900 md:text-white md:hover:bg-neutral-700 md:disabled:bg-neutral-300 md:disabled:text-white md:focus-visible:ring-neutral-900 md:focus-visible:ring-offset-white",
      ),
      secondary: join(
        "border border-white/40 bg-transparent text-white hover:bg-white/10 focus-visible:ring-white focus-visible:ring-offset-neutral-950",
        "md:border-neutral-300 md:bg-white md:text-neutral-900 md:hover:bg-neutral-50 md:focus-visible:ring-neutral-900 md:focus-visible:ring-offset-white",
      ),
      quiet: "text-white/80 hover:text-white md:text-neutral-600 md:hover:text-neutral-900",
      muted: "text-white/70 md:text-neutral-500",
      body: "text-white/90 md:text-neutral-700",
    };
  }
  return {
    primary:
      "bg-neutral-900 text-white hover:bg-neutral-700 disabled:bg-neutral-300 focus-visible:ring-neutral-900",
    secondary:
      "border border-neutral-300 bg-white text-neutral-900 hover:bg-neutral-50 focus-visible:ring-neutral-900",
    quiet: "text-neutral-600 hover:text-neutral-900",
    muted: "text-neutral-500",
    body: "text-neutral-700",
  };
}

export function ActionButton({
  tone,
  kind = "primary",
  size = "md",
  className = "",
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  tone: ShellTone;
  kind?: "primary" | "secondary" | "quiet";
  size?: "md" | "lg";
}) {
  const t = toneClasses(tone);
  return (
    <button
      type="button"
      className={join(
        "inline-flex items-center justify-center gap-2 rounded-xl font-semibold transition-colors disabled:cursor-not-allowed",
        FOCUS,
        kind === "quiet"
          ? join("min-h-11 px-2 text-sm font-medium underline-offset-4 hover:underline", t.quiet)
          : join(size === "lg" ? "min-h-14 px-5 text-base" : "min-h-12 px-4 text-sm", t[kind]),
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// The shell
// ---------------------------------------------------------------------------

export function CaptureShell({
  tone,
  title,
  subtitle,
  onBack,
  backLabel,
  backDisabled = false,
  headingRef,
  heading,
  showHeading = true,
  notices,
  children,
  footer,
}: {
  tone: ShellTone;
  title: string;
  subtitle: string;
  onBack: () => void;
  backLabel: string;
  backDisabled?: boolean;
  /** Focused when the step changes, so a screen reader hears where it is. */
  headingRef: RefObject<HTMLHeadingElement | null>;
  /** The step's name: visible on a wide screen, read out on a phone. */
  heading: string;
  /** False when the step shows its own large title: then the heading is only
   * read out, so nobody sees or hears it twice. */
  showHeading?: boolean;
  notices?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const dark = tone === "dark";
  return (
    <section
      aria-label="Take attendance"
      className={join(
        "flex flex-col overflow-hidden",
        "max-md:fixed max-md:inset-0 max-md:z-50 max-md:h-dvh max-md:overscroll-contain",
        dark ? "max-md:bg-neutral-950 max-md:text-white" : "max-md:bg-white",
        "md:rounded-2xl md:border md:border-neutral-200 md:bg-white",
      )}
    >
      <header
        className={join(
          "flex items-center gap-1 px-2 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))] md:hidden",
          dark ? "" : "border-b border-neutral-200",
        )}
      >
        <button
          type="button"
          onClick={onBack}
          disabled={backDisabled}
          aria-label={`Back to ${backLabel}`}
          className={join(
            "inline-flex size-11 shrink-0 items-center justify-center rounded-full transition-colors disabled:opacity-40",
            FOCUS,
            dark ? "hover:bg-white/10 focus-visible:ring-white focus-visible:ring-offset-neutral-950" : "hover:bg-neutral-100 focus-visible:ring-neutral-900",
          )}
        >
          <ArrowLeftIcon className="size-6" />
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-base font-semibold leading-tight">{title}</p>
          <p className={join("truncate text-xs", dark ? "text-white/70" : "text-neutral-500")}>{subtitle}</p>
        </div>
      </header>
      <h2
        ref={headingRef}
        tabIndex={-1}
        className={join(
          showHeading ? "max-md:sr-only md:px-5 md:pt-5" : "sr-only",
          "text-base font-semibold text-neutral-900 focus:outline-none",
        )}
      >
        {heading}
      </h2>
      {notices}
      <div className="flex min-h-0 flex-1 flex-col md:flex-none">{children}</div>
      {footer ? (
        <footer className="flex flex-col gap-3 px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))] md:px-5 md:pb-5">
          {footer}
        </footer>
      ) : null}
    </section>
  );
}

/** The dark frame the camera and the photos sit in. */
export function Viewfinder({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={join(
        "relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-neutral-950",
        "md:mx-5 md:mt-3 md:aspect-video md:flex-none md:rounded-xl",
        className,
      )}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

/** The shutter: big, round, in the thumb's reach, and labelled for a screen reader. */
export function ShutterButton({
  label,
  disabled,
  onClick,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className={join(
        "relative inline-flex size-[72px] shrink-0 items-center justify-center rounded-full border-4 border-white bg-white/20 transition-transform active:scale-95 disabled:opacity-40",
        "md:border-neutral-900 md:bg-neutral-100",
        FOCUS,
        "focus-visible:ring-white focus-visible:ring-offset-neutral-950 md:focus-visible:ring-neutral-900 md:focus-visible:ring-offset-white",
      )}
    >
      <span className="size-[52px] rounded-full bg-white md:bg-neutral-900" aria-hidden="true" />
    </button>
  );
}

const CHIP_TONE: Record<PhotoStatus["tone"], string> = {
  checking: "bg-neutral-900/80 text-white ring-1 ring-white/20",
  good: "bg-emerald-600 text-white",
  warning: "bg-amber-400 text-neutral-950",
  bad: "bg-red-600 text-white",
};

/** One photo's check, over the photo. Not colour alone: an icon and words too. */
export function StatusChip({ status, className = "" }: { status: PhotoStatus; className?: string }) {
  return (
    <span
      role="status"
      className={join(
        "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium shadow-sm",
        CHIP_TONE[status.tone],
        className,
      )}
    >
      {status.tone === "checking" ? (
        <Spinner className="size-4" />
      ) : status.tone === "good" ? (
        <CheckIcon className="size-4" />
      ) : (
        <AlertIcon className="size-4" />
      )}
      {status.label}
    </span>
  );
}

/**
 * A two-step confirmation drawn inline, in place of a dialog: the question,
 * the safe answer, and the one that does something.
 */
export function ConfirmBar({
  tone,
  message,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  busy = false,
}: {
  tone: ShellTone;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
}) {
  const t = toneClasses(tone);
  return (
    <div
      role="group"
      aria-label={message}
      aria-live="polite"
      className={join(
        "flex flex-col gap-3 rounded-xl p-3",
        tone === "dark" ? "bg-white/10 md:bg-neutral-50" : "bg-neutral-50",
      )}
    >
      <p className={join("text-sm", t.body)}>{message}</p>
      <div className="grid grid-cols-2 gap-2">
        <ActionButton tone={tone} kind="secondary" onClick={onCancel} disabled={busy}>
          {cancelLabel}
        </ActionButton>
        <ActionButton tone={tone} kind="primary" onClick={onConfirm} disabled={busy}>
          {busy ? <Spinner className="size-4" /> : null}
          {confirmLabel}
        </ActionButton>
      </div>
    </div>
  );
}
