import { parseYouTubeTarget } from "@/lib/linkEmbed";
import { isLocalNetworkUrl } from "@/lib/sanitizeUrl";

/**
 * "Watch together" shared state and rules.
 *
 * WIRE FORMAT: {@link WatchSnapshot} is broadcast verbatim over {@link AppSync}
 * to every build, including older ones — the shape may only GROW with optional
 * fields (`QueueItem.url`, `rate`; old builds ignore and preserve them). The
 * app kind stays `{ type: "youtube" }` since the session id derives from it.
 */

/** One entry in the shared watch queue. */
export interface QueueItem {
  /** Stable id for this queue entry (not the video id — lets dupes coexist). */
  id: string;
  /** A single YouTube video, when the entry is one. */
  videoId?: string;
  /** A YouTube playlist, when the entry is a whole playlist (played natively). */
  playlistId?: string;
  /**
   * A direct http(s) video file. Sender-named, so re-validated on receipt
   * ({@link queueItemPlayer}) and only loaded through the media policy.
   */
  url?: string;
  /** Hex pubkey of whoever added it. */
  addedBy?: string;
}

/** Shared state, broadcast as a whole snapshot per change; highest `rev` wins. */
export interface WatchSnapshot {
  queue: QueueItem[];
  /** Index into `queue` of the now-playing item, or -1 when nothing's playing. */
  current: number;
  /** Whether the now-playing item should be playing. */
  playing: boolean;
  /** Playback position (seconds) of the now-playing item at time `at`. */
  time: number;
  /** Direct-video speed (absent = 1); YouTube ignores it. */
  rate?: number;
  /** Monotonic revision + wall-clock; higher `rev` wins, `at` extrapolates play position. */
  rev: number;
  at: number;
}

export const EMPTY_SNAPSHOT: WatchSnapshot = { queue: [], current: -1, playing: false, time: 0, rev: 0, at: 0 };

/** How far (seconds) local playback may drift before we hard-seek to resync. */
export const DRIFT_TOLERANCE = 1.5;

/** The speeds a `<video>` is allowed to be driven at; anything else reads as 1. */
const MIN_RATE = 0.25;
const MAX_RATE = 4;

/**
 * Whether a peer payload is applicable. Numbers must be finite: `1e400` parses
 * to Infinity, which `<video>` rejects and which as `rev` would freeze the room.
 */
export function isSnapshot(v: unknown): v is WatchSnapshot {
  if (!v || typeof v !== "object") return false;
  const s = v as Partial<WatchSnapshot>;
  return Array.isArray(s.queue)
    && s.queue.every((item) => Boolean(item) && typeof item === "object" && typeof item.id === "string")
    && Number.isInteger(s.current)
    && typeof s.playing === "boolean"
    && Number.isFinite(s.time)
    && Number.isFinite(s.rev)
    && Number.isFinite(s.at)
    && (s.rate === undefined || Number.isFinite(s.rate));
}

/** The snapshot's playback speed, clamped to what a `<video>` accepts. */
export function snapshotRate(s: Pick<WatchSnapshot, "rate">): number {
  const r = s.rate;
  return typeof r === "number" && Number.isFinite(r) && r >= MIN_RATE && r <= MAX_RATE ? r : 1;
}

/** Where playback should be at `now`: `time` plus elapsed wall-clock × `rate` while playing. */
export function targetPlaybackTime(s: WatchSnapshot, now: number, rate = 1): number {
  return s.playing ? s.time + Math.max(0, (now - s.at) / 1000) * rate : s.time;
}

/** Container extensions a `<video>` element plays in every engine we ship on. */
const DIRECT_VIDEO_EXT = /\.(mp4|m4v|webm|mov|ogv|mkv)$/i;
/** A Blossom blob path (`/<sha256>` with an optional extension). */
const BLOSSOM_PATH = /^\/[0-9a-f]{64}(\.[a-z0-9]+)?$/i;
/** HLS playlists — no HLS player ships in this client (see `useVideoThumbnail`). */
const HLS_EXT = /\.m3u8?$/i;

export type WatchLink =
  | { kind: "youtube"; videoId?: string; playlistId?: string }
  | { kind: "video"; url: string }
  | { kind: "invalid"; reason: string };

const NOT_A_VIDEO = "Paste a YouTube link or a direct link to a video file (.mp4, .webm, …)";

/** Classify a pasted link: YouTube embed, direct `<video>` (by extension or Blossom path), or invalid. */
export function classifyWatchLink(input: string): WatchLink {
  const yt = parseYouTubeTarget(input);
  if (yt) return { kind: "youtube", videoId: yt.videoId, playlistId: yt.playlistId };

  const raw = input.trim();
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { kind: "invalid", reason: NOT_A_VIDEO };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { kind: "invalid", reason: NOT_A_VIDEO };
  // The media policy won't load these either; refuse up front.
  if (isLocalNetworkUrl(u.href)) return { kind: "invalid", reason: "Local network links can't be shared" };
  if (HLS_EXT.test(u.pathname)) return { kind: "invalid", reason: "Live streams (.m3u8) aren't supported" };
  if (DIRECT_VIDEO_EXT.test(u.pathname) || BLOSSOM_PATH.test(u.pathname)) return { kind: "video", url: u.href };
  return { kind: "invalid", reason: NOT_A_VIDEO };
}

/**
 * Which player a (possibly peer-sent) entry uses, or `null` if none here.
 * YouTube wins when both are present, matching YouTube-only builds.
 */
export function queueItemPlayer(item: QueueItem | undefined): "youtube" | "video" | null {
  if (!item) return null;
  if (item.videoId || item.playlistId) return "youtube";
  if (typeof item.url === "string" && classifyWatchLink(item.url).kind === "video") return "video";
  return null;
}

/** A short title for a direct-video entry: its file name, else its host. */
export function directVideoTitle(url: string): string {
  try {
    const u = new URL(url);
    const file = decodeURIComponent(u.pathname.split("/").pop() ?? "");
    if (file && !BLOSSOM_PATH.test(`/${file}`)) return file;
    return u.hostname;
  } catch {
    return "Video";
  }
}

/** The subset of `HTMLVideoElement` the sync drives — mockable in tests. */
export type SyncableVideo = Pick<HTMLVideoElement, "currentTime" | "paused" | "playbackRate" | "play" | "pause">;

/** Whether a `<video>` already matches the snapshot (so its event is an echo, not a change). */
export function videoMatchesSnapshot(
  video: Pick<SyncableVideo, "currentTime" | "paused" | "playbackRate">,
  s: WatchSnapshot,
  now: number,
): boolean {
  const rate = snapshotRate(s);
  return video.paused === !s.playing
    && video.playbackRate === rate
    && Math.abs(video.currentTime - targetPlaybackTime(s, now, rate)) <= DRIFT_TOLERANCE;
}

/**
 * Push a snapshot's rate/seek/play state onto a `<video>`. Returns the `play()`
 * promise so callers can see autoplay refusals.
 */
export function applySnapshotToVideo(
  video: SyncableVideo,
  s: WatchSnapshot,
  now: number,
): Promise<void> | undefined {
  const rate = snapshotRate(s);
  if (video.playbackRate !== rate) video.playbackRate = rate;
  const target = targetPlaybackTime(s, now, rate);
  if (Math.abs(video.currentTime - target) > DRIFT_TOLERANCE) video.currentTime = target;
  if (s.playing) return video.paused ? video.play() : undefined;
  if (!video.paused) video.pause();
  return undefined;
}
