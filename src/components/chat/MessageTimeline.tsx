import { ChevronDown, Loader2 } from "lucide-react";
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  FIRST_PAINT_WINDOW,
  INITIAL_WINDOW,
  resolveWindowStart,
  TRIM_ABOVE,
  WINDOW_STEP,
} from "@/components/chat/timelineWindow";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

import { isGitContinuation, type ChannelTimelineEntry } from "@/components/chat/channelTimeline";
import type { ChatMsg, ChatTransport } from "@/components/chat/transport";
import type { ReactNode, RefObject } from "react";

/**
 * Largest gap (seconds) between two same-author messages for the later one to
 * render as a compact continuation (no repeated avatar/name/timestamp).
 */
const CONTINUATION_WINDOW_SECONDS = 5 * 60;

/**
 * Distance from the top (px) at which older history is requested from the
 * transport. Deliberately a screenful-plus so the round trip overlaps with the
 * reader still having loaded content above them.
 */
const BACKFILL_TRIGGER_PX = 1200;

/** Distance from the top (px) at which already-loaded messages are revealed. */
const REVEAL_TRIGGER_PX = 900;

/** Distance from the bottom (px) still counted as "reading the newest". */
const AT_BOTTOM_PX = 60;

/** Distance from the bottom (px) at which the jump-to-present pill appears. */
const JUMP_PILL_PX = 300;

/** Messages revealed above a jump target so it doesn't land against the top. */
const JUMP_CONTEXT = 15;

/**
 * Rows rendered in each successive commit while a conversation opens, one per
 * frame. Mounting a row is expensive (author query, content tokenization, media
 * and embed subtrees), so the commit that the channel-switch click renders
 * synchronously contains none of them.
 */
const OPENING_RAMP = [0, FIRST_PAINT_WINDOW, INITIAL_WINDOW];

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

/** One rendered row: a message, a day separator, or the unread "NEW" divider. */
type TimelineItem =
  | { type: "date"; ts: number; key: string }
  | { type: "unread"; key: string }
  | { type: "message"; msg: ChatMsg; continuation: boolean; key: string }
  | { type: "entry"; entry: NonChatEntry; related?: readonly NonChatEntry[]; key: string };

/** A generalized timeline entry that isn't a plain chat message (e.g. Git activity). */
type NonChatEntry = Exclude<ChannelTimelineEntry, { type: "chat" }>;

/**
 * The run of Git entries a group-head row renders on behalf of: itself plus
 * every immediately-following same-day continuation. Those followers emit no
 * row of their own, so a comment burst collapses into one grouped block.
 */
function relatedGitEntries(
  entries: readonly ChannelTimelineEntry[],
  index: number,
  entry: NonChatEntry,
): readonly NonChatEntry[] | undefined {
  if (entry.type !== "git-comment") return undefined;
  const related: NonChatEntry[] = [entry];
  for (let cursor = index + 1; cursor < entries.length; cursor++) {
    const candidate = entries[cursor];
    if (
      !candidate ||
      candidate.type !== "git-comment" ||
      !isSameDay(entry.createdAt, candidate.createdAt) ||
      !isGitContinuation(related[related.length - 1], candidate)
    ) {
      break;
    }
    related.push(candidate);
  }
  return related;
}

/** A row's identity plus its position relative to the viewport's top edge. */
interface ScrollAnchor {
  /** The `items` array this anchor was captured against. */
  items: TimelineItem[];
  key: string;
  offset: number;
}

/**
 * Record the topmost row still touching the viewport, and how far its top edge
 * sits from the viewport's. Called during render — before React commits — so it
 * reads the DOM as the reader currently sees it; {@link restoreAnchor} then puts
 * that same row back under the same pixel once the new rows are in.
 *
 * This is the entire scroll-position-preservation story for prepends: no height
 * bookkeeping, no scrollTop arithmetic against a remembered `scrollHeight` (which
 * goes wrong the moment anything above resizes between the two measurements).
 */
function captureAnchor(scroller: HTMLElement, content: HTMLElement, items: TimelineItem[]): ScrollAnchor | null {
  const rows = content.querySelectorAll<HTMLElement>("[data-row-key]");
  const top = scroller.scrollTop;
  for (const row of rows) {
    if (row.offsetTop + row.offsetHeight > top) {
      return { items, key: row.dataset.rowKey ?? "", offset: row.offsetTop - top };
    }
  }
  return null;
}

