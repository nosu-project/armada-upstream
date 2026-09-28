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
  } catch { /* ignore */ }
  return null;
}

/** A YouTube watch target: a single video, a playlist, or both. */
export interface YouTubeTarget {
  videoId?: string;
  /** Playlist id, when the link includes one (`list=` or `/playlist`). */
  playlistId?: string;
  /** 0-based index within the playlist, when present. */
  index?: number;
}

/**
 * Parse a YouTube URL (watch, youtu.be, embed, shorts, playlist) into a video
 * and/or playlist target. Bare video/playlist ids are accepted too.
 */
export function parseYouTubeTarget(input: string): YouTubeTarget | null {
  const raw = input.trim();
  if (!raw) return null;

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
 * Tweet id from a Twitter/X URL, including privacy front-ends (nitter,
 * fxtwitter, vxtwitter, fixupx/fixvx) that mirror `/{user}/status/{id}`.
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
  /** track, album, playlist, episode, or show. */
  type: string;
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

/** Streamable video id from `streamable.com/<id>` or `/e/<id>`. */
export function extractStreamableId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname.replace(/^www\./, "") !== "streamable.com") return null;
    const match = u.pathname.match(/^\/(?:e\/)?([a-zA-Z0-9]+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Instagram shortcode from post/reel/IGTV URLs (incl. profile-prefixed forms
 * and ddinstagram/instagramez front-ends), or null if not embeddable.
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

/**
 * Post text from a `rich` oEmbed blockquote (Bluesky and mirrors). DOMParser
 * neither runs scripts nor fetches; only the text is used, never the html.
 */
export function oembedDescription(html: string | undefined): string | undefined {
  if (!html || typeof DOMParser === "undefined") return undefined;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const text = Array.from(doc.querySelectorAll("blockquote p"))
    .map((p) => p.textContent?.trim() ?? "")
    .filter(Boolean)
    .join("\n\n");
  return text || undefined;
}
