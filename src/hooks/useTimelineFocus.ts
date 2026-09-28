import { useCallback, useRef, useState } from "react";

import { useMessagePermalink } from "@/hooks/useMessagePermalink";

import type { MessageTimelineHandle } from "@/components/chat/MessageTimeline";
import type { RefObject } from "react";

export interface TimelineFocus {
  /** Hand to `MessageTimeline`'s `handleRef`. */
  timelineRef: RefObject<MessageTimelineHandle | null>;
  jumpToMessage: (id: string) => void;
  clearMessageFocus: () => void;
  /** Follow the newest message AND drop the `/m/` segment. What a send means. */
  pinToPresent: () => void;
  /** Touch only. */
  activeId: string | undefined;
  toggleActive: (id: string) => void;
}

/**
 * The timeline handle plus jump-to-message, `/m/<id>` permalinks and the touch-revealed row.
 * Without `activeId` the toolbar stays `touch:pointer-events-none` and is untappable on the APK.
 */
export function useTimelineFocus(opts: {
  messages: readonly { id: string }[];
  isLoading: boolean;
  hasMore?: boolean;
  loadOlder?: () => Promise<unknown>;
  /** Gate for pages that reuse one route for several views (default true). */
  enabled?: boolean;
  /**
   * Closes the revealed row on change; pass the conversation identity where one component serves
   * several (DMs switch peers without remounting).
   */
  resetKey?: string;
}): TimelineFocus {
  const { messages, isLoading, hasMore, loadOlder, enabled, resetKey } = opts;
  const timelineRef = useRef<MessageTimelineHandle | null>(null);

  const jumpToMessage = useCallback((id: string) => {
    timelineRef.current?.scrollToMessage(id);
  }, []);

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

  // Drop `/m/` focus too, or a remount would snap the reader back to it.
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
