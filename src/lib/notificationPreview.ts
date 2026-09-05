/**
 * How a message is presented in a notification — one implementation, shared by
 * every surface that shows one.
 *
 * There are four notifiers in this project: the Android foreground service
 * (`NotificationRelayService.java`), the Web Push service worker (`public/sw.js`),
 * the in-app notifier that runs while a web/desktop client is open
 * (`useForegroundNotifications.ts`), and Electron by way of that same in-app
 * path. Android's is the one that reads well, and its text pipeline
 * (`NotificationContent.java`, `messagePreview`, `buildMessageText`) was itself
 * a port of the web client's preview rendering. This module is that pipeline
 * back in TypeScript, so the port has a source again instead of three
 * independent copies drifting apart.
 *
 * The shape it produces mirrors Android's `MessagingStyle`, because that is
 * what makes a conversation notification legible:
 *
 *   - a room (NIP-29 channel, Concord channel) titles the notification with
 *     the ROOM and puts the sender inside the body — "Armada / #general" +
 *     "alex: shipped it";
 *   - a DM has no conversation title, so the SENDER titles it and the body is
 *     the bare message — matching `setGroupConversation(false)`.
 *
 * Everything here is pure and platform-free: no DOM, no store, no network. The
 * caller resolves names, avatars and room images (each environment has its own
 * way to) and hands them in already resolved. That is what lets the same module
 * be bundled into the service worker, where none of the app's hooks exist.
 */

// The `nostr-tools/nip19` subpath, not the `nostr-tools` barrel: this module is
// bundled into the service worker (`src/sw/`), where the barrel would drag the
// whole library into a script that loads on every push.
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
 * The small monochrome mark Android draws in the status bar (`badge`), the web
 * counterpart of `setSmallIcon(R.drawable.ic_stat_armada)`. It MUST be a
 * single-colour image on transparency: the platform discards colour and keeps
 * only the alpha channel, so a full-colour favicon here renders as a solid
 * blob.
 *
 * It is literally the same file the native build ships — a copy of
 * `drawable-xxxhdpi/ic_stat_armada.png`, which is already 96px — so a redraw
 * cannot leave the two clients showing different marks for the same
 * notification. `android/icon-src/ic_stat_armada.svg` is the source both come
 * from, and carries the Material live-area sizing rule.
 */
export const NOTIFICATION_BADGE_ICON = "/badge-96.png";

/**
 * A media URL plus any whitespace immediately before it, so stripping one out
 * of the middle of a sentence ("a <url> b") doesn't leave a double space.
 * Group 1 captures the extension so a media-only message can still be labelled
 * by kind. Mirrors `IMETA_MEDIA_URL_REGEX` and Android's `MEDIA_URL`.
 */
const MEDIA_URL = new RegExp(`\\s*https?://\\S+\\.(${ALL_MEDIA_EXTS})(?:\\?\\S*)?`, "gi");

/** A `nostr:npub…` / `nostr:nprofile…` (or bare) NIP-27 mention. */
const MENTION = /(?:nostr:)?(npub1|nprofile1)[023456789acdefghjklmnpqrstuvwxyz]+/gi;

/** Decode one `npub1…`/`nprofile1…` token to a hex pubkey, or undefined. */
function mentionPubkey(token: string): string | undefined {
  try {
    const decoded = nip19Decode(token.replace(/^nostr:/i, "").toLowerCase());
    if (decoded.type === "npub") return decoded.data;
    if (decoded.type === "nprofile") return decoded.data.pubkey;
  } catch {
    // Not a valid, checksummed reference to a person — leave the token alone.
  }
  return undefined;
}

/**
 * Every pubkey named by a NIP-27 mention in `content`.
 *
 * Resolution itself is a separate step because naming a pubkey is async in the
 * page (a store read) and sync in the worker: callers collect the keys here,
 * resolve them however their environment can, and hand {@link cleanContent} the
 * resulting map. Names are NEVER worth a network round-trip — a notification is
 * the one surface with no time to wait — so a caller that can't answer locally
 * should simply omit the entry and let the raw token stand.
 */
export function mentionPubkeys(content: string): string[] {
  const out = new Set<string>();
  for (const [token] of content.matchAll(MENTION)) {
    const pubkey = mentionPubkey(token);
    if (pubkey) out.add(pubkey);
  }
  return [...out];
}

