import { Capacitor, registerPlugin } from "@capacitor/core";

/** iOS-only bridge to the referrer-bearing native YouTube player. */
interface ArmadaYouTubePlugin {
  open(options: NativeYouTubeTarget): Promise<void>;
}

export interface NativeYouTubeTarget {
  videoId?: string;
  playlistId?: string;
  startSeconds?: number;
  autoplay?: boolean;
}

const ArmadaYouTube = registerPlugin<ArmadaYouTubePlugin>("ArmadaYouTube");
const MAX_YOUTUBE_START_SECONDS = 2_147_483_647;

/**
 * Whether this binary can present YouTube without error 153.
 *
 * This is intentionally iOS-specific. Its main WebView uses the fixed
 * `capacitor://localhost` origin, whose nested iframe cannot supply YouTube's
 * required HTTP Referer. Android's `https://localhost` WebView instead sends
 * a normal HTTPS Referer under the shared iframe policy; supported GMS
 * WebViews additionally supply an attested app identity through WebView Media
 * Integrity. Web and desktop each use their own request path and must retain
 * their real origin.
 */
export function hasNativeYouTubePlayer(): boolean {
  return Capacitor.getPlatform() === "ios" && Capacitor.isPluginAvailable("ArmadaYouTube");
}

/** Whether an inline web iframe would have iOS's non-HTTP parent origin. */
export function needsNativeYouTubePlayer(): boolean {
  return Capacitor.getPlatform() === "ios";
}

/**
 * Last-resort path for an older iOS binary that predates the native player.
 *
 * Keep this synchronous when called from a click so WebKit retains the user's
 * activation. Capacitor hands the new browsing context to the system browser;
 * ordinary web/desktop call sites never reach this fallback.
 */
export function openYouTubeWatchPage(videoId: string): boolean {
  return openYouTubeTargetPage({ videoId });
}

/** Open a validated video/playlist in the user's ordinary YouTube client. */
export function openYouTubeTargetPage(target: NativeYouTubeTarget): boolean {
  if (typeof window === "undefined") return false;
  if (target.videoId !== undefined && !/^[A-Za-z0-9_-]{11}$/.test(target.videoId)) return false;
  if (target.playlistId !== undefined && !/^[A-Za-z0-9_-]{10,100}$/.test(target.playlistId)) {
    return false;
  }
  if (!target.videoId && !target.playlistId) return false;

  const url = new URL(target.videoId ? "https://www.youtube.com/watch" : "https://www.youtube.com/playlist");
  if (target.videoId) url.searchParams.set("v", target.videoId);
  if (target.playlistId) url.searchParams.set("list", target.playlistId);
  if (Number.isFinite(target.startSeconds) && (target.startSeconds ?? 0) >= 1) {
    const seconds = Math.min(Math.floor(target.startSeconds ?? 0), MAX_YOUTUBE_START_SECONDS);
    url.searchParams.set("t", `${seconds}s`);
  }
  window.open(url.toString(), "_blank", "noopener,noreferrer");
  return true;
}

/**
 * Present one video in iOS's native-owned WKWebView.
 *
 * Returns false instead of throwing when the bridge is unavailable (including
 * an older app binary) so the caller can offer its ordinary external link.
 */
export async function openNativeYouTubeVideo(videoId: string): Promise<boolean> {
  return openNativeYouTube({ videoId });
}

/** Present a video or playlist at the shared playback position on iOS. */
export async function openNativeYouTube(target: NativeYouTubeTarget): Promise<boolean> {
  if (!hasNativeYouTubePlayer()) return false;
  if (target.videoId !== undefined && !/^[A-Za-z0-9_-]{11}$/.test(target.videoId)) return false;
  if (target.playlistId !== undefined && !/^[A-Za-z0-9_-]{10,100}$/.test(target.playlistId)) {
    return false;
  }
  if (!target.videoId && !target.playlistId) return false;
  const startSeconds = Number.isFinite(target.startSeconds)
    ? Math.min(Math.max(0, target.startSeconds ?? 0), MAX_YOUTUBE_START_SECONDS)
    : undefined;
  try {
    await ArmadaYouTube.open({ ...target, startSeconds });
    return true;
  } catch {
    return false;
  }
}