/** Put the anchored row back under the pixel it was under when captured. */
function restoreAnchor(scroller: HTMLElement, content: HTMLElement, anchor: ScrollAnchor): void {
  const row = content.querySelector<HTMLElement>(`[data-row-key="${anchor.key}"]`);
  if (!row) return;
  scroller.scrollTop = row.offsetTop - anchor.offset;
}

/** Imperative handle a parent can use to jump the timeline to a message by id. */
export interface MessageTimelineHandle {
  /**
   * Reveal and center a loaded message. Returns false when the id is not part
   * of this timeline (for example, a reply that belongs in a thread panel).
   */
  scrollToMessage: (id: string) => boolean;
  /** Re-anchor to the bottom and resume auto-scroll (e.g. after sending). */
  pinToBottom: () => void;
  /**
   * Keep the view at the bottom *only if the user was already there*. Layout
   * changes around the timeline are handled automatically (a ResizeObserver
   * watches the scroller and its content); this is for callers that change
   * something the observer can't see.
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
   * Optional generalized channel entries. Leaving this unset preserves the
   * legacy chat-only timeline used by NIP-29, V1, DMs, and mesh.
   */
  entries?: readonly ChannelTimelineEntry[];
  /** Renderer for non-chat entries supplied through `entries`. */
  renderEntry?: (entry: NonChatEntry, relatedEntries?: readonly NonChatEntry[]) => ReactNode;
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
  /**
   * True while a background catch-up for THIS conversation is in flight (a
   * sync-activity task scoped to it). An empty timeline then says so — "no
   * messages" is a verdict, and it isn't in until the catch-up settles.
   *
   * Deliberately NOT part of the skeleton gate: the skeleton stands for the
   * LOCAL read, which is over in milliseconds, while a relay round can take
   * seconds. Dressing network latency up as a load left a fully-cached
   * conversation behind a skeleton for as long as its backfill ran.
   */
  syncing?: boolean;
  className?: string;
}

/**
 * A fixed pseudo-thread for the loading placeholder: alternating authors, runs
 * of same-author continuations, and bodies of one to three lines at varied
 * widths. Real conversations look like this; a column of identical
 * avatar-plus-one-line rows reads as a progress indicator, not as content.
 *
 * Fixed rather than random so the placeholder never reshuffles between renders,
 * and geometry matches {@link MessageRow} exactly (size-10 avatar, gap-3,
 * py-1.5 head rows / py-0.5 continuations, w-10 continuation gutter) so nothing
 * shifts when the real messages replace it.
 */
const SKELETON_ROWS: { continuation: boolean; name?: string; widths: string[] }[] = [
  { continuation: false, name: "5rem", widths: ["62%"] },
  { continuation: true, widths: ["38%"] },
  { continuation: true, widths: ["74%", "41%"] },
  { continuation: false, name: "7rem", widths: ["48%"] },
  { continuation: false, name: "4.5rem", widths: ["83%", "56%", "29%"] },
  { continuation: true, widths: ["35%"] },
  { continuation: false, name: "6rem", widths: ["67%"] },
  { continuation: true, widths: ["52%", "44%"] },
  { continuation: false, name: "5.5rem", widths: ["31%"] },
  { continuation: false, name: "8rem", widths: ["78%", "38%"] },
  { continuation: true, widths: ["59%"] },
  { continuation: false, name: "4rem", widths: ["45%", "70%"] },
  { continuation: true, widths: ["33%"] },
  { continuation: false, name: "6.5rem", widths: ["71%", "50%"] },
];

/**
 * Bottom-anchored loading placeholder for the timeline.
 *
 * `justify-end` plus `overflow-hidden` makes this behave like the real thread:
 * content sits on the bottom edge and the surplus is clipped at the top, so it
 * reads as history scrolled off-screen rather than a short list floating in an
 * empty pane. The pattern is repeated so it overflows tall viewports too — the
 * previous fixed eight rows left most of the screen blank.
 */
