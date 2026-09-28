import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { chatRoute, parseChatRoute, roomPath } from "@/lib/routes";
import { cn } from "@/lib/utils";

import type { ChatMsg } from "@/components/chat/transport";
import type { Concord2Route, Nip29Route } from "@/lib/routes";

/** DMs have no threads (see `parseChatRoute`). */
export type ThreadCapableRoute = Nip29Route | Concord2Route;

/** Matches the slide-out animation. */
const SLIDE_OUT_MS = 200;

export interface ThreadPanelState {
  threadRoot: ChatMsg | undefined;
  /** Outlives `threadRoot` through the slide-out. */
  lastThreadRoot: ChatMsg | undefined;
  expanded: boolean;
  setExpanded: (expanded: boolean) => void;
  /** When expanded, the chat collapses rather than unmounting, keeping its scroll position. */
  chatColumnClass: string;
  autoFocus: boolean;
  openThread: (event: ChatMsg, focusReply?: boolean) => void;
  /** Undefined when read-only. */
  onOpenThread: ((event: ChatMsg) => void) | undefined;
  closeThread: () => void;
}

/**
 * The thread panel is driven by the route (`/t/<root>`): Back closes it, refresh reopens it,
 * notifications use the same path. An unresolved root leaves it closed while history pages back.
 * Shared by NIP-29 and Concord via {@link ThreadCapableRoute}.
 */
export function useThreadPanel(opts: {
  /** Undefined while resolving. */
  room: ThreadCapableRoute | undefined;
  messages: readonly ChatMsg[];
  /** Gates {@link ThreadPanelState.onOpenThread}. */
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

  // Clear the slide-out keepalive on ROOM change (keyed on the room path, since some pages are
  // reused across switches without a route `key`).
  const scopeKey = room ? roomPath(room) : "";
  const [lastScopeKey, setLastScopeKey] = useState(scopeKey);
  if (lastScopeKey !== scopeKey) {
    setLastScopeKey(scopeKey);
    setLastThreadRoot(undefined);
  }

  useEffect(() => {
    if (threadRoot) {
      setLastThreadRoot(threadRoot);
      return;
    }
    const t = setTimeout(() => setLastThreadRoot(undefined), SLIDE_OUT_MS);
    return () => clearTimeout(t);
  }, [threadRoot]);

  // A click's intent, carried in history state, so shared links never steal focus.
  const autoFocus = Boolean(
    (location.state as { threadAutoFocus?: boolean } | null)?.threadAutoFocus,
  );

  // Stable: `onOpenThread` is a prop of every row; read room/navigate at call time.
  const openRef = useRef({ room, navigate });
  openRef.current = { room, navigate };
  const openThread = useCallback((event: ChatMsg, focusReply = false) => {
    const { room: current, navigate: go } = openRef.current;
    if (!current) return;
    go(chatRoute({ ...current, threadRoot: event.id }), {
      state: { threadAutoFocus: focusReply },
    });
  }, []);

  // No-op when nothing is routed, so a stray close can't push duplicate history entries.
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
