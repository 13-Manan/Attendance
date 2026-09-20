"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A server-sent-events subscription that survives losing its server.
 *
 * ## Why this exists
 *
 * Both realtime screens used a bare `new EventSource(...)`. `EventSource` is
 * documented as reconnecting by itself, and for a dropped packet it does — but
 * Phase 15 measured what happens when the *instance* serving the stream is
 * replaced, which is now routine: `maxReplicas: 5` and a rolling revision mean
 * the process holding a teacher's stream goes away on every deploy. The
 * browser gave up, left `readyState` at `CLOSED`, and the screen sat there
 * looking live while receiving nothing until somebody navigated.
 *
 * ## The correctness model, unchanged
 *
 * PostgreSQL is authoritative. This hook does not replay events and does not
 * try to: `NOTIFY` retains nothing, so an event that happened while a client
 * was away is simply gone. What is guaranteed is weaker and sufficient —
 * **after a reconnect the screen re-reads authoritative state**, so a missed
 * event costs a moment of staleness rather than a permanently wrong register.
 * That is what `onReconnect` is for, and why it fires on re-establishment and
 * not on the first connection, where the server-rendered page is already
 * current.
 *
 * ## Terminal versus transient
 *
 * `EventSource` reports `error` for everything and exposes no status code, so
 * "the box is on a train" and "you were signed out" look identical. They are
 * not: one should retry, the other must stop. When the browser gives up
 * (`CLOSED`), this probes the same URL with `fetch` and reads the real status.
 * A 401/403/404 is terminal and reconnection stops; anything else is treated
 * as transient and retried with backoff.
 *
 * The probe is a genuine authorization decision made by the server — same
 * route, same cookie, same checks — so a reconnect cannot outlive the access
 * that justified it. Nothing about who may subscribe is decided here.
 */

export type LiveStreamState =
  /** Opening for the first time. Not worth telling anybody about. */
  | "connecting"
  | "connected"
  /** Was connected, lost it, trying again. This one is worth showing. */
  | "reconnecting"
  /** The server refused us. No further attempts will be made. */
  | "unauthorized";

export interface LiveStreamOptions<T> {
  /** Same-origin path. Identity is the session cookie; nothing is in the URL. */
  url: string;
  /** One parsed message. Called for every event, including duplicates. */
  onEvent: (event: T) => void;
  /**
   * Fired after a connection is *re-*established, never after the first one.
   * Reconcile authoritative state here.
   */
  onReconnect?: () => void;
  /** Set false to tear down and stop retrying — e.g. after signing out. */
  enabled?: boolean;
}

/** Retry schedule. Bounded, so a long outage settles into a slow poll rather
 * than a hot loop, and jittered so a replaced replica does not get every
 * client back at the same instant. */
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;
const JITTER = 0.25;

/**
 * How long a stream may stay silent before it is presumed dead.
 *
 * This is the part that actually makes reconnection work, and it exists
 * because of a measurement: with the server process killed, Chrome left the
 * stream at `readyState: OPEN` and fired no error for tens of seconds. There
 * was no failure to react to. A socket that has quietly stopped being served
 * is indistinguishable from an idle one *unless* the client knows how often it
 * should be hearing something.
 *
 * The routes emit a `heartbeat` event every 15s, so silence well past two of
 * them is not a slow network — it is a connection that is not coming back.
 * Generous enough to tolerate a suspended tab briefly and a jittery link.
 */
const HEARTBEAT_INTERVAL_MS = 15_000;
const SILENCE_TIMEOUT_MS = HEARTBEAT_INTERVAL_MS * 2 + 10_000;

/**
 * Delay before attempt `n` (0-based), exponential and capped, with jitter.
 *
 * Exported for its own test: the property that matters — bounded, increasing,
 * never zero — is easier to assert here than through a live socket.
 */
export function reconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  const exponential = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempt));
  // ±25%, so a thundering herd spreads instead of arriving together.
  const spread = exponential * JITTER;
  const delay = exponential - spread + random() * spread * 2;
  return Math.max(BASE_DELAY_MS, Math.round(Math.min(MAX_DELAY_MS, delay)));
}

/** Statuses that mean "do not come back". */
function isTerminalStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 404;
}

