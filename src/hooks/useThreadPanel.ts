import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { chatRoute, parseChatRoute, roomPath } from "@/lib/routes";
import { cn } from "@/lib/utils";

import type { ChatMsg } from "@/components/chat/transport";
import type { Concord2Route, Nip29Route } from "@/lib/routes";

/** The surfaces that have a thread panel. DMs have no threads (see `parseChatRoute`). */
export type ThreadCapableRoute = Nip29Route | Concord2Route;

/** How long the panel stays mounted after closing, matching its slide-out. */
const SLIDE_OUT_MS = 200;

export interface ThreadPanelState {
  /** The open thread's root, once it resolves against loaded history. */
  threadRoot: ChatMsg | undefined;
  /** The root to RENDER — outlives `threadRoot` through the slide-out. */
  lastThreadRoot: ChatMsg | undefined;
  /** Whether the panel is expanded to full width (wide viewports). */
  expanded: boolean;
  setExpanded: (expanded: boolean) => void;
  /**
   * Classes for the CHAT column beside the panel. While the panel is expanded
   * to full width the chat collapses out of the way rather than unmounting, so
   * reopening it doesn't rebuild the timeline or lose its scroll position.
   */
  chatColumnClass: string;
  /** Whether the reply composer should take focus when the panel opens. */
  autoFocus: boolean;
  /** Open a thread, optionally focusing its reply composer. */
  openThread: (event: ChatMsg, focusReply?: boolean) => void;
  /** `openThread` bound to focus the composer, or undefined when read-only. */
  onOpenThread: ((event: ChatMsg) => void) | undefined;
  closeThread: () => void;
}

/**
 * The open thread panel, driven by the route.
 *
 * There is one answer to "which thread is open", and the URL is it: opening
 * pushes `/t/<root>` onto the room path, so Back closes the panel, a refresh
 * reopens it, and a notification tap arrives at the thread through the same
 * path a click does — no second code path, and no state that can disagree with
 * the address bar. An unresolved id (a deep link to a root older than the
 * loaded window) simply leaves the panel closed while the timeline pages back
 * toward it.
 *
 * NIP-29 and Concord each implemented this identically down to
 * the animation timings, differing only in which route kind they spelled — so
 * it takes the room as a {@link ThreadCapableRoute} and builds every path from
 * that one value.
 */
export function useThreadPanel(opts: {
  /** The room the panel belongs to; undefined while it's still resolving. */
  room: ThreadCapableRoute | undefined;
  /** Loaded history the routed root is resolved against. */
  messages: readonly ChatMsg[];
  /** Whether the user may reply (gates {@link ThreadPanelState.onOpenThread}). */
  canWrite?: boolean;
}): ThreadPanelState {
  const { room, messages, canWrite = true } = opts;
  const navigate = useNavigate();
  const location = useLocation();

  const routeThreadRoot = useMemo(() => {
    const parsed = parseChatRoute(location.pathname);
    return parsed && parsed.kind !== "dm" ? parsed.threadRoot : undefined;
  }, [location.pathname]);

  const threadRoot = useMemo(
    () => (routeThreadRoot ? messages.find((m) => m.id === routeThreadRoot) : undefined),
    [routeThreadRoot, messages],
  );

  const [lastThreadRoot, setLastThreadRoot] = useState<ChatMsg | undefined>(undefined);
  const [expanded, setExpanded] = useState(false);

  // Drop the slide-out keepalive when the ROOM changes. The panel itself needs
  // no closing — leaving a channel drops the `/t/` segment, so `threadRoot`
  // resolves to nothing — but `lastThreadRoot` is cleared here rather than only
  // by the timeout below, which re-runs on `threadRoot` changes and so wouldn't
  // fire for an already-closed panel. Keying on the room PATH rather than on
  // ids the caller assembles covers the pages that are reused across community
  // switches without a route `key`.
  const scopeKey = room ? roomPath(room) : "";
  const [lastScopeKey, setLastScopeKey] = useState(scopeKey);
  if (lastScopeKey !== scopeKey) {
    setLastScopeKey(scopeKey);
    setLastThreadRoot(undefined);
  }

  // Keep the panel's content mounted through its slide-out animation.
  useEffect(() => {
    if (threadRoot) {
      setLastThreadRoot(threadRoot);
      return;
    }
    const t = setTimeout(() => setLastThreadRoot(undefined), SLIDE_OUT_MS);
    return () => clearTimeout(t);
  }, [threadRoot]);

  // Whether the reply composer takes focus on open: an intent belonging to the
  // click that navigated, not to the location, so it rides in history state and
  // a shared link never steals focus.
  const autoFocus = Boolean(
    (location.state as { threadAutoFocus?: boolean } | null)?.threadAutoFocus,
  );

  // Stable: `onOpenThread` below is a prop of every message row, and taking
  // the room and `navigate` (which changes per location) as dependencies
  // re-rendered every row of the room being left on each switch. The room is
  // read at call time, which is when it matters.
  const openRef = useRef({ room, navigate });
  openRef.current = { room, navigate };
  const openThread = useCallback((event: ChatMsg, focusReply = false) => {
    const { room: current, navigate: go } = openRef.current;
    if (!current) return;
    go(chatRoute({ ...current, threadRoot: event.id }), {
      state: { threadAutoFocus: focusReply },
    });
  }, []);

  // Closing when no thread is routed is a no-op rather than a second push, so a
  // stray close (the panel is still mounted through its slide-out) can't stack
  // duplicate history entries.
  const closeThread = useCallback(() => {
    if (!room || !routeThreadRoot) return;
    setExpanded(false);
    navigate(roomPath(room));
  }, [room, routeThreadRoot, navigate]);

  const onOpenThread = useMemo(
    () => (canWrite ? (event: ChatMsg) => openThread(event, true) : undefined),
    [canWrite, openThread],
  );

  return {
    threadRoot,
    lastThreadRoot,
    expanded,
    setExpanded,
    chatColumnClass: cn(
      "thread:transition-[width,opacity] thread:duration-300 thread:ease-out",
      threadRoot &&
        expanded &&
        "thread:flex-none thread:w-0 thread:opacity-0 thread:overflow-hidden thread:pointer-events-none",
    ),
    autoFocus,
    openThread,
    onOpenThread,
    closeThread,
  };
}
