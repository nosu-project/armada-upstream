import { ChevronDown, KeyRound, Loader2, MessagesSquare, Pause } from "lucide-react";
import { memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  FIRST_PAINT_WINDOW,
  INITIAL_WINDOW,
  resolveWindowStart,
  stepBackRows,
  TRIM_ABOVE,
  WINDOW_STEP,
} from "@/components/chat/timelineWindow";
import { flashRow } from "@/components/chat/rowFlash";
import {
  captureScrollAnchor,
  clampedScrollTop,
  distanceFromBottom,
  restoreScrollAnchor,
  type ScrollAnchor,
} from "@/components/chat/scrollAnchor";
import { Skeleton } from "@/components/ui/skeleton";
import { markBootPainted } from "@/lib/bootGate";
import { useHiddenMessages } from "@/hooks/useHiddenMessages";
import { useMutedPubkeys } from "@/hooks/useMuteList";
import { usePerfMilestone } from "@/hooks/usePerfMilestone";
import { cn } from "@/lib/utils";

import { isGitContinuation, timelineEntryAuthor, type ChannelTimelineEntry } from "@/components/chat/channelTimeline";
import type { ChatMsg, ChatTransport } from "@/components/chat/transport";
import type { ReactNode, RefObject } from "react";

/** Max gap (seconds) for a same-author message to render as a continuation. */
const CONTINUATION_WINDOW_SECONDS = 5 * 60;

/** Shortest flood run worth folding: interleaved chat can split floods into tiny fragments. */
const FLOOD_ROW_MIN = 3;

/** Distance from the top (px) that requests older history; a screenful-plus so the fetch overlaps reading. */
const BACKFILL_TRIGGER_PX = 1200;

const REVEAL_TRIGGER_PX = 900;

const AT_BOTTOM_PX = 60;

const JUMP_PILL_PX = 300;

const JUMP_CONTEXT = 15;

/** Rows per commit as a conversation opens, one step per frame; the switch click's commit mounts none. */
const OPENING_RAMP = [0, FIRST_PAINT_WINDOW, INITIAL_WINDOW];

