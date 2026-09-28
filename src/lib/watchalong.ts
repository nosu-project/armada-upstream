import { parseYouTubeTarget } from "@/lib/linkEmbed";
import { isLocalNetworkUrl } from "@/lib/sanitizeUrl";

/**
 * The "Watch together" app's shared state and the pure rules around it.
 *
 * WIRE FORMAT. A {@link WatchSnapshot} is broadcast verbatim over the app's
 * {@link AppSync} coordination plane, and every Armada build in the channel
 * reads it — including builds that predate direct-video support. So the shape
 * only ever GROWS, with optional fields:
 *
 * - `QueueItem.url` (a direct video file) was added beside `videoId` /
 *   `playlistId`. An older build sees an entry with neither id: it titles the
 *   row "Video" and hands the YouTube embed no id, which renders an empty
 *   player and emits no state changes — nothing throws, and its own edits
 *   spread the entry back unchanged.
 * - `WatchSnapshot.rate` (playback speed) is read only by the direct-video
 *   player; an older build ignores it and preserves it when it re-broadcasts,
 *   since every commit spreads the previous snapshot.
 *
 * The app kind stays `{ type: "youtube" }` for the same reason: the session id
 * is derived from it (`defaultSessionId`), so renaming it would split a
 * channel's watchalong between old and new builds.
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
   * A direct video file (http/https), when the entry is not YouTube. Added
   * after the YouTube-only format; see the module comment for how older builds
   * treat it. Sender-named, so it is re-validated on receipt
   * ({@link queueItemPlayer}) and only ever loaded through the media policy.
   */
  url?: string;
  /** Hex pubkey of whoever added it. */
  addedBy?: string;
}

/**
 * The full shared watchalong state, broadcast as a snapshot on every change.
 * Latest `rev` wins, so anyone can edit the queue / control playback and
 * everyone converges. (A snapshot model — rather than per-action commands — is
 * what keeps a *shared ordered queue* consistent across peers.)
 */
export interface WatchSnapshot {
  queue: QueueItem[];
  /** Index into `queue` of the now-playing item, or -1 when nothing's playing. */
  current: number;
  /** Whether the now-playing item should be playing. */
  playing: boolean;
  /** Playback position (seconds) of the now-playing item at time `at`. */
  time: number;
  /**
   * Playback speed for direct-video entries; absent means 1. YouTube entries
   * ignore it (the embed's speed menu stays per-viewer, as it always was).
   */
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
 * Whether a peer's payload is a snapshot this build can apply. Every number is
 * required to be finite: `JSON.parse` turns `1e400` into `Infinity`, which a
 * `<video>` refuses as a `currentTime` (it throws) and which, as a `rev`, would
 * outrank every later edit and freeze the room.
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

/**
 * Where the now-playing item should be at `now`: the committed `time`, plus the
 * wall-clock elapsed since it was committed (scaled by `rate`) while playing.
 */
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

/**
 * Classify a pasted link. YouTube links (and bare ids) keep the YouTube embed
 * path; an http(s) link to a video file (by extension, or a Blossom blob) plays
 * in a `<video>`. Everything else is refused with a reason for the input.
 */
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
  // Never loaded by the media policy either; refuse up front rather than queue
  // an entry nobody in the room can play.
  if (isLocalNetworkUrl(u.href)) return { kind: "invalid", reason: "Local network links can't be shared" };
  if (HLS_EXT.test(u.pathname)) return { kind: "invalid", reason: "Live streams (.m3u8) aren't supported" };
  if (DIRECT_VIDEO_EXT.test(u.pathname) || BLOSSOM_PATH.test(u.pathname)) return { kind: "video", url: u.href };
  return { kind: "invalid", reason: NOT_A_VIDEO };
}

/**
 * Which player a (possibly peer-sent) queue entry plays in, or `null` when this
 * build has none for it — an entry from a newer build, or a `url` that fails
 * the same checks a pasted link does. YouTube wins when both are present, so an
 * entry means the same thing here as on a build that only knows YouTube.
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

/**
 * Whether a `<video>` already shows what the snapshot says — same play state,
 * same speed, position within {@link DRIFT_TOLERANCE}. An element event in that
 * state is an echo of an applied snapshot (a slow `seeked`, say), not a change
 * worth broadcasting.
 */
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
 * Push a snapshot's play/seek/rate state onto a `<video>`: set the speed, seek
 * only past {@link DRIFT_TOLERANCE}, then play or pause. Returns the `play()`
 * promise when playback was requested, so the caller can see an autoplay
 * refusal (a browser won't start sound without a gesture on this page).
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
