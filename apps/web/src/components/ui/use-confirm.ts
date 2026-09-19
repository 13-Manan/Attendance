"use client";

import { useState } from "react";

/**
 * The open/closed state of a two-step confirmation, tied to the row it belongs
 * to.
 *
 * Several screens here ask twice before a destructive-looking action: closing a
 * campus, stopping a staff account, taking a student off roll, archiving an
 * academic year. Each of those has an undo next to it — reopen, restore, bring
 * back on roll — and the undo is a single click, because asking somebody to
 * confirm an undo teaches them to click through dialogs.
 *
 * That pairing is what this exists for. A confirmation is about the state the
 * row was in when it was opened, so when that state changes underneath it the
 * sentence it carries is about a decision nobody is making any more. Plain
 * `useState` keeps the flag set through the undo, and the row comes back with
 * "Close campus" already expanded and a warning nobody asked for. Passing the
 * condition in closes it instead: `available` is whatever makes the destructive
 * action offerable at all, and the moment it flips the confirmation goes with
 * it.
 *
 * The returned flag is already guarded by `available`, so a caller can render
 * on it alone. Adjusting state during render rather than in an effect is
 * deliberate — it means the stale confirmation is never painted, not painted
 * and then withdrawn.
 */
export function useConfirm(available: boolean): [boolean, (next: boolean) => void] {
  const [confirming, setConfirming] = useState(false);
  const [lastAvailable, setLastAvailable] = useState(available);

  if (lastAvailable !== available) {
    setLastAvailable(available);
    setConfirming(false);
  }

  return [confirming && available, setConfirming];
}
