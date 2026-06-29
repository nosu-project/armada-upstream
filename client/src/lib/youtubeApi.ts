/**
 * Minimal loader + typing shim for the YouTube IFrame Player API.
 * https://developers.google.com/youtube/iframe_api_reference
 *
 * The watchalong app uses this for programmatic play/pause/seek so playback can
 * be synchronised across participants. We load the API script once and resolve
 * when `window.YT.Player` is available.
 */

export interface YTPlayer {
  playVideo: () => void;
  pauseVideo: () => void;
  seekTo: (seconds: number, allowSeekAhead: boolean) => void;
  loadVideoById: (videoId: string, startSeconds?: number) => void;
  cueVideoById: (videoId: string, startSeconds?: number) => void;
  loadPlaylist: (opts: { list: string; listType?: string; index?: number; startSeconds?: number }) => void;
  cuePlaylist: (opts: { list: string; listType?: string; index?: number; startSeconds?: number }) => void;
  getCurrentTime: () => number;
  getPlayerState: () => number;
  getDuration: () => number;
  getPlaylistIndex: () => number;
  destroy: () => void;
}

/** YT.PlayerState enum values. */
export const YT_STATE = {
  UNSTARTED: -1,
  ENDED: 0,
  PLAYING: 1,
  PAUSED: 2,
  BUFFERING: 3,
  CUED: 5,
} as const;

interface YTNamespace {
  Player: new (
    el: HTMLElement | string,
    opts: {
      videoId?: string;
      host?: string;
      playerVars?: Record<string, unknown>;
      events?: {
        onReady?: (e: { target: YTPlayer }) => void;
        onStateChange?: (e: { data: number; target: YTPlayer }) => void;
      };
    },
  ) => YTPlayer;
}

declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let apiPromise: Promise<YTNamespace> | null = null;

/** Load the YouTube IFrame Player API (once) and resolve with `window.YT`. */
export function loadYouTubeApi(): Promise<YTNamespace> {
  if (apiPromise) return apiPromise;

  apiPromise = new Promise<YTNamespace>((resolve) => {
    if (window.YT && window.YT.Player) {
      resolve(window.YT);
      return;
    }
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      if (window.YT) resolve(window.YT);
    };
    if (!document.querySelector('script[src="https://www.youtube.com/iframe_api"]')) {
      const tag = document.createElement("script");
      tag.src = "https://www.youtube.com/iframe_api";
      document.head.appendChild(tag);
    }
  });

  return apiPromise;
}
