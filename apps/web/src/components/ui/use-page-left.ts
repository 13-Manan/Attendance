"use client";

import { useEffect, useState } from "react";
import { flushSync } from "react-dom";

/**
 * True once this page has been left — navigated away from, closed, or put
 * into the browser's back/forward cache — and again if it is restored from
 * that cache.
 *
 * For a one-time secret on screen, such as a temporary password: a component
 * that stops rendering it when this turns true cannot be brought back with the
 * secret still showing by the Back button. `flushSync`, because the browser
 * takes its back/forward snapshot as soon as the `pagehide` handlers return,
 * before an ordinarily scheduled render would have happened.
 */
export function usePageLeft(): boolean {
  const [left, setLeft] = useState(false);
  useEffect(() => {
    const onHide = () => flushSync(() => setLeft(true));
    const onShow = (event: PageTransitionEvent) => {
      if (event.persisted) setLeft(true);
    };
    window.addEventListener("pagehide", onHide);
    window.addEventListener("pageshow", onShow);
    return () => {
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("pageshow", onShow);
    };
  }, []);
  return left;
}
