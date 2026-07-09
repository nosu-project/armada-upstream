import { ChevronDown, Loader2 } from "lucide-react";
import { Fragment, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";

import { Skeleton } from "@/components/ui/skeleton";

import type { ChatMsg, ChatTransport } from "@/components/chat/transport";
import type { ReactNode, RefObject } from "react";

/**
 * Largest gap (seconds) between two same-author messages for the later one to
 * render as a compact continuation (no repeated avatar/name/timestamp).
 */
const CONTINUATION_WINDOW_SECONDS = 5 * 60;

/** Whether two unix-second timestamps fall on the same local calendar day. */
function isSameDay(a: number, b: number): boolean {
  const da = new Date(a * 1000);
  const db = new Date(b * 1000);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

/** "Today" / "Yesterday" / a long local date, for the day separators. */
function formatDayLabel(ts: number): string {
  const date = new Date(ts * 1000);
  const now = new Date();
  if (isSameDay(ts, Math.floor(now.getTime() / 1000))) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (isSameDay(ts, Math.floor(yesterday.getTime() / 1000))) return "Yesterday";
  return date.toLocaleDateString(undefined, {
    month: "long",
    day: "numeric",
    year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
}

/** Discord-style day boundary: a hairline with the date pinned in the middle. */
function DateSeparator({ ts }: { ts: number }) {
  return (
    <div className="flex items-center gap-3 px-2 pt-3 pb-1 select-none" aria-hidden>
      <div className="h-px flex-1 bg-border/60" />
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/80">
        {formatDayLabel(ts)}
      </span>
      <div className="h-px flex-1 bg-border/60" />
    </div>
  );
}

/** Discord-style unread marker: a red hairline with a "NEW" tag. */
function NewMessagesDivider() {
  return (
    <div className="flex items-center px-2 py-1 select-none" role="separator" aria-label="New messages">
      <div className="h-px flex-1 bg-destructive/70" />
      <span className="pl-1.5 text-[10px] font-semibold uppercase tracking-wider text-destructive">
        New
      </span>
    </div>
  );
}

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
  /**
   * Id of the first unread message: the red "NEW" divider renders directly
   * above it (computed by the parent, e.g. {@link useNewMessagesDivider}).
   */
  newDividerId?: string;
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
  newDividerId,
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
  // Whether the user has scrolled far enough up that a "jump to present" pill
  // should be offered. (setState bails out when unchanged, so updating this on
  // every scroll event is cheap.)
  const [showJumpPill, setShowJumpPill] = useState(false);
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
    setShowJumpPill(false);
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
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    isAutoScrollRef.current = distanceFromBottom < 60;
    setShowJumpPill(distanceFromBottom > 300);
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
            const newDay = !!prev && !isSameDay(prev.created_at, msg.created_at);
            const continuation =
              !!prev &&
              !newDay &&
              prev.pubkey === msg.pubkey &&
              msg.created_at - prev.created_at < CONTINUATION_WINDOW_SECONDS;
            return (
              <Fragment key={msg.id}>
                {newDay && <DateSeparator ts={msg.created_at} />}
                {newDividerId === msg.id && <NewMessagesDivider />}
                {renderMessage(msg, continuation)}
              </Fragment>
            );
          })}
        </>
      )}
      </div>
      {/* Jump-to-present pill: a zero-height sticky anchor at the end of the
          scroll content keeps the pill floating at the bottom edge while the
          user reads older history; clicking re-pins to the bottom. */}
      {showJumpPill && (
        // `items-end` is load-bearing: the anchor is 0px tall, and the default
        // `stretch` would squash the button to that height (padding-only box).
        // End-aligned, the button keeps its natural height and overflows
        // upward from the anchor line.
        <div className="sticky bottom-3 z-10 h-0 flex justify-center items-end pointer-events-none">
          <button
            type="button"
            onClick={() => {
              isAutoScrollRef.current = true;
              pinToBottomNow();
            }}
            className="pointer-events-auto inline-flex items-center gap-2 clip-corner-lg border border-border/60 bg-secondary/90 backdrop-blur px-5 py-2.5 text-sm font-medium text-foreground shadow-lg hover:bg-secondary transition-colors"
            aria-label="Jump to the latest messages"
          >
            <ChevronDown className="size-4" />
            Jump to present
          </button>
        </div>
      )}
    </div>
  );
}