export function isSameDay(a: number, b: number): boolean {
  const da = new Date(a * 1000);
  const db = new Date(b * 1000);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

function formatDayLabel(ts: number): string {
  const date = new Date(ts * 1000);
  const now = new Date();
  if (isSameDay(ts, Math.floor(now.getTime() / 1000))) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (isSameDay(ts, Math.floor(yesterday.getTime() / 1000))) return "Yesterday";
  return (date.getFullYear() === now.getFullYear() ? DAY_FORMAT : DAY_YEAR_FORMAT).format(date);
}

// Built once: `toLocaleDateString` with options builds a new Intl.DateTimeFormat per call.
const DAY_FORMAT = new Intl.DateTimeFormat(undefined, { month: "long", day: "numeric" });
const DAY_YEAR_FORMAT = new Intl.DateTimeFormat(undefined, { month: "long", day: "numeric", year: "numeric" });

/** Discord-style day separator. Memoized: the list re-renders on most page renders. */
export const DateSeparator = memo(function DateSeparator({ ts }: { ts: number }) {
  return (
    <div className="flex items-center gap-3 px-2 pt-3 pb-1 select-none" aria-hidden>
      <div className="h-px flex-1 bg-border/60" />
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/80">
        {formatDayLabel(ts)}
      </span>
      <div className="h-px flex-1 bg-border/60" />
    </div>
  );
});

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

/**
 * Concord key-rotation boundary: everything above was sealed under a previous
 * key. The warning tone is deliberate.
 */
function KeyRotationDivider() {
  return (
    <div
      className="flex items-center gap-3 px-2 py-1 select-none"
      role="separator"
      aria-label="Key rotated. Earlier messages use a previous key"
    >
      <div className="h-px flex-1 bg-amber-500/50" />
      <span
        className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-500"
        title="The community's encryption key was rotated here. Messages above were sealed under a previous key."
      >
        <KeyRound className="size-3" aria-hidden />
        Key rotated
      </span>
      <div className="h-px flex-1 bg-amber-500/50" />
    </div>
  );
}

/**
 * A run the transport marked as flood (`quarantinedIds`), folded into one
 * openable row — a summary, not a removal, since the heuristic can be wrong.
 * `paused` swaps the copy for a community pause (CORD-04 §8), where flood
 * wording would be a false accusation.
 */
function FloodNotice({
  count,
  authors,
  paused,
  expanded,
  onToggle,
}: {
  count: number;
  authors: number;
  paused: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const label = expanded
    ? paused
      ? "Hide messages sent while paused"
      : "Hide similar messages"
    : paused
      ? `${count} ${count === 1 ? "message" : "messages"} sent while the community was paused`
      : `${count} similar ${count === 1 ? "message" : "messages"} from ${authors} ${authors === 1 ? "account" : "accounts"}`;
  return (
    <div className="flex items-center gap-3 px-2 py-1 select-none">
      <div className="h-px flex-1 bg-muted-foreground/25" />
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex items-center gap-1.5 rounded px-1.5 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground touch:py-1.5 touch:text-xs"
        title={
          expanded
            ? "Fold these back up"
            : paused
              ? "Posted after a moderator paused the community. Nothing was removed."
              : "Several accounts posted near-identical messages at once. Nothing was removed."
        }
      >
        {paused ? <Pause className="size-3 shrink-0" aria-hidden /> : <MessagesSquare className="size-3 shrink-0" aria-hidden />}
        {label}
      </button>
      <div className="h-px flex-1 bg-muted-foreground/25" />
    </div>
  );
}

type TimelineItem =
  | { type: "date"; ts: number; key: string }
  | { type: "unread"; key: string }
  | { type: "rotation"; key: string }
  | { type: "message"; msg: ChatMsg; continuation: boolean; key: string }
  | { type: "flood"; msgs: readonly ChatMsg[]; authors: number; paused: boolean; key: string }
  | { type: "entry"; entry: NonChatEntry; related?: readonly NonChatEntry[]; key: string };

type NonChatEntry = Exclude<ChannelTimelineEntry, { type: "chat" }>;

/**
 * A Git group head plus its same-day continuations (which emit no row).
 * `undefined` for a lone entry. Grouping rules: {@link isGitContinuation}.
 */
function relatedGitEntries(
  entries: readonly ChannelTimelineEntry[],
  index: number,
  entry: NonChatEntry,
): readonly NonChatEntry[] | undefined {
  // Checked before allocating: most entries start no group.
  if (!isGitContinuation(entry, entries[index + 1])) return undefined;
  const related: NonChatEntry[] = [entry];
  for (let cursor = index + 1; cursor < entries.length; cursor++) {
    const candidate = entries[cursor];
    if (
      !candidate ||
      candidate.type === "chat" ||
      !isSameDay(entry.createdAt, candidate.createdAt) ||
      !isGitContinuation(related[related.length - 1], candidate)
    ) {
      break;
    }
    related.push(candidate);
  }
  return related.length > 1 ? related : undefined;
}

export interface MessageTimelineHandle {
  /**
   * Reveal and center a loaded message; false when not in this timeline (e.g. a
   * thread reply). `focus` marks a permalink target (longer highlight + bar).
   */
  scrollToMessage: (id: string, focus?: boolean) => boolean;
  pinToBottom: () => void;
  /**
   * Stay at the bottom only if already there, for changes the internal
   * ResizeObserver can't see.
   */
  maintainBottom: () => void;
}

interface MessageTimelineProps {
  transport: ChatTransport;
  /** Render one message row; `continuation` is precomputed from the shared rule. */
  renderMessage: (event: ChatMsg, continuation: boolean) => ReactNode;
  /** Generalized channel entries; unset keeps the chat-only timeline (NIP-29, DMs, mesh). */
  entries?: readonly ChannelTimelineEntry[];
  renderEntry?: (entry: NonChatEntry, relatedEntries?: readonly NonChatEntry[]) => ReactNode;
  emptyState?: ReactNode;
  handleRef?: RefObject<MessageTimelineHandle | null>;
  /** Yield to a caller overlay (e.g. search results); suppresses scroll backfill. */
  paused?: boolean;
  /** First unread message id; the "NEW" divider renders above it (see {@link useNewMessagesDivider}). */
  newDividerId?: string;
  /**
   * A catch-up for this conversation is in flight, so an empty timeline isn't
   * "no messages" yet. Not part of the skeleton gate: the skeleton is for the
   * fast local read, not network latency.
   */
  syncing?: boolean;
  /**
   * The catch-up keeps failing. Empty relay reads also land here, so the empty
   * state says only that nothing has loaded yet, not that relays are unreachable.
   */
  syncFailed?: boolean;
  className?: string;
}

/**
 * Fixed pseudo-thread for the loading placeholder (varied authors and line
 * counts). Geometry matches {@link MessageRow} so nothing shifts on swap.
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

/** Bottom-anchored placeholder, clipped at the top like scrolled-off history. */
const TimelineSkeleton = memo(function TimelineSkeleton() {
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
});

/**
 * Transport-agnostic message timeline (NIP-29, Concord, DMs, mesh): owns scroll
 * mechanics and the continuation rule; content comes from `renderMessage`.
 *
 * Not virtualized: rows change height after mounting, which makes a measuring
 * virtualizer jump, and absolute positioning disables native scroll anchoring.
 * Instead the data is bounded:
 * - **Bounded window**: opens with {@link FIRST_PAINT_WINDOW} rows, fills to
 *   {@link INITIAL_WINDOW}, reveals {@link WINDOW_STEP} more near the top before
 *   asking the transport, and trims back at the bottom.
 * - **Anchored position**: the first visible row and its offset are restored
 *   after reveals/prepends/growth (explicitly; WebKit lacks CSS scroll anchoring).
 * - **Stick-to-bottom** preserves distance from the bottom rather than snapping.
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
  syncFailed = false,
  className,
}: MessageTimelineProps) {
  const { messages, isLoading, loadOlder, hasMore, isLoadingOlder, rotationDividerIds, quarantinedIds, pausedIds } =
    transport;

  // Opened flood rows, keyed by the run's first message id (so they don't leak
  // across channels). `floodRunOfRef` lets a jump open the run hiding its target.
  const [expandedFloods, setExpandedFloods] = useState<ReadonlySet<string>>(() => new Set());
  const floodRunOfRef = useRef<Map<string, string>>(new Map());
  const toggleFlood = useCallback((key: string) => {
    setExpandedFloods((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);

  // The key milestone: when the skeleton came down.
  const firstRowsPainted = !isLoading && messages.length > 0;
  usePerfMilestone("timeline.first rows", firstRowsPainted);
  // Cue for the boot gate. (An empty channel opens it via its timeout.)
  useEffect(() => {
    if (firstRowsPainted) markBootPainted();
  }, [firstRowsPainted]);

  // Memoized: the row model and prepend anchor compare by identity.
  const allEntries = useMemo<readonly ChannelTimelineEntry[]>(
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

  // Mutes and hidden messages are filtered here, where every surface funnels
  // through. Mutes are skipped while cold (`!ready`) rather than hiding rows
  // without basis.
  const { mutedPubkeys, ready: mutesReady } = useMutedPubkeys();
  const { hiddenIds } = useHiddenMessages();
  const timelineEntries = useMemo<readonly ChannelTimelineEntry[]>(() => {
    const dropMuted = mutesReady && mutedPubkeys.size > 0;
    if (!dropMuted && hiddenIds.size === 0) return allEntries;
    const kept = allEntries.filter((entry) => {
      if (entry.type === "chat" && hiddenIds.has(entry.message.id)) return false;
      if (!dropMuted) return true;
      const author = timelineEntryAuthor(entry);
      return !author || !mutedPubkeys.has(author);
    });
    // Preserve identity when nothing was removed (the prepend anchor compares it).
    return kept.length === allEntries.length ? allEntries : kept;
  }, [allEntries, mutedPubkeys, mutesReady, hiddenIds]);

  // Once populated, a transient empty array shows the skeleton rather than the
  // empty state; reset while a fresh load is in flight. Tracked on UNFILTERED
  // entries, or a fully-muted channel would hold the skeleton forever.
  const hadMessagesRef = useRef(false);
  if (isLoading) hadMessagesRef.current = false;
  if (allEntries.length > 0) hadMessagesRef.current = true;
  const transientEmpty = allEntries.length === 0 && hadMessagesRef.current;

  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  // Live mirrors, so scroll/observer callbacks never close over stale props.
  const entriesRef = useRef(timelineEntries);
  entriesRef.current = timelineEntries;
  const quarantinedIdsRef = useRef(quarantinedIds);
  quarantinedIdsRef.current = quarantinedIds;

  // Distance from the newest message; the single input to stick-to-bottom.
  const distanceRef = useRef(0);
  // A window extension is committed but not yet laid out — don't stack another.
  const extendLockRef = useRef(false);
  // Independent of the transport's possibly lagging `isLoadingOlder`.
  const loadingOlderRef = useRef(false);
  // A scroll-triggered page landed above the first row: reveal a step
  // automatically, since a reader at scrollTop=0 has no further upward scroll.
  const backfillRevealRef = useRef<{ boundaryId: string; count: number } | null>(null);
  const [backfillPulse, setBackfillPulse] = useState(0);
  const pinBottomRef = useRef(true);
  const pendingJumpRef = useRef<{ id: string; focus: boolean } | null>(null);
  // Persistent so it survives React 19 interrupted renders and async row resizes.
  const readingAnchorRef = useRef<ScrollAnchor | null>(null);
  // Distinguishes the reader moving up from our own downward scrolls.
  const lastScrollTopRef = useRef(Number.POSITIVE_INFINITY);
  // A slice change that leaves the reader at the top emits no further upward
  // scroll, so re-check next frame (one rAF per burst). `maybeExtendRef` breaks
  // the declaration-order cycle.
  const continueRafRef = useRef<number | null>(null);
  const maybeExtendRef = useRef<() => void>(() => {});

  const listVisible = !isLoading && !transientEmpty && timelineEntries.length > 0;
  // The scroller remounts at `scrollTop: 0` after the skeleton, so the next
  // layout must pin (`messages` often arrives before `isLoading` clears).
  if (!listVisible) pinBottomRef.current = true;

  const [showJumpPill, setShowJumpPill] = useState(false);

  // Oldest message currently rendered. `null` = the newest INITIAL_WINDOW.
  const [windowStartId, setWindowStartId] = useState<string | null>(null);
  const windowStartIdRef = useRef<string | null>(null);
  windowStartIdRef.current = windowStartId;

  const setWindowStart = useCallback((id: string | null) => {
    windowStartIdRef.current = id;
    setWindowStartId(id);
  }, []);

  const [rampStep, setRampStep] = useState(0);

  // Resolved over the ENTRY stream (Git rows included); a folded flood counts
  // as ONE row so spam can't spend the whole window.
  const { startIndex, anchorLost } = useMemo(
    () =>
      resolveWindowStart(timelineEntries, windowStartId, OPENING_RAMP[rampStep], (entry) =>
        entry.type === "chat" ? !!quarantinedIds?.has(entry.message.id) : false,
      ),
    [timelineEntries, windowStartId, rampStep, quarantinedIds],
  );
  const startIndexRef = useRef(startIndex);
  startIndexRef.current = startIndex;

  // Continuation is computed against the entry before the window so the top row
  // doesn't change shape as it grows.
  const items = useMemo<TimelineItem[]>(() => {
    const out: TimelineItem[] = [];
    const runOf = new Map<string, string>();
    /**
     * Foldable into a flood run? Not the "NEW" divider's target (must stay visible)
     * nor a key-rotation boundary (folding would delete the rotation line).
     */
    const floodable = (entry: ChannelTimelineEntry | undefined) =>
      !!entry &&
      entry.type === "chat" &&
      !!quarantinedIds?.has(entry.message.id) &&
      newDividerId !== entry.message.id &&
      !rotationDividerIds?.has(entry.message.id);

    for (let i = startIndex; i < timelineEntries.length; i++) {
      const entry = timelineEntries[i];
      const prev = timelineEntries[i - 1];
      const newDay = !!prev && !isSameDay(prev.createdAt, entry.createdAt);

      // A run breaks on any other message and on a day boundary.
      if (floodable(entry)) {
        const run: ChatMsg[] = [];
        let j = i;
        for (; j < timelineEntries.length; j++) {
          const at = timelineEntries[j];
          if (!floodable(at) || at.type !== "chat") break;
          if (j > i && !isSameDay(timelineEntries[j - 1].createdAt, at.createdAt)) break;
          run.push(at.message);
        }
        if (run.length >= FLOOD_ROW_MIN) {
          const headKey = run[0].renderKey ?? run[0].id;
          const key = `flood-${headKey}`;
          if (newDay) out.push({ type: "date", ts: entry.createdAt, key: `date-${headKey}` });
          for (const m of run) runOf.set(m.id, key);
          out.push({
            type: "flood",
            msgs: run,
            authors: new Set(run.map((m) => m.pubkey)).size,
            // Only when the WHOLE run is pause-collapsed; mixed runs keep the flood copy.
            paused: run.every((m) => pausedIds?.has(m.id) ?? false),
            key,
          });
          i = j - 1;
          continue;
        }
      }
      // Absorbed into the previous Git row's group, unless it opens the window
      // (its head would be outside the slice).
      if (i > startIndex && !newDay && isGitContinuation(prev, entry)) continue;
      // `renderKey` keeps optimistic rows from remounting when they adopt the signed id.
      const rowKey = entry.type === "chat" ? entry.message.renderKey ?? entry.message.id : entry.id;
      if (newDay) out.push({ type: "date", ts: entry.createdAt, key: `date-${rowKey}` });
      if (entry.type === "chat") {
        if (rotationDividerIds?.has(entry.message.id)) {
          out.push({ type: "rotation", key: `rotation-${rowKey}` });
        }
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
    // Assigned during render so it never lags the rows by a commit.
    floodRunOfRef.current = runOf;
    return out;
  }, [timelineEntries, startIndex, newDividerId, rotationDividerIds, quarantinedIds, pausedIds]);

  const captureReadingAnchor = useCallback(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!scroller || !content || distanceRef.current <= AT_BOTTOM_PX) {
      readingAnchorRef.current = null;
      return;
    }
    // Ignore WebKit rubber-band positions outside the real scroll range.
    if (scroller.scrollTop !== clampedScrollTop(scroller)) return;
    readingAnchorRef.current = captureScrollAnchor(scroller, content, readingAnchorRef.current);
  }, []);

  const restoreReadingAnchor = useCallback(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    const anchor = readingAnchorRef.current;
    if (!scroller || !content || !anchor) return false;
    if (!restoreScrollAnchor(scroller, content, anchor)) {
      readingAnchorRef.current = null;
      return false;
    }
    distanceRef.current = distanceFromBottom(scroller);
    lastScrollTopRef.current = clampedScrollTop(scroller);
    return true;
  }, []);

  const pinToBottomNow = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    distanceRef.current = 0;
    lastScrollTopRef.current = clampedScrollTop(el);
    readingAnchorRef.current = null;
    setShowJumpPill(false);
  }, []);

  /** Hold the reader's distance from the bottom across height changes (pins only at the bottom). */
  const stickToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (distanceRef.current > AT_BOTTOM_PX) return;
    el.scrollTop = el.scrollHeight - el.clientHeight - distanceRef.current;
    lastScrollTopRef.current = clampedScrollTop(el);
    readingAnchorRef.current = null;
  }, []);

  const jumpToRow = useCallback((id: string, focus = false) => {
    const el = scrollRef.current;
    if (!el) return;
    const settle = () => {
      const row = contentRef.current?.querySelector<HTMLElement>(`[data-event-id="${id}"]`);
      if (!row) return;
      flashRow(row, focus);
      distanceRef.current = distanceFromBottom(el);
      lastScrollTopRef.current = clampedScrollTop(el);
      captureReadingAnchor();
    };
    if (contentRef.current?.querySelector(`[data-event-id="${id}"]`)) {
      settle();
      return;
    }
    // Folded under a flood row: open it and jump next frame.
    const runKey = floodRunOfRef.current.get(id);
    if (!runKey) return;
    setExpandedFloods((prev) => (prev.has(runKey) ? prev : new Set(prev).add(runKey)));
    requestAnimationFrame(settle);
  }, [captureReadingAnchor]);

  // The one place scroll is adjusted for a rendered-slice change; exactly one
  // branch applies, in priority order.
  useLayoutEffect(() => {
    extendLockRef.current = false;
    const el = scrollRef.current;
    if (!el || items.length === 0) return;
    if (anchorLost) {
      // The anchor message is gone (different conversation): fall back to the
      // newest, pinned. Before paint, so no flash.
      readingAnchorRef.current = null;
      pinBottomRef.current = true;
      setRampStep(0);
      setWindowStart(null);
      return;
    }
    const jump = pendingJumpRef.current;
    if (jump) {
      pendingJumpRef.current = null;
      readingAnchorRef.current = null;
      pinBottomRef.current = false;
      jumpToRow(jump.id, jump.focus);
      return;
    }
    const backfill = backfillRevealRef.current;
    if (backfill) {
      // The boundary entry can vanish in the same commit (expiry, delete); fall back
      // to the slice top rather than stranding a reader at scrollTop 0.
      const found = timelineEntries.findIndex((entry) => entry.id === backfill.boundaryId);
      const boundaryIndex =
        found >= 0 ? found : timelineEntries.length > backfill.count ? startIndexRef.current : -1;
      if (boundaryIndex > 0) {
        // Restore the old viewport first, then capture afresh for the exposing commit.
        if (distanceRef.current > AT_BOTTOM_PX) restoreReadingAnchor();
        captureReadingAnchor();
        const nextIndex = stepBackRows(
          timelineEntries,
          boundaryIndex,
          WINDOW_STEP,
          (entry) => entry.type === "chat" && Boolean(quarantinedIdsRef.current?.has(entry.message.id)),
        );
        const next = timelineEntries[nextIndex];
        backfillRevealRef.current = null;
        if (next) {
          setWindowStart(next.id);
          return;
        }
      } else if (!loadingOlderRef.current) {
        // Empty/duplicate/error page. The pulse in finally guarantees this render.
        backfillRevealRef.current = null;
      }
    }
    if (pinBottomRef.current) {
      pinBottomRef.current = false;
      readingAnchorRef.current = null;
      pinToBottomNow();
      return;
    }
    if (distanceRef.current > AT_BOTTOM_PX && restoreReadingAnchor()) {
      // Scrolled up near the top with no gesture coming: re-check next frame.
      // Self-limiting (no-op outside the trigger band).
      if (continueRafRef.current == null) {
        continueRafRef.current = requestAnimationFrame(() => {
          continueRafRef.current = null;
          maybeExtendRef.current();
        });
      }
      return;
    }
    stickToBottom();
    // `listVisible`: the scroller this effect moves may only just have mounted.
  }, [items, listVisible, anchorLost, timelineEntries, backfillPulse, captureReadingAnchor, setWindowStart, jumpToRow, pinToBottomNow, restoreReadingAnchor, stickToBottom]);

  // Content growth and container reflows (thread panel, composer swap) land here.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    const ro = new ResizeObserver(() => {
      if (pinBottomRef.current || pendingJumpRef.current) return;
      if (distanceRef.current > AT_BOTTOM_PX) restoreReadingAnchor();
      else stickToBottom();
    });
    ro.observe(content);
    ro.observe(el);
    return () => ro.disconnect();
  }, [listVisible, restoreReadingAnchor, stickToBottom]);

  /**
   * Near the top: reveal loaded messages, else request an older page. Only when
   * away from the bottom, so a fresh conversation doesn't walk its own history.
   */
  const maybeExtend = useCallback(() => {
    const el = scrollRef.current;
    if (!el || paused || extendLockRef.current) return;
    if (distanceRef.current <= AT_BOTTOM_PX) return;
    const start = startIndexRef.current;
    if (start > 0) {
      if (clampedScrollTop(el) >= REVEAL_TRIGGER_PX) return;
      const next = entriesRef.current[
        stepBackRows(entriesRef.current, start, WINDOW_STEP, (entry) =>
          entry.type === "chat" ? !!quarantinedIdsRef.current?.has(entry.message.id) : false,
        )
      ];
      if (!next) return;
      extendLockRef.current = true;
      captureReadingAnchor();
      setWindowStart(next.id);
      return;
    }
    if (clampedScrollTop(el) >= BACKFILL_TRIGGER_PX) return;
    if (!loadOlder || !hasMore || isLoadingOlder || loadingOlderRef.current) return;
    loadingOlderRef.current = true;
    captureReadingAnchor();
    const boundaryId = entriesRef.current[0]?.id;
    if (boundaryId) {
      backfillRevealRef.current = { boundaryId, count: entriesRef.current.length };
    }
    void loadOlder().finally(() => {
      loadingOlderRef.current = false;
      setBackfillPulse((pulse) => pulse + 1);
    });
  }, [paused, loadOlder, hasMore, isLoadingOlder, captureReadingAnchor, setWindowStart]);
  // Called via ref from the earlier-declared layout effect. Cancel on unmount.
  maybeExtendRef.current = maybeExtend;
  useEffect(
    () => () => {
      if (continueRafRef.current != null) cancelAnimationFrame(continueRafRef.current);
    },
    [],
  );

  /**
   * Extend while the slice doesn't fill the scroller (e.g. a folded flood), since
   * there's no scroll gesture to trigger it. One step per commit.
   */
  // Measured in the next frame: reading `scrollHeight` in the effect forced an
  // extra layout.
  useEffect(() => {
    if (!listVisible || paused) return;
    const frame = requestAnimationFrame(() => {
      const el = scrollRef.current;
      // Zero height (not laid out, or tests) isn't underfilled.
      if (!el || el.clientHeight === 0) return;
      if (el.scrollHeight > el.clientHeight + AT_BOTTOM_PX) return;
      if (startIndexRef.current > 0) {
        const next = entriesRef.current[
          stepBackRows(entriesRef.current, startIndexRef.current, WINDOW_STEP, (entry) =>
            entry.type === "chat" ? !!quarantinedIdsRef.current?.has(entry.message.id) : false,
          )
        ];
        if (next) {
          captureReadingAnchor();
          setWindowStart(next.id);
        }
        return;
      }
      if (!loadOlder || !hasMore || isLoadingOlder || loadingOlderRef.current) return;
      loadingOlderRef.current = true;
      captureReadingAnchor();
      void loadOlder().finally(() => {
        loadingOlderRef.current = false;
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [items, listVisible, paused, loadOlder, hasMore, isLoadingOlder, captureReadingAnchor, setWindowStart]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Only the reader moving up leaves the bottom; our own scrolls record their
    // offsets, so we don't react to ourselves.
    const top = clampedScrollTop(el);
    const movingUp = top < lastScrollTopRef.current;
    lastScrollTopRef.current = top;
    // Growth below the fold raises distance without a scroll; scroll events lag a
    // frame, so only count growth when the reader moved, or stick-to-bottom latches off.
    const distance = distanceFromBottom(el);
    if (movingUp || distance <= distanceRef.current) distanceRef.current = distance;
    setShowJumpPill(distanceRef.current > JUMP_PILL_PX);
    if (el.scrollTop === top) captureReadingAnchor();
    if (movingUp) maybeExtend();
  }, [captureReadingAnchor, maybeExtend]);

  // Rows land above a bottom-pinned reader, so nothing moves.
  useEffect(() => {
    if (rampStep >= OPENING_RAMP.length - 1 || timelineEntries.length === 0) return;
    const frame = requestAnimationFrame(() => setRampStep((step) => step + 1));
    return () => cancelAnimationFrame(frame);
  }, [rampStep, timelineEntries.length]);

  // Back at the bottom: trim to the newest (bounds a long session's DOM).
  useEffect(() => {
    if (distanceRef.current > AT_BOTTOM_PX) return;
    if (timelineEntries.length - startIndex <= TRIM_ABOVE) return;
    setWindowStart(null);
  }, [timelineEntries, startIndex, setWindowStart]);

  // Extends the window first if the target is older than it.
  const scrollToMessage = useCallback(
    (id: string, focus = false) => {
      // Entry-space indexes; callers jump by message id.
      const all = entriesRef.current;
      const index = all.findIndex((entry) => entry.type === "chat" && entry.message.id === id);
      if (index === -1) return false;
      if (index < startIndexRef.current) {
        pendingJumpRef.current = { id, focus };
        setWindowStart(all[Math.max(0, index - JUMP_CONTEXT)].id);
        return true;
      }
      jumpToRow(id, focus);
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
          {/* A running catch-up isn't "no messages" yet; persistent failure wins over
              the spinner (backoff alternates states). Empty relay reads also come here,
              so don't diagnose a connection failure. */}
          {syncFailed ? (
            <p className="flex items-center justify-center gap-2 px-2 py-8 text-center text-sm text-muted-foreground">
              <MessagesSquare className="size-4 shrink-0" aria-hidden />
              No messages loaded yet. We’ll keep checking the relays for history in the background…
            </p>
          ) : syncing ? (
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
            className="flex-1 min-h-0 overflow-y-auto overflow-x-clip overscroll-contain [overflow-anchor:none] scrollbar-stable px-3"
          >
            {/* Positioned, so every row's `offsetTop` is measured against it. */}
            <div ref={contentRef} className="relative">
              <div className="h-4" aria-hidden />
              {items.map((item) => (
                // `hover:z-10` keeps the overhanging toolbar above the previous row.
                <div
                  key={item.key}
                  data-scroll-anchor={item.key}
                  className="relative hover:z-10 focus-within:z-10"
                >
                  {item.type === "date" ? (
                    <DateSeparator ts={item.ts} />
                  ) : item.type === "unread" ? (
                    <NewMessagesDivider />
                  ) : item.type === "rotation" ? (
                    <KeyRotationDivider />
                  ) : item.type === "flood" ? (
                    <>
                      <FloodNotice
                        count={item.msgs.length}
                        authors={item.authors}
                        paused={item.paused}
                        expanded={expandedFloods.has(item.key)}
                        onToggle={() => toggleFlood(item.key)}
                      />
                      {expandedFloods.has(item.key) &&
                        item.msgs.map((msg) => (
                          <div key={msg.renderKey ?? msg.id} className="relative">
                            {renderMessage(msg, false)}
                          </div>
                        ))}
                    </>
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
          {/* Floats over the edge: resizing content at the anchored edge would jolt the view. */}
          {isLoadingOlder && (
            <div className="absolute top-1 inset-x-0 z-10 flex justify-center pointer-events-none">
              <span className="rounded-full bg-background/80 backdrop-blur p-1.5 shadow-sm">
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              </span>
            </div>
          )}
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