function TimelineSkeleton() {
  return (
    <div
      className="flex-1 min-h-0 overflow-hidden flex flex-col justify-end px-3 py-4"
      aria-hidden
    >
      {[...SKELETON_ROWS, ...SKELETON_ROWS].map((row, i) => (
        <div
          key={i}
          className={cn("flex items-start gap-3 px-2.5", row.continuation ? "py-0.5" : "py-1.5")}
        >
          {row.continuation ? (
            <div className="w-10 shrink-0" />
          ) : (
            <Skeleton className="size-10 rounded-full shrink-0 mt-0.5" />
          )}
          <div className="flex-1 min-w-0 space-y-1.5">
            {!row.continuation && (
              <div className="flex items-baseline gap-2">
                <Skeleton className="h-3.5" style={{ width: row.name }} />
                <Skeleton className="h-2.5 w-8" />
              </div>
            )}
            {row.widths.map((width, j) => (
              <Skeleton key={j} className="h-3.5 max-w-full" style={{ width }} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * The transport-agnostic message timeline: a bottom-anchored, auto-scrolling
 * scroll area with scroll-up backfill, same-author continuation collapsing, a
 * loading skeleton and an empty state. It owns only scroll mechanics and the
 * continuation rule; every message's content/actions come from `renderMessage`,
 * and all data/mutations come from the {@link ChatTransport}. Shared by NIP-29
 * group chat, Concord communities, DMs and the Bluetooth mesh.
 *
 * ## Why this is a plain scroller and not a virtualized list
 *
 * Rows here change height *after* they mount — images decode, link previews and
 * embeds resolve, reactions and thread badges arrive. A measuring virtualizer
 * positions rows from heights it sampled at mount, so every one of those
 * resizes invalidates its model and it has to guess how to re-anchor the
 * viewport; that guess is what the reader sees as a jump. It also
 * absolutely-positions rows, which switches off the browser's own scroll
 * anchoring (`overflow-anchor`) — the mechanism that solves exactly this
 * problem for free in normal flow.
 *
 * So the rows are real DOM in normal flow, and the *data* is bounded instead:
 *
 * - **Bounded window.** A conversation opens with {@link FIRST_PAINT_WINDOW}
 *   rows and fills out to {@link INITIAL_WINDOW} a frame later, which is what
 *   keeps a channel switch cheap (the switch cost is O(rows in the commit) of
 *   React mounting, not O(loaded history)). Nearing the top reveals
 *   {@link WINDOW_STEP} more already-loaded messages, then asks the transport
 *   for older ones. Returning to the bottom trims back down.
 * - **Anchored position.** The window is anchored to a message ID, and any
 *   change to the top of the rendered slice is compensated by measuring one row
 *   before the commit and putting it back afterwards ({@link captureAnchor}).
 * - **Async row growth** is left to the browser: content that resizes above the
 *   viewport is absorbed by native scroll anchoring, so a row that grows late
 *   costs nothing instead of teleporting the view. (Safari has no
 *   `overflow-anchor`; there it degrades to the same shift a plain page has.)
 * - **Stick-to-bottom** restores the reader's *distance* from the bottom rather
 *   than snapping to it, so a reader who has just started scrolling up isn't
 *   yanked back when an image below them finishes decoding.
 */
export function MessageTimeline({
  transport,
  renderMessage,
  entries,
  renderEntry,
  emptyState,
  handleRef,
  paused = false,
  newDividerId,
  syncing = false,
  className,
}: MessageTimelineProps) {
  const { messages, isLoading, loadOlder, hasMore, isLoadingOlder } = transport;

  // The row stream, generalized: callers that pass `entries` interleave non-chat
  // rows (Git activity) chronologically; everyone else gets the chat-only view.
  // Memoized because the row model and the prepend anchor both compare by
  // identity — a fresh array each render would look like a new conversation.
  const timelineEntries = useMemo<readonly ChannelTimelineEntry[]>(
    () =>
      entries ??
      messages.map((message) => ({
        type: "chat" as const,
        id: `chat:${message.id}`,
        createdAt: message.created_at,
        message,
      })),
    [entries, messages],
  );

  // Remember that we've shown a populated timeline. If `messages` then briefly
  // empties (a transient between a cache refresh and the merged result landing),
  // we render the skeleton rather than flashing the empty state / a blank gap —
  // the timeline never truly "loses" its history, so a momentary empty array is
  // a render artifact, not an empty channel. Reset while a fresh load is in
  // flight (channel switch) so a genuinely-empty channel still shows its empty
  // state instead of a stale skeleton.
  const hadMessagesRef = useRef(false);
  if (isLoading) hadMessagesRef.current = false;
  if (timelineEntries.length > 0) hadMessagesRef.current = true;
  const transientEmpty = timelineEntries.length === 0 && hadMessagesRef.current;

  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  // Live mirrors, so scroll/observer callbacks never close over stale props.
  const entriesRef = useRef(timelineEntries);
  entriesRef.current = timelineEntries;

  // How far the reader is from the newest message. Updated on every scroll and
  // after every programmatic move; the single input to stick-to-bottom.
  const distanceRef = useRef(0);
  // A window extension is committed but not yet laid out — don't stack another.
  const extendLockRef = useRef(false);
  // A transport backfill is in flight (independent of the transport's own,
  // possibly lagging, `isLoadingOlder`).
  const loadingOlderRef = useRef(false);
  // The next layout should pin to the bottom (first paint, conversation switch).
  const pinBottomRef = useRef(true);
  // A message id to reveal-and-jump-to once it's in the rendered window.
  const pendingJumpRef = useRef<string | null>(null);
  const anchorRef = useRef<ScrollAnchor | null>(null);
  // Previous scroll offset, to tell a reader moving up from this component's
  // own downward scrolls (see `handleScroll`).
  const lastScrollTopRef = useRef(Number.POSITIVE_INFINITY);

  // The scroller only exists once there's something to put in it; the skeleton
  // replaces it outright.
  const listVisible = !isLoading && !transientEmpty && timelineEntries.length > 0;
  // So while the skeleton is up there is no scroll position to preserve, and
  // the scroller will remount at `scrollTop: 0`: the next layout has to pin.
  // The opening pin is otherwise armed only at mount, and `messages` routinely
  // arrives *before* `isLoading` clears (DMs merge two independently-loading
  // planes), so the commits that fill the window can all land while the
  // scroller is still unmounted and the pin has nothing to act on.
  if (!listVisible) pinBottomRef.current = true;

  const [showJumpPill, setShowJumpPill] = useState(false);

  // Oldest message currently rendered. `null` = the newest INITIAL_WINDOW.
  const [windowStartId, setWindowStartId] = useState<string | null>(null);
  const windowStartIdRef = useRef<string | null>(null);
  windowStartIdRef.current = windowStartId;

  /** Move the top of the rendered window, eagerly so callbacks see it at once. */
  const setWindowStart = useCallback((id: string | null) => {
    windowStartIdRef.current = id;
    setWindowStartId(id);
  }, []);

  // Rows per commit as a conversation opens. The click that switches channels
  // is what pays for the first commit, so it renders NO message rows: they
  // arrive on the following frames, off the interaction's critical path.
  const [rampStep, setRampStep] = useState(0);

  // The window is resolved over the ENTRY stream, not just chat: a channel
  // whose recent history is mostly Git activity must still open with a full
  // window, and the anchor id has to name a row that actually exists.
  const { startIndex, anchorLost } = useMemo(
    () => resolveWindowStart(timelineEntries, windowStartId, OPENING_RAMP[rampStep]),
    [timelineEntries, windowStartId, rampStep],
  );
  const startIndexRef = useRef(startIndex);
  startIndexRef.current = startIndex;

  // Flatten the windowed slice + injected separators into rows, applying the
  // shared continuation rule (same author, same day, small gap). Continuation
  // is computed against the entry *before* the window so the topmost row
  // doesn't change shape as the window grows.
  const items = useMemo<TimelineItem[]>(() => {
    const out: TimelineItem[] = [];
    for (let i = startIndex; i < timelineEntries.length; i++) {
      const entry = timelineEntries[i];
      const prev = timelineEntries[i - 1];
      const newDay = !!prev && !isSameDay(prev.createdAt, entry.createdAt);
      // A Git entry continuing the previous one is absorbed into that row's
      // group (see relatedGitEntries) and emits no row of its own — unless it
      // opens the window, where its group head sits outside the rendered slice
      // and absorbing it would drop the row entirely.
      if (i > startIndex && !newDay && isGitContinuation(prev, entry)) continue;
      // `renderKey` where the transport has one: an optimistic row's `id`
      // changes when it adopts the signed event id, and keying on that would
      // remount the row (and its date separator) mid-send. Git entries are
      // never optimistic, so their own id is already stable.
      const rowKey = entry.type === "chat" ? entry.message.renderKey ?? entry.message.id : entry.id;
      if (newDay) out.push({ type: "date", ts: entry.createdAt, key: `date-${rowKey}` });
      if (entry.type === "chat") {
        if (newDividerId === entry.message.id) out.push({ type: "unread", key: "unread-divider" });
        const continuation =
          !!prev &&
          prev.type === "chat" &&
          !newDay &&
          prev.message.pubkey === entry.message.pubkey &&
          entry.createdAt - prev.createdAt < CONTINUATION_WINDOW_SECONDS;
        out.push({ type: "message", msg: entry.message, continuation, key: rowKey });
      } else {
        if (newDividerId === entry.id) out.push({ type: "unread", key: "unread-divider" });
        out.push({
          type: "entry",
          entry,
          related: relatedGitEntries(timelineEntries, i, entry),
          key: rowKey,
        });
      }
    }
    return out;
  }, [timelineEntries, startIndex, newDividerId]);

  // Rows are about to change at the top of the slice (a revealed batch, a
  // backfill prepend, a trim). Measure the reader's anchor row NOW, while the
  // DOM still shows the old slice — render runs before React touches the DOM.
  const prevFirstKeyRef = useRef<string | null>(null);
  const firstKey = items[0]?.key ?? null;
  if (firstKey !== prevFirstKeyRef.current) {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (
      prevFirstKeyRef.current !== null &&
      firstKey !== null &&
      !anchorLost &&
      distanceRef.current > AT_BOTTOM_PX &&
      scroller &&
      content
    ) {
      anchorRef.current = captureAnchor(scroller, content, items);
    }
    prevFirstKeyRef.current = firstKey;
  }

  /** Jump to the newest message and resume following it. */
  const pinToBottomNow = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    distanceRef.current = 0;
    lastScrollTopRef.current = el.scrollTop;
    setShowJumpPill(false);
  }, []);

  /**
   * Hold the reader's distance from the newest message across a content-height
   * change. At the bottom this pins; a few dozen pixels up it preserves those
   * pixels instead of snapping — the difference between "the view stays put as
   * an image loads" and "the view yanks me back down".
   */
  const stickToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (distanceRef.current > AT_BOTTOM_PX) return;
    el.scrollTop = el.scrollHeight - el.clientHeight - distanceRef.current;
    lastScrollTopRef.current = el.scrollTop;
  }, []);

  /** Center a mounted row and flash a highlight over it. */
  const jumpToRow = useCallback((id: string) => {
    const el = scrollRef.current;
    const row = contentRef.current?.querySelector<HTMLElement>(`[data-event-id="${id}"]`);
    if (!el || !row) return;
    // Rows above the target that have never been painted are still sitting at
    // their `contain-intrinsic-size` estimate, so the first scroll lands
    // approximately; re-centering on the next two frames settles it once those
    // rows have real heights. Bounded, unlike polling for the row to appear.
    row.scrollIntoView({ block: "center" });
    requestAnimationFrame(() => {
      row.scrollIntoView({ block: "center" });
      requestAnimationFrame(() => row.scrollIntoView({ block: "center" }));
    });
    distanceRef.current = el.scrollHeight - el.scrollTop - el.clientHeight;
    row.classList.add("bg-primary/10", "transition-colors", "duration-1000", "rounded-md");
    setTimeout(() => row.classList.remove("bg-primary/10"), 1200);
    setTimeout(
      () => row.classList.remove("transition-colors", "duration-1000", "rounded-md"),
      2200,
    );
  }, []);

  // The one place scroll position is adjusted for a rendered-slice change.
  // Exactly one of these applies, in priority order.
  useLayoutEffect(() => {
    extendLockRef.current = false;
    const el = scrollRef.current;
    if (!el || items.length === 0) return;
    if (anchorLost) {
      // The window's anchor message is gone: different conversation (or the
      // transport dropped the front of its history). Fall back to the newest
      // messages, pinned to the bottom. Runs before paint, so no flash.
      anchorRef.current = null;
      pinBottomRef.current = true;
      setRampStep(0);
      setWindowStart(null);
      return;
    }
    const jump = pendingJumpRef.current;
    if (jump) {
      pendingJumpRef.current = null;
      anchorRef.current = null;
      pinBottomRef.current = false;
      jumpToRow(jump);
      return;
    }
    if (pinBottomRef.current) {
      pinBottomRef.current = false;
      anchorRef.current = null;
      pinToBottomNow();
      return;
    }
    const anchor = anchorRef.current;
    anchorRef.current = null;
    if (anchor && anchor.items === items) {
      restoreAnchor(el, contentRef.current!, anchor);
      distanceRef.current = el.scrollHeight - el.scrollTop - el.clientHeight;
      lastScrollTopRef.current = el.scrollTop;
      return;
    }
    stickToBottom();
    // `listVisible` is a dependency because the scroller is what this effect
    // moves: every commit before it mounts returns at the `!el` guard above, so
    // without this the pin would be missed entirely whenever the window is
    // already full by the time the skeleton clears.
  }, [items, listVisible, anchorLost, setWindowStart, jumpToRow, pinToBottomNow, stickToBottom]);

  // Content that grows or shrinks without the message list changing (images,
  // link previews, embeds, reactions) and container reflows (the thread panel
  // animating its width, the composer swapping for a join prompt) both land
  // here. Callers used to drive this by polling `maintainBottom` from a rAF
  // loop for ~260ms; the observer sees every frame of it and nothing else.
  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    const ro = new ResizeObserver(() => {
      if (anchorRef.current || pinBottomRef.current || pendingJumpRef.current) return;
      stickToBottom();
    });
    ro.observe(content);
    ro.observe(el);
    return () => ro.disconnect();
  }, [listVisible, stickToBottom]);

  /**
   * Near the top: reveal more already-loaded messages, or — once the window
   * covers everything loaded — ask the transport for an older page.
   *
   * Only while the reader is actually away from the bottom, which is what keeps
   * a freshly-opened conversation from walking its own history in: pinned at
   * the bottom there is nothing above to read yet.
   */
  const maybeExtend = useCallback(() => {
    const el = scrollRef.current;
    if (!el || paused || extendLockRef.current) return;
    if (distanceRef.current <= AT_BOTTOM_PX) return;
    const start = startIndexRef.current;
    if (start > 0) {
      if (el.scrollTop >= REVEAL_TRIGGER_PX) return;
      const next = entriesRef.current[Math.max(0, start - WINDOW_STEP)];
      if (!next) return;
      extendLockRef.current = true;
      setWindowStart(next.id);
      return;
    }
    if (el.scrollTop >= BACKFILL_TRIGGER_PX) return;
    if (!loadOlder || !hasMore || isLoadingOlder || loadingOlderRef.current) return;
    loadingOlderRef.current = true;
    void loadOlder().finally(() => {
      loadingOlderRef.current = false;
    });
  }, [paused, loadOlder, hasMore, isLoadingOlder, setWindowStart]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Only the reader moving up can push us away from the bottom. Every scroll
    // this component performs itself — the opening pin, stick-to-bottom, an
    // anchor restore after rows land above — records its own offset, so this
    // one comparison keeps the timeline from reacting to its own scrolling and
    // walking a channel's history in the moment it opens.
    const movingUp = el.scrollTop < lastScrollTopRef.current;
    lastScrollTopRef.current = el.scrollTop;
    // A row that grows *below* the fold — a DM decrypting out of its
    // placeholder skeleton, an image decoding, a reply context resolving —
    // raises the distance without touching `scrollTop`. Scroll events are
    // delivered a frame after the move that caused them, so the pin's own event
    // routinely arrives with that growth already in `scrollHeight`; banking it
    // as the reader's distance would latch stick-to-bottom off (it gives up
    // past AT_BOTTOM_PX) for the rest of the mount and strand a freshly-opened
    // conversation short of its newest message. Shrinking distance is always
    // safe to record; growth counts only when the reader is the one moving.
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (movingUp || distance <= distanceRef.current) distanceRef.current = distance;
    setShowJumpPill(distanceRef.current > JUMP_PILL_PX);
    if (movingUp) maybeExtend();
  }, [maybeExtend]);

  // Walk the opening ramp, a frame at a time. Rows land above a reader who is
  // pinned to the bottom, so nothing moves as the window fills out.
  useEffect(() => {
    if (rampStep >= OPENING_RAMP.length - 1 || timelineEntries.length === 0) return;
    const frame = requestAnimationFrame(() => setRampStep((step) => step + 1));
    return () => cancelAnimationFrame(frame);
  }, [rampStep, timelineEntries.length]);

  // Back at the bottom with a long window behind us: drop it back to the newest
  // messages. The rows removed are far above the viewport, so this is invisible
  // — and it's the only thing bounding a long session's DOM.
  useEffect(() => {
    if (distanceRef.current > AT_BOTTOM_PX) return;
    if (timelineEntries.length - startIndex <= TRIM_ABOVE) return;
    setWindowStart(null);
  }, [timelineEntries, startIndex, setWindowStart]);

  // Scroll a message into view and briefly highlight it. No-op if it isn't in
  // the loaded history; if it's older than the rendered window, the window is
  // extended to cover it first and the jump happens in the same commit.
  const scrollToMessage = useCallback(
    (id: string) => {
      // Indexes and the window anchor are entry-space; the row key stays the
      // message id, which is what callers jump by.
      const all = entriesRef.current;
      const index = all.findIndex((entry) => entry.type === "chat" && entry.message.id === id);
      if (index === -1) return false;
      if (index < startIndexRef.current) {
        pendingJumpRef.current = id;
        setWindowStart(all[Math.max(0, index - JUMP_CONTEXT)].id);
        return true;
      }
      jumpToRow(id);
      return true;
    },
    [jumpToRow, setWindowStart],
  );

  useImperativeHandle(
    handleRef,
    () => ({
      scrollToMessage,
      pinToBottom: () => {
        distanceRef.current = 0;
        pinToBottomNow();
      },
      maintainBottom: stickToBottom,
    }),
    [scrollToMessage, pinToBottomNow, stickToBottom],
  );

  return (
    <div className={cn("relative flex flex-col", className)}>
      {isLoading || transientEmpty ? (
        <TimelineSkeleton />
      ) : timelineEntries.length === 0 ? (
        <div className="flex-1 min-h-0 overflow-y-auto px-3 py-4">
          {/* An empty conversation with a catch-up still running hasn't been
              judged yet, so it must not read as "no messages" — but it isn't
              LOADING either (the local read is done and it was empty). Say
              which of the two it is, rather than holding a skeleton that
              claims history is about to appear from disk. */}
          {syncing ? (
            <p className="flex items-center justify-center gap-2 px-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin shrink-0" />
              Catching up…
            </p>
          ) : (
            emptyState ?? null
          )}
        </div>
      ) : (
        <>
          <div
            ref={scrollRef}
            onScroll={handleScroll}
            className="flex-1 min-h-0 overflow-y-auto overflow-x-clip overscroll-contain scrollbar-stable px-3"
          >
            {/* Positioned, so every row's `offsetTop` is measured against it. */}
            <div ref={contentRef} className="relative">
              <div className="h-4" aria-hidden />
              {items.map((item) => (
                // `hover:z-10` lifts the hovered row above its siblings so the
                // floating action toolbar (which overhangs the row's top edge)
                // isn't painted under the row above.
                <div
                  key={item.key}
                  data-row-key={item.key}
                  className="relative hover:z-10 focus-within:z-10"
                >
                  {item.type === "date" ? (
                    <DateSeparator ts={item.ts} />
                  ) : item.type === "unread" ? (
                    <NewMessagesDivider />
                  ) : item.type === "entry" ? (
                    renderEntry?.(item.entry, item.related)
                  ) : (
                    renderMessage(item.msg, item.continuation)
                  )}
                </div>
              ))}
              <div className="h-4" aria-hidden />
            </div>
          </div>
          {/* Backfill spinner, floating OVER the top edge rather than occupying
              space in the scroll content: growing and shrinking the content at
              the very edge the reader is anchored to jolts the view twice per
              loaded page. */}
          {isLoadingOlder && (
            <div className="absolute top-1 inset-x-0 z-10 flex justify-center pointer-events-none">
              <span className="rounded-full bg-background/80 backdrop-blur p-1.5 shadow-sm">
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              </span>
            </div>
          )}
          {/* Jump-to-present pill, floating over the bottom edge of the list. */}
          {showJumpPill && (
            <div className="absolute bottom-3 inset-x-0 z-10 flex justify-center pointer-events-none">
              <button
                type="button"
                onClick={() => {
                  distanceRef.current = 0;
                  pinToBottomNow();
                }}
                className="pointer-events-auto inline-flex items-center gap-2 rounded-full border border-border/60 bg-secondary/90 backdrop-blur px-5 py-2.5 text-sm font-medium text-foreground shadow-lg hover:bg-secondary transition-colors"
                aria-label="Jump to the latest messages"
              >
                <ChevronDown className="size-4" />
                Jump to present
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