/**
 * Strip inline media URLs and resolve mentions to `@name`.
 *
 * Media URLs the UI would render as an embed carry no textual meaning in a
 * notification, so "lol https://blossom.example/abcd.jpg" reads "lol". Non-media
 * links (an article URL) are kept verbatim. An author `names` can't name keeps
 * its raw token rather than showing a wrong one.
 */
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
 * Human label for the media a message carries — so a body left empty by
 * {@link cleanContent} can read "Sent an image" instead of "Sent a message".
 *
 * The imeta `m` MIME wins over the URL extension when given: an encrypted
 * (Concord / DM) attachment's blob URL carries no media extension at all, and a
 * voice message recorded into a `.webm`/`.mp4` container is only
 * distinguishable from video by its `audio/*` MIME.
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
 * The MIME of the first NIP-92 `imeta` attachment, when the message declares
 * one.
 *
 * Deliberately a few lines rather than a call into `imeta.ts`: this module is
 * bundled into the service worker, the label only ever needs the `m` field, and
 * an encrypted attachment's URL — the case the MIME exists to cover — is
 * exactly the one whose entry `parseImetaMap` keys by an opaque blob address.
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

/**
 * Whether a message is a reply inside a thread rather than to the room.
 *
 * Two signals, matching the Android service: a kind-1111 NIP-22 comment is
 * always one, and a Concord chat message carries the thread root in the
 * uppercase `E` tag NIP-22 pins the root with. A top-level message has neither.
 */
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
  // A `:shortcode:` custom emoji has no glyph here; the bare word reads better
  // than the colons.
  const shortcode = /^:([^:\s]+):$/.exec(raw);
  return shortcode ? shortcode[1] : raw;
}

/** What a notification needs to know about one message. */
export interface NotificationMessage {
  /** Which plane it arrived on — DMs present differently (see the header). */
  plane: "nip29" | "dm" | "c2";
  /** Message kind: NIP-29 9/1111/7, or the decrypted rumor kind (9/1111/7/14/15). */
  kind: number;
  /** Raw message content, before media stripping / mention resolution. */
  content: string;
  /** Sender's display name, already resolved. */
  authorName: string;
  /** Sender's avatar URL, already resolved. */
  authorAvatar?: string;
  /**
   * The room's display title — "Community / #channel" for Concord, the group
   * name for NIP-29. Unused for DMs, which the sender titles.
   */
  roomTitle?: string;
  /**
   * The room's image (Concord community icon, NIP-29 group picture), already
   * resolved to something an `icon` can load. Falls back to the sender's
   * avatar, which is all a DM ever has.
   */
  roomImage?: string;
  /** Whether it `p`-tags the viewer. */
  mention?: boolean;
  /** Whether it is a reaction to one of the viewer's OWN messages. */
  reaction?: boolean;
  /** Whether it is a reply inside a thread rather than to the room. */
  threadReply?: boolean;
  /** The imeta `m` MIME, when the message carries an attachment. */
  imetaMime?: string;
  /** Resolved names for the pubkeys {@link mentionPubkeys} found, if any. */
  mentionNames?: Map<string, string>;
}

/**
 * The body text for one message line, before the sender is prefixed.
 *
 * Thread replies get a Signal-style "Replied in thread: …" prefix, because the
 * notification has to make sense without the parent message beside it.
 */
export function messageLine(msg: NotificationMessage): string {
  if (msg.reaction) return `Reacted ${reactionEmoji(msg.content)} to your message`;

  const cleaned = truncate(cleanContent(msg.content, msg.mentionNames));
  let text: string;
  if (cleaned) {
    text = msg.threadReply ? `Replied in thread: ${cleaned}` : cleaned;
  } else {
    // Stripping the URLs left nothing: name the media rather than the act.
    const label = mediaLabel(msg.imetaMime, msg.content);
    if (label) text = `Sent ${label}`;
    else if (msg.kind === KIND_DM_FILE) text = "Sent a file";
    else if (msg.threadReply) text = "Replied in thread";
    else text = msg.plane === "dm" ? "Sent you a direct message" : "Sent a message";
  }

  // A mention is the reason this notification interrupted at all; say so where
  // the room, not the sender, is the title.
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
 * Title, body and icon for one message, in the MessagingStyle shape.
 *
 * `lines` lets a busy conversation read as a thread rather than showing only
 * the newest message — the closest a Web Notification gets to MessagingStyle's
 * expansion. Pass the room's recent lines (this one last); pass nothing for a
 * single-line body.
 */
export function presentNotification(
  msg: NotificationMessage,
  lines?: string[],
): PresentedNotification {
  const line = messageLine(msg);
  const isDm = msg.plane === "dm";

  // A DM's own line needs no attribution — the title is the sender. A room's
  // does, exactly as MessagingStyle attributes each line to its Person.
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
