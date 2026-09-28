/**
 * Notification presentation shared by every notifier (the service worker, the
 * in-app notifier, Electron); a TypeScript port of Android's `NotificationContent.java`.
 * Mirrors MessagingStyle: rooms are titled by the room with "sender: text"
 * bodies; DMs are titled by the sender. Pure and platform-free, so it can be
 * bundled into the service worker; callers pass names/images already resolved.
 */

// `nostr-tools/nip19` subpath, not the barrel: this is bundled into the service worker.
import { decode as nip19Decode } from "nostr-tools/nip19";

import { ALL_MEDIA_EXTS } from "@/lib/mediaUrls";
import { isWebxdcMime } from "@/lib/webxdcMime";

/** NIP-17 file message — its content is a URL, not prose. */
const KIND_DM_FILE = 15;

/** Longest body we show before eliding, matching `CONTENT_CAP` on Android. */
export const NOTIFICATION_CONTENT_CAP = 140;

/** The notification icon shown when nothing better resolved. */
export const NOTIFICATION_FALLBACK_ICON = "/favicon.png";

/**
 * Monochrome status-bar mark (`badge`); must be single-colour on transparency
 * (only alpha is used). Same file as Android's `drawable-xxxhdpi/ic_stat_armada.png`;
 * source: `android/icon-src/ic_stat_armada.svg`.
 */
export const NOTIFICATION_BADGE_ICON = "/badge-96.png";

/**
 * A media URL plus preceding whitespace (so stripping leaves no double space).
 * Group 1 captures the extension. Mirrors `IMETA_MEDIA_URL_REGEX` and Android's `MEDIA_URL`.
 */
const MEDIA_URL = new RegExp(`\\s*https?://\\S+\\.(${ALL_MEDIA_EXTS})(?:\\?\\S*)?`, "gi");

/** A `nostr:npub…` / `nostr:nprofile…` (or bare) NIP-27 mention. */
const MENTION = /(?:nostr:)?(npub1|nprofile1)[023456789acdefghjklmnpqrstuvwxyz]+/gi;

function mentionPubkey(token: string): string | undefined {
  try {
    const decoded = nip19Decode(token.replace(/^nostr:/i, "").toLowerCase());
    if (decoded.type === "npub") return decoded.data;
    if (decoded.type === "nprofile") return decoded.data.pubkey;
  } catch { /* ignore */ }
  return undefined;
}

/**
 * Pubkeys named by NIP-27 mentions. Resolve them locally (never over the
 * network) and pass the map to {@link cleanContent}; unresolved ones keep the raw token.
 */
export function mentionPubkeys(content: string): string[] {
  const out = new Set<string>();
  for (const [token] of content.matchAll(MENTION)) {
    const pubkey = mentionPubkey(token);
    if (pubkey) out.add(pubkey);
  }
  return [...out];
}

/** Strip embeddable media URLs and resolve mentions to `@name` (unknown names keep the raw token). */
export function cleanContent(content: string, names?: Map<string, string>): string {
  if (!content) return "";
  return content
    .replace(MEDIA_URL, "")
    .replace(MENTION, (token) => {
      const pubkey = mentionPubkey(token);
      const name = pubkey && names?.get(pubkey);
      return name ? `@${name}` : token;
    })
    .trim();
}

/**
 * Label for attached media ("Sent an image"). The imeta MIME beats the URL
 * extension: encrypted blob URLs have none, and voice notes in .webm/.mp4 are
 * only distinguishable by `audio/*`.
 */
export function mediaLabel(imetaMime: string | undefined, content: string): string | undefined {
  const byMime = labelForMime(imetaMime);
  if (byMime) return byMime;
  if (!content) return undefined;
  const match = new RegExp(MEDIA_URL.source, "i").exec(content);
  return match ? labelForExt(match[1].toLowerCase()) : undefined;
}

function labelForMime(mime: string | undefined): string | undefined {
  if (!mime) return undefined;
  const m = mime.toLowerCase();
  if (m === "image/gif") return "a GIF";
  if (m.startsWith("image/")) return "an image";
  if (m.startsWith("video/")) return "a video";
  if (m.startsWith("audio/")) return "a voice message";
  if (isWebxdcMime(m)) return "a game";
  return undefined;
}

function labelForExt(ext: string): string | undefined {
  if (ext === "gif") return "a GIF";
  if (ext === "xdc") return "a game";
  return labelForMime(mimeForMediaExt(ext));
}

/** Coarse MIME for a media extension — enough to pick a label. */
function mimeForMediaExt(ext: string): string | undefined {
  if (/^(jpg|jpeg|png|gif|webp|svg|avif)$/.test(ext)) return "image/";
  if (/^(mp4|webm|mov|qt|avi|mkv|flv)$/.test(ext)) return "video/";
  if (/^(mp3|mpga|wav|ogg|oga|flac|m4a|aac|opus|weba)$/.test(ext)) return "audio/";
  return undefined;
}

