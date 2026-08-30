/** Extract a YouTube video ID from a URL, or null if not a YouTube link. */
export function extractYouTubeId(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^(www|m)\./, "");
    if (host === "youtube.com" && u.pathname === "/watch") {
      return u.searchParams.get("v");
    }
    if (host === "youtube.com" && (u.pathname.startsWith("/embed/") || u.pathname.startsWith("/shorts/"))) {
      return u.pathname.split("/")[2] || null;
    }
    if (u.hostname === "youtu.be") {
      return u.pathname.slice(1) || null;
    }
  } catch {
    // not a valid URL
  }
  return null;
}

/** A YouTube watch target: a single video, a playlist, or both. */
export interface YouTubeTarget {
  /** Video id, when the link points at a specific video. */
  videoId?: string;
  /** Playlist id, when the link includes one (`list=` or `/playlist`). */
  playlistId?: string;
  /** 0-based index within the playlist, when present. */
  index?: number;
}

/**
 * Parse a YouTube URL into a watch target, recognising videos AND playlists.
 * Returns null if it isn't a usable YouTube link. Handles `watch?v=`,
 * `watch?v=…&list=…`, `youtu.be/…`, `/embed/…`, `/shorts/…`, and
 * `/playlist?list=…`. A bare 11-char video id or a `PL…`/`UU…`-style playlist id
 * is also accepted, so users can paste just an id.
 */
export function parseYouTubeTarget(input: string): YouTubeTarget | null {
  const raw = input.trim();
  if (!raw) return null;

  // Bare id shortcuts.
  if (/^[a-zA-Z0-9_-]{11}$/.test(raw)) return { videoId: raw };
  if (/^(PL|UU|LL|FL|RD|OL)[a-zA-Z0-9_-]{10,}$/.test(raw)) return { playlistId: raw };

  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^(www|m|music)\./, "");
  if (host !== "youtube.com" && host !== "youtu.be") return null;

  const target: YouTubeTarget = {};

  if (host === "youtu.be") {
    const id = u.pathname.slice(1);
    if (id) target.videoId = id;
  } else if (u.pathname === "/watch") {
    const v = u.searchParams.get("v");
    if (v) target.videoId = v;
  } else if (u.pathname.startsWith("/embed/") || u.pathname.startsWith("/shorts/")) {
    const id = u.pathname.split("/")[2];
    if (id) target.videoId = id;
  }

  const list = u.searchParams.get("list");
  if (list) target.playlistId = list;
  const idx = u.searchParams.get("index");
  if (idx && /^\d+$/.test(idx)) {
    // YouTube's `index` is 1-based; convert to 0-based.
    target.index = Math.max(0, parseInt(idx, 10) - 1);
  }

  return target.videoId || target.playlistId ? target : null;
}

/**
 * Extract a tweet/post ID from a Twitter or X URL, or null if not a tweet
 * link. Handles `twitter.com`, `x.com`, their `www.`/`mobile.` variants, and
 * the privacy front-ends people paste in their place (nitter, fxtwitter,
 * vxtwitter and the `fixupx`/`fixvx` domains), all of which mirror the
 * `/{user}/status/{id}` path — so a rewritten link still renders as a tweet.
 */
export function extractTweetId(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "").replace(/^mobile\./, "");
    const isTweetHost =
      host === "twitter.com" ||
      host === "x.com" ||
      host === "nitter.net" ||
      host === "fxtwitter.com" ||
      host === "fixupx.com" ||
      host === "vxtwitter.com" ||
      host === "fixvx.com";
    if (!isTweetHost) return null;
    const match = u.pathname.match(/^\/[^/]+\/status\/(\d+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/** Spotify embed info extracted from an open.spotify.com URL. */
export interface SpotifyEmbedInfo {
  /** Content type: track, album, playlist, episode, show. */
  type: string;
  /** Spotify content ID. */
  id: string;
}

/** Extract Spotify embed info from an open.spotify.com URL. */
export function extractSpotifyEmbed(url: string): SpotifyEmbedInfo | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    if (host !== "open.spotify.com") return null;
    const match = u.pathname.match(/^\/(track|album|playlist|episode|show)\/([a-zA-Z0-9]+)/);
    return match ? { type: match[1], id: match[2] } : null;
  } catch {
    return null;
  }
}

/**
 * Extract an Instagram post shortcode from an instagram.com URL, or null if it
 * isn't an embeddable post link. Handles posts (`/p/…`), reels (`/reel/…` and
 * `/reels/…`) and IGTV (`/tv/…`), including the `/<user>/p/…` and
 * `/<user>/reel/…` profile-prefixed forms, plus the `ddinstagram`/`instagramez`
 * front-ends people paste in Instagram's place — all of which resolve through
 * Instagram's own `/p/<shortcode>/embed/` page. The shortcode is base64url
 * (letters, digits, `-`, `_`).
 */
export function extractInstagramShortcode(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "").replace(/^m\./, "");
    const isInstagramHost =
      host === "instagram.com" ||
      host === "instagr.am" ||
      host === "ddinstagram.com" ||
      host === "d.ddinstagram.com" ||
      host === "instagramez.com";
    if (!isInstagramHost) return null;
    const match = u.pathname.match(/(?:^|\/)(?:p|reel|reels|tv)\/([a-zA-Z0-9_-]+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}
