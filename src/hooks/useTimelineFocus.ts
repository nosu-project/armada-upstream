import { useCallback, useRef, useState } from "react";

import { useMessagePermalink } from "@/hooks/useMessagePermalink";

import type { MessageTimelineHandle } from "@/components/chat/MessageTimeline";
import type { RefObject } from "react";

export interface TimelineFocus {
  /** Hand to `MessageTimeline`'s `handleRef`. */
  timelineRef: RefObject<MessageTimelineHandle | null>;
  /** Scroll to a loaded message — what a reply-context line's click does. */
  jumpToMessage: (id: string) => void;
  /** Drop the `/m/` segment: "I am no longer looking at that". */
  clearMessageFocus: () => void;
  /** Follow the newest message AND drop the `/m/` segment. What a send means. */
  pinToPresent: () => void;
  /** The row whose tap-to-reveal toolbar is open (touch only). */
  activeId: string | undefined;
  toggleActive: (id: string) => void;
}

/**
 * The timeline handle and everything aimed through it: jump-to-message,
 * `/m/<id>` permalink consumption, and the single row whose action toolbar is
 * revealed on touch.
 *
 * These travel together because they share the one ref — and every chat surface
 * had assembled the same four pieces around it. The touch `activeId` in
 * particular is not optional decoration: without it the action toolbar stays
 * `touch:pointer-events-none` and react/reply/delete are untappable on the APK.
 */
export function useTimelineFocus(opts: {
  messages: readonly { id: string }[];
  isLoading: boolean;
  hasMore?: boolean;
  loadOlder?: () => Promise<unknown>;
  /** Gate for pages that reuse one route for several views (default true). */
  enabled?: boolean;
  /**
   * Changing this closes the revealed row. Pass the conversation's identity
   * where one component serves several (DMs switch peers without remounting),
   * so a row left open doesn't reappear open in the next conversation.
   */
  resetKey?: string;
}): TimelineFocus {
  const { messages, isLoading, hasMore, loadOlder, enabled, resetKey } = opts;
  const timelineRef = useRef<MessageTimelineHandle | null>(null);

  const jumpToMessage = useCallback((id: string) => {
    timelineRef.current?.scrollToMessage(id);
  }, []);

  // Permalinks (`/m/<id>` — notification taps, copied links): scroll to the
  // target with the focus indicator once it's loaded, pulling older pages when
  // it's further back than the loaded history.
  const permalinkScroll = useCallback(
    (id: string) => timelineRef.current?.scrollToMessage(id, true) ?? false,
    [],
  );
  const clearMessageFocus = useMessagePermalink({
    messages,
    isLoading,
    hasMore,
    loadOlder,
    scrollTo: permalinkScroll,
    enabled,
  });

  // Sending is an explicit "I'm at the present": follow the new message, and
  // drop any `/m/` focus so the location stops claiming the reader is parked at
  // an older one (a remount would otherwise snap them back to it).
  const pinToPresent = useCallback(() => {
    timelineRef.current?.pinToBottom();
    clearMessageFocus();
  }, [clearMessageFocus]);

  const [activeId, setActiveId] = useState<string | undefined>(undefined);
  const toggleActive = useCallback(
    (id: string) => setActiveId((cur) => (cur === id ? undefined : id)),
    [],
  );
  const [lastResetKey, setLastResetKey] = useState(resetKey);
  if (lastResetKey !== resetKey) {
    setLastResetKey(resetKey);
    setActiveId(undefined);
  }

  return {
    timelineRef,
    jumpToMessage,
    clearMessageFocus,
    pinToPresent,
    activeId,
    toggleActive,
  };
}
