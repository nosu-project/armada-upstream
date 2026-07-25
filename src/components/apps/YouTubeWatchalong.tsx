import { ArrowDown, ArrowUp, ListVideo, MonitorPlay, Play, Plus, SkipBack, SkipForward, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { DisplayName } from "@/components/DisplayName";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAuthor } from "@/hooks/useAuthor";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useWebxdcApi, type AppSync } from "@/hooks/useWebxdcApi";
import { useYouTubeTitle } from "@/hooks/useYouTubeTitle";
import { getDisplayName } from "@/lib/getDisplayName";
import { parseYouTubeTarget } from "@/lib/linkEmbed";
import { loadYouTubeApi, YT_STATE, type YTPlayer } from "@/lib/youtubeApi";
import { cn } from "@/lib/utils";

/** One entry in the shared watch queue. */
interface QueueItem {
  /** Stable id for this queue entry (not the video id — lets dupes coexist). */
  id: string;
  /** A single video, when the entry is a video. */
  videoId?: string;
  /** A playlist, when the entry is a whole playlist (played natively). */
  playlistId?: string;
  /** Hex pubkey of whoever added it. */
  addedBy?: string;
}

/**
 * The full shared watchalong state, broadcast as a snapshot on every change.
 * Latest `rev` wins, so anyone can edit the queue / control playback and
 * everyone converges. (A snapshot model — rather than per-action commands — is
 * what keeps a *shared ordered queue* consistent across peers.)
 */
interface WatchSnapshot {
  queue: QueueItem[];
  /** Index into `queue` of the now-playing item, or -1 when nothing's playing. */
  current: number;
  /** Whether the now-playing item should be playing. */
  playing: boolean;
  /** Playback position (seconds) of the now-playing item at time `at`. */
  time: number;
  /** Monotonic revision + wall-clock; higher `rev` wins, `at` extrapolates play position. */
  rev: number;
  at: number;
}

const EMPTY: WatchSnapshot = { queue: [], current: -1, playing: false, time: 0, rev: 0, at: 0 };

/** How far (seconds) local playback may drift before we hard-seek to resync. */
const DRIFT_TOLERANCE = 1.5;

function isSnapshot(v: unknown): v is WatchSnapshot {
  return Boolean(v && typeof v === "object" && Array.isArray((v as WatchSnapshot).queue));
}

function newId(): string {
  return crypto.randomUUID().slice(0, 8);
}

/**
 * A YouTube watchalong with a shared queue. Anyone can add videos (or a
 * playlist) by pasting a link, reorder/skip, and play/pause; the player plays
 * the queue in order and stays synchronised across everyone in the chat via the
 * {@link AppSync} coordination plane (the same plane that backs webxdc apps).
 *
 * Ads: the embedded player serves ads per-viewer and exposes no ad controls, so
 * they can't be skipped and they desync playback during breaks; the drift guard
 * resyncs everyone once the break ends.
 */
