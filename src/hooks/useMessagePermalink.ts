import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";

/** Older pages the hunt may pull before giving up on a permalink target. */
const MAX_HUNT_PAGES = 8;

/**
 * Consume a `?m=<event id>` message permalink on a chat route.
 *
 * Once the target message is in loaded history the timeline scrolls to it
 * (the caller's `scrollTo` adds the focus indicator) and the param is
 * stripped, mirroring the one-shot `?thread=` convention. A target older than
 * the loaded window drives the transport's `loadOlder` a bounded number of
 * pages; when history is exhausted — or the target simply isn't a timeline
 * message (a thread reply, a deleted message) — the param is dropped and the
 * reader is left in the channel the link named, rather than a later load
 * snapping them to it after they've started reading.
 *
 * Producers of this shape: the Android notification service appends
 * `m=<event id>` to its deep links, and the message menu's "Copy message
 * link" builds the same URL for sharing.
 */
export function useMessagePermalink(opts: {
  messages: readonly { id: string }[];
  isLoading: boolean;
  hasMore?: boolean;
  loadOlder?: () => Promise<unknown>;
  /** Jump the timeline to a loaded message; false if it isn't in there. */
  scrollTo: (id: string) => boolean;
  /** Gate for pages that reuse one route for several views (default true). */
  enabled?: boolean;
}): void {
  const { messages, isLoading, hasMore, loadOlder, scrollTo, enabled = true } = opts;
  const [searchParams, setSearchParams] = useSearchParams();
  const target = searchParams.get("m");

  // Pages pulled for the current target, and whether a pull is in flight.
  const pagesRef = useRef(0);
  const busyRef = useRef(false);
  // Re-runs the effect when a pull settles WITHOUT changing `messages`
  // identity (an empty page), so the hunt can continue or give up.
  const [pulse, setPulse] = useState(0);

  useEffect(() => {
    pagesRef.current = 0;
  }, [target]);

  useEffect(() => {
    if (!target || !enabled || isLoading) return;
    const clear = () =>
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete("m");
          return next;
        },
        { replace: true },
      );
    if (messages.some((m) => m.id === target)) {
      scrollTo(target);
      clear();
      return;
    }
    if (!hasMore || !loadOlder || pagesRef.current >= MAX_HUNT_PAGES) {
      clear();
      return;
    }
    if (busyRef.current) return;
    busyRef.current = true;
    pagesRef.current += 1;
    void Promise.resolve(loadOlder()).finally(() => {
      busyRef.current = false;
      setPulse((n) => n + 1);
    });
    // `pulse` is a dependency so a page that found nothing still advances the
    // hunt instead of stalling on an unchanged `messages` identity.
  }, [target, enabled, isLoading, messages, hasMore, loadOlder, scrollTo, setSearchParams, pulse]);
}