export function useLiveStream<T>({
  url,
  onEvent,
  onReconnect,
  enabled = true,
}: LiveStreamOptions<T>): { state: LiveStreamState } {
  const [state, setState] = useState<LiveStreamState>("connecting");

  // Callbacks live in refs so that a caller passing an inline function cannot
  // retrigger the effect and, with it, tear down and rebuild the socket on
  // every render — which is its own kind of reconnect storm.
  const onEventRef = useRef(onEvent);
  const onReconnectRef = useRef(onReconnect);
  // Synced in an effect rather than during render: a ref written while
  // rendering is a React violation, and this one is only ever read from a
  // socket callback, which is well after the commit.
  useEffect(() => {
    onEventRef.current = onEvent;
    onReconnectRef.current = onReconnect;
  });

  const stableOnEvent = useCallback((event: T) => onEventRef.current(event), []);

  useEffect(() => {
    if (!enabled) return;

    // Everything mutable for this connection's lifetime. `cancelled` is the
    // single authority on whether anything may still act: cleanup sets it, and
    // every async continuation below checks it before touching state or
    // opening a socket. Without it, an in-flight probe can resurrect a stream
    // after unmount.
    let cancelled = false;
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let hasConnected = false;

    /** "connecting" before we have ever been live, "reconnecting" after. */
    const pendingState = (): LiveStreamState => (hasConnected ? "reconnecting" : "connecting");

    const clearWatchdog = () => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = null;
    };

    /**
     * Restart the silence timer. Called on open and on every frame the server
     * sends, heartbeat or event — any byte proves the stream is still served.
     */
    const kickWatchdog = () => {
      clearWatchdog();
      watchdog = setTimeout(() => {
        if (cancelled) return;
        // Nothing for well over two heartbeats. The socket may still claim to
        // be OPEN; it is not being served. Throw it away and start again.
        closeSocket();
        setState(pendingState());
        void classifyAndRetry();
      }, SILENCE_TIMEOUT_MS);
    };

    const closeSocket = () => {
      clearWatchdog();
      if (!source) return;
      // Drop the handlers before closing: a pending error event must not run
      // after we have decided to stop.
      source.onopen = null;
      source.onmessage = null;
      source.onerror = null;
      source.close();
      source = null;
    };

    const scheduleReconnect = () => {
      if (cancelled || timer) return;
      const delay = reconnectDelayMs(attempt);
      attempt += 1;
      timer = setTimeout(() => {
        timer = null;
        if (!cancelled) connect();
      }, delay);
    };

    /**
     * Ask the server what it actually thinks, then decide.
     *
     * The response body is a stream we do not want; aborting immediately after
     * the headers arrive gets the status without holding a second subscription
     * open on the server, whose route closes on `request.signal`.
     */
    const classifyAndRetry = async () => {
      const controller = new AbortController();
      try {
        const res = await fetch(url, {
          credentials: "same-origin",
          signal: controller.signal,
          headers: { Accept: "text/event-stream" },
          cache: "no-store",
        });
        const status = res.status;
        controller.abort();
        if (cancelled) return;
        if (isTerminalStatus(status)) {
          setState("unauthorized");
          return;
        }
      } catch {
        controller.abort();
        if (cancelled) return;
        // Could not even ask — treat as transient and retry.
      }
      if (!cancelled) scheduleReconnect();
    };

    function connect() {
      if (cancelled) return;
      closeSocket();

      const next = new EventSource(url, { withCredentials: true });
      source = next;

      next.onopen = () => {
        if (cancelled) return;
        attempt = 0;
        setState("connected");
        kickWatchdog();
        // Reconciliation, deliberately not on the first connection: the page
        // was server-rendered from the same authoritative state a moment ago.
        if (hasConnected) onReconnectRef.current?.();
        hasConnected = true;
      };

      // The routes' liveness signal. Carries nothing and means only "this
      // stream is still being served by someone".
      next.addEventListener("heartbeat", () => {
        if (!cancelled) kickWatchdog();
      });

      next.onmessage = (message: MessageEvent<string>) => {
        if (cancelled) return;
        kickWatchdog();
        let parsed: T;
        try {
          parsed = JSON.parse(message.data) as T;
        } catch {
          return; // A malformed frame is skipped, not fatal.
        }
        stableOnEvent(parsed);
      };

      next.onerror = () => {
        if (cancelled) return;
        // Still CONNECTING means the browser is retrying on its own; leave it
        // be rather than racing it with a second socket.
        if (next.readyState === EventSource.CONNECTING) {
          setState(pendingState());
          return;
        }
        // CLOSED: the browser has given up. Ours now.
        closeSocket();
        setState(pendingState());
        void classifyAndRetry();
      };
    }

    connect();

    return () => {
      cancelled = true;
      clearWatchdog();
      if (timer) clearTimeout(timer);
      timer = null;
      closeSocket();
    };
  }, [url, enabled, stableOnEvent]);

  // Derived rather than stored: a disabled stream is not "connected", and
  // writing that through setState from the effect body would be a cascading
  // render for a value we already know.
  return { state: enabled ? state : "connecting" };
}