/**
 * MIME of the first NIP-92 `imeta`. Not via `imeta.ts`: this is bundled into the
 * service worker and only needs `m`.
 */
export function firstImetaMime(tags: string[][]): string | undefined {
  for (const tag of tags) {
    if (tag[0] !== "imeta") continue;
    for (let i = 1; i < tag.length; i++) {
      if (tag[i].startsWith("m ")) return tag[i].slice(2).trim() || undefined;
    }
  }
  return undefined;
}

/** Thread reply (matching Android): kind-1111 NIP-22 comment, or an uppercase `E` root tag (Concord). */
export function isThreadReply(kind: number, tags: string[][]): boolean {
  if (kind === 1111) return true;
  return tags.some((tag) => tag[0] === "E" && typeof tag[1] === "string" && tag[1] !== "");
}

/** Elide to {@link NOTIFICATION_CONTENT_CAP}, matching `sw.js`'s truncate. */
export function truncate(text: string, max = NOTIFICATION_CONTENT_CAP): string {
  if (typeof text !== "string") return "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Normalize a kind-7 reaction's content to the emoji a body can show. */
export function reactionEmoji(content: string | undefined): string {
  const raw = (content ?? "").trim();
  if (raw === "" || raw === "+") return "👍";
  if (raw === "-") return "👎";
  // A `:shortcode:` has no glyph here; show the bare word.
  const shortcode = /^:([^:\s]+):$/.exec(raw);
  return shortcode ? shortcode[1] : raw;
}

/** What a notification needs to know about one message. */
export interface NotificationMessage {
  plane: "nip29" | "dm" | "c2";
  /** NIP-29 9/1111/7, or the decrypted rumor kind (9/1111/7/14/15). */
  kind: number;
  content: string;
  authorName: string;
  authorAvatar?: string;
  /** "Community / #channel" (Concord) or group name (NIP-29). Unused for DMs. */
  roomTitle?: string;
  /** Room image (Concord icon, NIP-29 picture), already loadable. Falls back to the sender's avatar. */
  roomImage?: string;
  mention?: boolean;
  /** A reaction to one of the viewer's OWN messages. */
  reaction?: boolean;
  threadReply?: boolean;
  imetaMime?: string;
  mentionNames?: Map<string, string>;
}

/** Body text for one message; thread replies get Signal-style "Replied in thread: …". */
export function messageLine(msg: NotificationMessage): string {
  if (msg.reaction) return `Reacted ${reactionEmoji(msg.content)} to your message`;

  const cleaned = truncate(cleanContent(msg.content, msg.mentionNames));
  let text: string;
  if (cleaned) {
    text = msg.threadReply ? `Replied in thread: ${cleaned}` : cleaned;
  } else {
    const label = mediaLabel(msg.imetaMime, msg.content);
    if (label) text = `Sent ${label}`;
    else if (msg.kind === KIND_DM_FILE) text = "Sent a file";
    else if (msg.threadReply) text = "Replied in thread";
    else text = msg.plane === "dm" ? "Sent you a direct message" : "Sent a message";
  }

  // Where the room is the title, flag the mention in the body.
  return msg.mention && msg.plane !== "dm" ? `@you ${text}` : text;
}

/** A notification's presentation, ready to hand to the platform. */
export interface PresentedNotification {
  title: string;
  body: string;
  icon: string;
  badge: string;
}

/**
 * Title, body and icon for one message, MessagingStyle-shaped. `lines` are the
 * room's recent lines (this one last) so busy rooms read as a thread.
 */
export function presentNotification(
  msg: NotificationMessage,
  lines?: string[],
): PresentedNotification {
  const line = messageLine(msg);
  const isDm = msg.plane === "dm";

  // Room lines are attributed to their sender; DM lines aren't (the title is the sender).
  const attributed = isDm ? line : `${msg.authorName}: ${line}`;
  const body = lines && lines.length > 0 ? lines.join("\n") : attributed;

  return {
    title: isDm ? msg.authorName : (msg.roomTitle || "Chat"),
    body,
    icon: (isDm ? msg.authorAvatar : msg.roomImage || msg.authorAvatar)
      || NOTIFICATION_FALLBACK_ICON,
    badge: NOTIFICATION_BADGE_ICON,
  };
}

/** The line {@link presentNotification} would append for `msg`. */
export function attributedLine(msg: NotificationMessage): string {
  const line = messageLine(msg);
  return msg.plane === "dm" ? line : `${msg.authorName}: ${line}`;
}
