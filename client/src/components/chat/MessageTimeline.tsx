import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useImperativeHandle, useRef } from "react";

import { Skeleton } from "@/components/ui/skeleton";

import type { ChatMsg, ChatTransport } from "@/components/chat/transport";
import type { ReactNode, RefObject } from "react";

/**
 * Largest gap (seconds) between two same-author messages for the later one to
 * render as a compact continuation (no repeated avatar/name/timestamp).
 */
const CONTINUATION_WINDOW_SECONDS = 5 * 60;

/** Imperative handle a parent can use to jump the timeline to a message by id. */
export interface MessageTimelineHandle {
  scrollToMessage: (id: string) => void;
  /** Re-anchor to the bottom and resume auto-scroll (e.g. after sending). */
  pinToBottom: () => void;
  /**
   * Keep the view at the bottom *only if the user was already there* — used
   * while a sibling panel animates its width and would otherwise let the
   * bottom-anchored view drift.
   */
  maintainBottom: () => void;
}

interface MessageTimelineProps {
  transport: ChatTransport;
  /**
   * Render one message row. The parent (a transport-specific wrapper) resolves
   * per-message data (reactions, reply context, send status) and returns a
   * `ChatMessage`. `continuation` is precomputed here from the shared rule.
   */
  renderMessage: (event: ChatMsg, continuation: boolean) => ReactNode;
  /**
   * Empty-state node shown when there are no messages and nothing is loading.
   */
  emptyState?: ReactNode;
  /** Optional ref for imperative scroll control (pinned-message jumps, etc.). */
  handleRef?: RefObject<MessageTimelineHandle | null>;
  /**
   * When true, the timeline yields its content area to a caller-provided
   * overlay (e.g. search results) — backfill on scroll is suppressed.
   */
  paused?: boolean;
  className?: string;
}

/**
 * The transport-agnostic message timeline: a bottom-anchored, auto-scrolling
 * scroll area with scroll-up backfill, same-author continuation collapsing, a
 * loading skeleton and an empty state. It owns only scroll mechanics and the
 * continuation rule; every message's content/actions come from `renderMessage`,
 * and all data/mutations come from the {@link ChatTransport}. Shared by NIP-29
 * group chat and Concord communities.
 */