export function YouTubeWatchalong({ sync }: { sync: AppSync }) {
  const api = useWebxdcApi(sync);
  const { user } = useCurrentUser();

  const [snap, setSnap] = useState<WatchSnapshot>(EMPTY);
  const snapRef = useRef(snap);
  useEffect(() => {
    snapRef.current = snap;
  }, [snap]);

  const [ready, setReady] = useState(false);
  const [urlInput, setUrlInput] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YTPlayer | null>(null);
  const applyingRemote = useRef(false);

  const current = snap.current >= 0 ? snap.queue[snap.current] : undefined;
  const currentKey = current ? current.id : "";

  // ── Broadcast a new snapshot (and apply it locally) ──────────────────────
  const commit = useCallback(
    (next: Omit<WatchSnapshot, "rev" | "at">) => {
      const snapshot: WatchSnapshot = { ...next, rev: snapRef.current.rev + 1, at: Date.now() };
      setSnap(snapshot);
      api.sendUpdate({ payload: snapshot }, "");
    },
    [api],
  );

  // ── Apply an incoming snapshot if it's newer ─────────────────────────────
  const applySnapshot = useCallback((incoming: WatchSnapshot) => {
    if (incoming.rev <= snapRef.current.rev) return;
    setSnap(incoming);
  }, []);

  useEffect(() => {
    void api.setUpdateListener((update) => {
      if (isSnapshot(update.payload)) applySnapshot(update.payload);
    }, 0);
  }, [api, applySnapshot]);

  // Push the latest snapshot's play/seek state onto the live player.
  const syncPlayerToSnapshot = useCallback((player: YTPlayer) => {
    const s = snapRef.current;
    applyingRemote.current = true;
    try {
      const targetTime = s.playing ? s.time + Math.max(0, (Date.now() - s.at) / 1000) : s.time;
      if (Math.abs(player.getCurrentTime() - targetTime) > DRIFT_TOLERANCE) {
        player.seekTo(targetTime, true);
      }
      if (s.playing) player.playVideo();
      else player.pauseVideo();
    } finally {
      setTimeout(() => (applyingRemote.current = false), 400);
    }
  }, []);

  const advance = useCallback(() => {
    const s = snapRef.current;
    const next = s.current + 1;
    if (next < s.queue.length) commit({ ...s, current: next, playing: true, time: 0 });
    else commit({ ...s, playing: false });
  }, [commit]);

  // ── (Re)build the player when the now-playing entry changes ──────────────
  useEffect(() => {
    if (!current || !containerRef.current) return;
    let destroyed = false;
    let player: YTPlayer | null = null;
    const entry = current;

    loadYouTubeApi().then((YT) => {
      if (destroyed || !containerRef.current) return;
      player = new YT.Player(containerRef.current, {
        videoId: entry.videoId,
        host: "https://www.youtube-nocookie.com",
        playerVars: {
          autoplay: 1,
          rel: 0,
          modestbranding: 1,
          playsinline: 1,
          ...(entry.playlistId ? { listType: "playlist", list: entry.playlistId } : {}),
        },
        events: {
          onReady: (e) => {
            playerRef.current = e.target;
            setReady(true);
            syncPlayerToSnapshot(e.target);
          },
          onStateChange: (e) => {
            if (applyingRemote.current) return;
            const s = snapRef.current;
            const time = e.target.getCurrentTime();
            if (e.data === YT_STATE.PLAYING) commit({ ...s, playing: true, time });
            else if (e.data === YT_STATE.PAUSED) commit({ ...s, playing: false, time });
            else if (e.data === YT_STATE.ENDED) advance();
          },
        },
      });
    });

    return () => {
      destroyed = true;
      try {
        player?.destroy();
      } catch {
        /* ignore */
      }
      playerRef.current = null;
      setReady(false);
    };
    // Rebuild only when the now-playing *entry* changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentKey]);

  // When the snapshot's play/time changes (entry unchanged), nudge the player.
  useEffect(() => {
    if (playerRef.current && ready) syncPlayerToSnapshot(playerRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap.playing, snap.time, snap.at, ready]);

  // ── Queue mutations ──────────────────────────────────────────────────────
  const addToQueue = useCallback(() => {
    const t = parseYouTubeTarget(urlInput);
    if (!t) {
      setInputError("Paste a YouTube video or playlist link");
      return;
    }
    setInputError(null);
    setUrlInput("");
    const item: QueueItem = { id: newId(), videoId: t.videoId, playlistId: t.playlistId, addedBy: user?.pubkey };
    const s = snapRef.current;
    const queue = [...s.queue, item];
    const startNow = s.current < 0 || s.current >= s.queue.length;
    commit({
      queue,
      current: startNow ? queue.length - 1 : s.current,
      playing: startNow ? true : s.playing,
      time: startNow ? 0 : s.time,
    });
  }, [urlInput, user?.pubkey, commit]);

  const playIndex = useCallback(
    (index: number) => commit({ ...snapRef.current, current: index, playing: true, time: 0 }),
    [commit],
  );

  const skip = useCallback(
    (delta: number) => {
      const s = snapRef.current;
      const next = s.current + delta;
      if (next >= 0 && next < s.queue.length) commit({ ...s, current: next, playing: true, time: 0 });
    },
    [commit],
  );

  const move = useCallback(
    (index: number, delta: number) => {
      const s = snapRef.current;
      const to = index + delta;
      if (to < 0 || to >= s.queue.length) return;
      const queue = [...s.queue];
      [queue[index], queue[to]] = [queue[to], queue[index]];
      // Keep `current` pointing at the same now-playing entry after the swap.
      let curr = s.current;
      if (s.current === index) curr = to;
      else if (s.current === to) curr = index;
      commit({ ...s, queue, current: curr });
    },
    [commit],
  );

  const removeIndex = useCallback(
    (index: number) => {
      const s = snapRef.current;
      const queue = s.queue.filter((_, i) => i !== index);
      let curr = s.current;
      if (index < s.current) curr = s.current - 1;
      else if (index === s.current) curr = Math.min(s.current, queue.length - 1);
      commit({ ...s, queue, current: queue.length ? curr : -1, playing: queue.length ? s.playing : false });
    },
    [commit],
  );

  const hasQueue = snap.queue.length > 0;
  const canPrev = snap.current > 0;
  const canNext = snap.current >= 0 && snap.current < snap.queue.length - 1;

  return (
    <div className="flex flex-col gap-3">
      {/* Add-to-queue bar — link only (no in-app search). */}
      <div>
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <MonitorPlay className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-[#ff0000] pointer-events-none" />
            <Input
              value={urlInput}
              onChange={(e) => {
                setUrlInput(e.target.value);
                setInputError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") addToQueue();
              }}
              inputMode="url"
              placeholder="Paste a YouTube link to add to the queue…"
              aria-label="YouTube video or playlist link"
              className={cn("h-9 pl-8 text-sm", inputError && "border-destructive focus-visible:border-destructive")}
            />
          </div>
          <Button size="sm" className="h-9" onClick={addToQueue} disabled={!urlInput.trim()}>
            <Plus className="size-4" />
            Add
          </Button>
        </div>
        {inputError && <p className="mt-1 px-1 text-xs text-destructive">{inputError}</p>}
      </div>

      {/* Player. Capped to ~45vh so the queue below stays on-screen (the stage
          isn't scrollable; an unbounded 16:9 box would push the queue off). */}
      {current ? (
        <div className="mx-auto w-full max-h-[45vh] aspect-video overflow-hidden clip-corner-lg bg-black relative">
          <div ref={containerRef} className="absolute inset-0 w-full h-full" />
          {!ready && (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-white/70">
              Loading player…
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center gap-2 clip-corner-lg bg-secondary/40 py-10 text-center">
          <MonitorPlay className="size-7 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Paste a YouTube link above to start the queue.</p>
        </div>
      )}

      {/* Transport: prev / next across the queue. */}
      {hasQueue && (
        <div className="flex items-center justify-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-8 text-muted-foreground"
                aria-label="Previous"
                disabled={!canPrev}
                onClick={() => skip(-1)}
              >
                <SkipBack className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Previous</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-8 text-muted-foreground"
                aria-label="Next"
                disabled={!canNext}
                onClick={() => skip(1)}
              >
                <SkipForward className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Next</TooltipContent>
          </Tooltip>
        </div>
      )}

      {/* Queue */}
      {hasQueue && (
        <div className="clip-corner-lg bg-chrome p-1.5">
          <div className="flex items-center gap-1.5 px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/80">
            <ListVideo className="size-3.5" />
            Up next · {snap.queue.length}
          </div>
          <div className="flex flex-col gap-0.5 max-h-56 overflow-y-auto">
            {snap.queue.map((item, i) => (
              <QueueRow
                key={item.id}
                item={item}
                isCurrent={i === snap.current}
                canUp={i > 0}
                canDown={i < snap.queue.length - 1}
                onPlay={() => playIndex(i)}
                onUp={() => move(i, -1)}
                onDown={() => move(i, 1)}
                onRemove={() => removeIndex(i)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** One row in the queue: thumbnail/title (resolved via keyless oEmbed) + controls. */
function QueueRow({
  item,
  isCurrent,
  canUp,
  canDown,
  onPlay,
  onUp,
  onDown,
  onRemove,
}: {
  item: QueueItem;
  isCurrent: boolean;
  canUp: boolean;
  canDown: boolean;
  onPlay: () => void;
  onUp: () => void;
  onDown: () => void;
  onRemove: () => void;
}) {
  const { data: meta } = useYouTubeTitle(item.videoId);
  const author = useAuthor(item.addedBy);
  const adderName = item.addedBy ? getDisplayName(author.data?.metadata, item.addedBy) : undefined;

  const title = item.playlistId
    ? "Playlist"
    : meta?.title ?? (item.videoId ? `youtu.be/${item.videoId}` : "Video");

  return (
    <div
      className={cn(
        "group/row flex items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors",
        isCurrent ? "bg-primary/10" : "hover:bg-secondary/60",
      )}
    >
      <button type="button" onClick={onPlay} className="flex items-center gap-2.5 min-w-0 flex-1 text-left" aria-label={`Play ${title}`}>
        <div className="relative flex h-9 w-14 shrink-0 items-center justify-center overflow-hidden rounded-sm bg-black/80">
          {item.playlistId ? (
            <ListVideo className="size-4 text-white/80" />
          ) : meta?.thumbnail ? (
            <img src={meta.thumbnail} alt="" className="h-full w-full object-cover" />
          ) : (
            <MonitorPlay className="size-4 text-white/80" />
          )}
          {isCurrent && (
            <span className="absolute inset-0 flex items-center justify-center bg-black/40">
              <Play className="size-3.5 fill-white text-white" />
            </span>
          )}
        </div>
        <div className="min-w-0">
          <p className={cn("truncate text-[12px]", isCurrent ? "font-semibold text-foreground" : "font-medium")}>{title}</p>
          <p className="truncate text-[11px] text-muted-foreground">
            {isCurrent ? (
              "Now playing"
            ) : adderName ? (
              <>Added by <DisplayName pubkey={item.addedBy} name={adderName} /></>
            ) : (
              meta?.author ?? ""
            )}
          </p>
        </div>
      </button>
      <div className="flex shrink-0 items-center opacity-0 group-hover/row:opacity-100 touch:opacity-100 focus-within:opacity-100 transition-opacity">
        <Button variant="ghost" size="icon" className="size-6 text-muted-foreground" aria-label="Move up" disabled={!canUp} onClick={onUp}>
          <ArrowUp className="size-3.5" />
        </Button>
        <Button variant="ghost" size="icon" className="size-6 text-muted-foreground" aria-label="Move down" disabled={!canDown} onClick={onDown}>
          <ArrowDown className="size-3.5" />
        </Button>
        <Button variant="ghost" size="icon" className="size-6 text-muted-foreground hover:text-destructive" aria-label="Remove from queue" onClick={onRemove}>
          <Trash2 className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}
