import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { chatRoute, parseChatRoute, withoutMessage } from "@/lib/routes";

/** Older pages the hunt may pull before giving up on a permalink target. */
const MAX_HUNT_PAGES = 8;

/**
 * Consume a `/m/<event id>` message permalink on a chat route.
 *
 * The message id is a durable part of the location, not a transient hint: a
 * permalink stays in the address bar, so refreshing or coming Back returns the
 * reader to the same message. Three consequences shape everything below.
 *
 * First, the scroll must happen exactly ONCE per arrival. The effect re-runs
 * whenever `messages` changes identity — which is every time anyone posts in
 * the room — and a naive implementation would therefore yank the reader back
 * to the permalink target each time the conversation moved. `doneRef` records
 * that the hunt is settled and resets when the location changes, which
 * includes navigating to the id already on screen (`location.key` is new even
 * when the path is not) — so tapping the same pinned message twice jumps
 * twice, while a message arriving does nothing.
 *
 * Second, an id that cannot be resolved is dropped. A target older than the
 * loaded window drives the transport's `loadOlder` a bounded number of pages;
 * when history is exhausted the segment is replaced away, leaving the reader
 * in the room the link named. Keeping it would mean re-running all eight
 * round-trips on every remount, forever, for a link that will never resolve.
 *
 * Third, a reply inside a thread is not in the timeline at all, and the two
 * surfaces are both mounted at once. `scope` is what keeps them from fighting
 * over the same id: `/c/…/:channel/m/<id>` belongs to the timeline and
 * `/c/…/:channel/t/<root>/m/<id>` belongs to the thread panel, so each instance
 * ignores the other's shape. Without it the timeline would hunt a reply it can
 * never hold — eight round-trips — and then strip the segment out from under
 * the panel that could have shown it.
 *
 * Returns a callback that drops the `/m/` segment, for the moments that mean
 * "I am no longer looking at that": sending a message, above all.
 */
export function useMessagePermalink(opts: {
  messages: readonly { id: string }[];
  isLoading: boolean;
  hasMore?: boolean;
  loadOlder?: () => Promise<unknown>;
  /** Jump the timeline to a loaded message; false if it isn't in there. */
  scrollTo: (id: string) => boolean;
  /** Which `/m/` shape this instance owns (default the room timeline). */
  scope?: "timeline" | "thread";
  /** Gate for pages that reuse one route for several views (default true). */
  enabled?: boolean;
}): () => void {
  const {
    messages,
    isLoading,
    hasMore,
    loadOlder,
    scrollTo,
    scope = "timeline",
    enabled = true,
  } = opts;
  const navigate = useNavigate();
  const location = useLocation();
  const route = useMemo(() => parseChatRoute(location.pathname), [location.pathname]);
  const inThread = Boolean(route && route.kind !== "dm" && route.threadRoot);
  const mine = scope === "thread" ? inThread : !inThread;
  const target = mine ? route?.messageId : undefined;

  // Pages pulled for the current target, whether a pull is in flight, and
  // whether the hunt for this arrival has settled.
  const pagesRef = useRef(0);
  const busyRef = useRef(false);
  const doneRef = useRef(false);
  // Re-runs the effect when a pull settles WITHOUT changing `messages`
  // identity (an empty page), so the hunt can continue or give up.
  const [pulse, setPulse] = useState(0);

  useEffect(() => {
    pagesRef.current = 0;
    doneRef.current = false;
  }, [target, location.key]);

  // Drop the `/m/<id>` segment, keeping the room and any open thread. Uses
  // `replace` so it doesn't leave a Back step that would simply re-run the
  // navigation it just undid.
  const clear = useCallback(() => {
    if (!route?.messageId) return;
    navigate(`${chatRoute(withoutMessage(route))}${location.search}${location.hash}`, {
      replace: true,
    });
  }, [route, navigate, location.search, location.hash]);

  useEffect(() => {
    if (!target || !enabled || isLoading || doneRef.current) return;
    if (messages.some((m) => m.id === target)) {
      scrollTo(target);
      // Satisfied: the segment stays in the URL (it names where the reader
      // is), but it must not fire again as the conversation moves on.
      doneRef.current = true;
      return;
    }
    if (!hasMore || !loadOlder || pagesRef.current >= MAX_HUNT_PAGES) {
      doneRef.current = true;
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
  }, [target, enabled, isLoading, messages, hasMore, loadOlder, scrollTo, clear, pulse]);

  return clear;
}