export function MessageTimeline({
  transport,
  renderMessage,
  emptyState,
  handleRef,
  paused = false,
  className,
}: MessageTimelineProps) {
  const { messages, isLoading, loadOlder, hasMore, isLoadingOlder } = transport;

  // Remember that we've shown a populated timeline. If `messages` then briefly
  // empties (a transient between a cache refresh and the merged result landing),
  // we render the skeleton rather than flashing the empty state / a blank gap —
  // the timeline never truly "loses" its history, so a momentary empty array is
  // a render artifact, not an empty channel. Reset while a fresh load is in
  // flight (channel switch) so a genuinely-empty channel still shows its empty
  // state instead of a stale skeleton.
  const hadMessagesRef = useRef(false);
  if (isLoading) hadMessagesRef.current = false;
  if (messages.length > 0) hadMessagesRef.current = true;
  const transientEmpty = messages.length === 0 && hadMessagesRef.current;

  const scrollRef = useRef<HTMLDivElement>(null);
  // Inner content wrapper, observed for size changes (images, link previews,
  // lazily-loaded embeds, reactions, reply-count rows) so the view stays pinned
  // to the bottom as message rows grow.
  const contentRef = useRef<HTMLDivElement>(null);
  const isAutoScrollRef = useRef(true);
  // Set right before we programmatically change scrollTop, so the resulting
  // `scroll` event doesn't get mistaken for the user scrolling away and unpin
  // us. (Reactions/threads appearing grow a row, shift content, and fire a
  // scroll event; without this guard that event recomputes pinned=false a beat
  // before the ResizeObserver re-pins, so the re-pin is skipped and the view
  // drifts.)
  const programmaticScrollRef = useRef(false);
  // When backfilling older messages, the scroll height grows above the
  // viewport. Capture the pre-prepend metrics so we can restore the reading
  // position (anchor it to the same message) afterwards.
  const restoreScrollRef = useRef<{ height: number; top: number } | null>(null);

  /** Pin to the bottom, flagging the scroll as programmatic. */
  const pinToBottomNow = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    programmaticScrollRef.current = true;
    el.scrollTop = el.scrollHeight;
    requestAnimationFrame(() => {
      programmaticScrollRef.current = false;
    });
  }, []);

  /** Restore the captured reading position after a backfill prepend. */
  const restoreAfterPrepend = useCallback(() => {
    const el = scrollRef.current;
    const restore = restoreScrollRef.current;
    if (!el || !restore) return false;
    restoreScrollRef.current = null;
    programmaticScrollRef.current = true;
    el.scrollTop = restore.top + (el.scrollHeight - restore.height);
    requestAnimationFrame(() => {
      programmaticScrollRef.current = false;
    });
    return true;
  }, []);

  // Auto-scroll to bottom when new messages arrive (unless the user scrolled
  // up). When older history was just prepended (backfill), instead restore the
  // reading position by keeping the same content under the viewport.
  useEffect(() => {
    if (restoreAfterPrepend()) return;
    if (isAutoScrollRef.current) pinToBottomNow();
  }, [messages, restoreAfterPrepend, pinToBottomNow]);

  // Keep the view pinned to the bottom as the CONTENT grows from async loads
  // (images, link previews, embeds, reactions, reply counts) that don't change
  // `messages` and so would otherwise let the bottom-anchored view drift. Only
  // re-pins while the user is at the bottom; honors a pending backfill restore
  // first.
  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    const ro = new ResizeObserver(() => {
      if (restoreAfterPrepend()) return;
      if (isAutoScrollRef.current) pinToBottomNow();
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [restoreAfterPrepend, pinToBottomNow]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Ignore the scroll event we caused ourselves (pin/restore) — only genuine
    // user scrolls should change whether we're pinned. (Self-clears next frame.)
    if (programmaticScrollRef.current) return;
    isAutoScrollRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    // Near the top: backfill older history. Capture current metrics first so
    // the post-prepend effect can hold the reading position steady.
    if (!paused && loadOlder && hasMore && !isLoadingOlder && el.scrollTop < 200) {
      restoreScrollRef.current = { height: el.scrollHeight, top: el.scrollTop };
      void loadOlder().then((added) => {
        if (added === 0) restoreScrollRef.current = null;
      });
    }
  }, [paused, loadOlder, hasMore, isLoadingOlder]);

  // Scroll a (pinned) message into view and briefly highlight it with a subtle
  // background tint that fades out. No-op if it's not in the currently-loaded
  // timeline.
  const scrollToMessage = useCallback((id: string) => {
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-event-id="${id}"]`);
    if (!el) return;
    isAutoScrollRef.current = false;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("bg-primary/10", "transition-colors", "duration-1000", "rounded-md");
    setTimeout(() => el.classList.remove("bg-primary/10"), 1200);
    setTimeout(() => el.classList.remove("transition-colors", "duration-1000", "rounded-md"), 2200);
  }, []);

  useImperativeHandle(
    handleRef,
    () => ({
      scrollToMessage,
      pinToBottom: () => {
        isAutoScrollRef.current = true;
        pinToBottomNow();
      },
      maintainBottom: () => {
        if (!isAutoScrollRef.current) return;
        pinToBottomNow();
      },
    }),
    [scrollToMessage, pinToBottomNow],
  );

  return (
    <div ref={scrollRef} onScroll={handleScroll} className={className}>
      <div ref={contentRef}>
      {isLoading || transientEmpty ? (
        <div className="space-y-3 p-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex items-start gap-3">
              <Skeleton className="size-10 rounded-full shrink-0" />
              <div className="space-y-1 flex-1">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-3 w-2/3" />
              </div>
            </div>
          ))}
        </div>
      ) : messages.length === 0 ? (
        emptyState ?? null
      ) : (
        <>
          {isLoadingOlder && (
            <div className="flex justify-center py-3">
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            </div>
          )}
          {messages.map((msg, i) => {
            const prev = messages[i - 1];
            const continuation =
              !!prev &&
              prev.pubkey === msg.pubkey &&
              msg.created_at - prev.created_at < CONTINUATION_WINDOW_SECONDS;
            return renderMessage(msg, continuation);
          })}
        </>
      )}
      </div>
    </div>
  );
}
