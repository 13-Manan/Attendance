"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { revealStudentPasswordAction } from "@/modules/student-password-reveal/actions";
import { Button } from "@/components/ui/button";
import { usePageLeft } from "@/components/ui/use-page-left";

/** How long a revealed password stays on screen before it is hidden again. */
const SHOWN_FOR_MS = 60_000;

/**
 * "Portal password": a student's current password, for staff who may see it,
 * shown only when they ask.
 *
 * Nothing about the password is in the page this sits on — only whether one
 * can be shown. "Show current password" asks the server, which checks who is
 * asking again, records the reveal, and answers in that one response. The
 * password then lives in this component's state and on screen until Hide, a
 * minute passing, or the page being left — whichever comes first — and is
 * never written to storage, a cookie or the address bar. Copy puts it on the
 * clipboard, because that is what copying is; nothing else keeps it.
 */
export function PortalPasswordReveal({
  studentId,
  recoverable,
}: {
  studentId: string;
  /** Whether a recoverable copy exists. False: an account from before, reset to issue one. */
  recoverable: boolean;
}) {
  const [password, setPassword] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ unavailable: boolean; text: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [focusOn, setFocusOn] = useState<"show" | "hide" | null>(null);
  const [pending, startTransition] = useTransition();
  const left = usePageLeft();
  const box = useRef<HTMLDivElement>(null);
  const labelId = useId();
  const visible = left ? null : password;

  // Dropped, not just hidden, when the page is left.
  useEffect(() => {
    const drop = () => setPassword(null);
    window.addEventListener("pagehide", drop);
    return () => window.removeEventListener("pagehide", drop);
  }, []);

  useEffect(() => {
    if (!visible) return;
    const timer = setTimeout(() => setPassword(null), SHOWN_FOR_MS);
    return () => clearTimeout(timer);
  }, [visible]);

  // A keyboard user stays where they were: on Hide once it is shown, back on Show once it is hidden.
  useEffect(() => {
    if (focusOn) box.current?.querySelector<HTMLElement>(`[data-reveal="${focusOn}"]`)?.focus();
  }, [focusOn, visible]);

  function show() {
    setNotice(null);
    setCopied(false);
    startTransition(async () => {
      try {
        const result = await revealStudentPasswordAction({ studentId });
        if (result.ok) {
          setPassword(result.password);
          setFocusOn("hide");
        } else {
          setNotice({ unavailable: result.unavailable, text: result.message });
        }
      } catch {
        setNotice({ unavailable: false, text: "The password could not be shown. Try again." });
      }
    });
  }

  function hide() {
    setPassword(null);
    setCopied(false);
    setFocusOn("show");
  }

  return (
    <div
      ref={box}
      role="group"
      aria-labelledby={labelId}
      className="flex flex-col gap-2 rounded-md border border-neutral-200 bg-neutral-50 p-3 text-sm"
    >
      <p id={labelId} className="text-xs uppercase tracking-wide text-neutral-500">
        Portal password
      </p>
      {!recoverable || notice?.unavailable ? (
        <>
          <p className="text-neutral-800">Password recovery information is not available.</p>
          <p className="text-xs text-neutral-500">
            Reset the password to issue a new one; that one, and any the student chooses after it, can be shown here.
          </p>
        </>
      ) : visible ? (
        <div className="flex flex-wrap items-center gap-2">
          <code className="min-w-0 flex-1 select-all break-all rounded border border-neutral-300 bg-white px-2 py-1.5 font-mono text-sm text-neutral-900">
            {visible}
          </code>
          <Button
            type="button"
            variant="secondary"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(visible);
                setCopied(true);
              } catch {
                setCopied(false);
              }
            }}
          >
            {copied ? "Copied" : "Copy password"}
          </Button>
          <Button type="button" variant="secondary" data-reveal="hide" onClick={hide}>
            Hide password
          </Button>
          <span aria-live="polite" className="sr-only">
            {copied ? "Password copied" : ""}
          </span>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <span aria-hidden="true" className="font-mono text-sm tracking-widest text-neutral-500">
            ••••••••••••
          </span>
          <Button type="button" data-reveal="show" onClick={show} disabled={pending}>
            {pending ? "Showing…" : "Show current password"}
          </Button>
        </div>
      )}
      {recoverable && !notice?.unavailable ? (
        <p className="text-xs text-amber-800">
          This reveals the student&apos;s current portal password. Use only when necessary. Each reveal is recorded.
        </p>
      ) : null}
      {notice && !notice.unavailable ? (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">
          {notice.text}
        </p>
      ) : null}
    </div>
  );
}
