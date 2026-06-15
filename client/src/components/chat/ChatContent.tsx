import { nip19 } from "nostr-tools";
import { useCallback, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { AudioMessage } from "@/components/chat/AudioMessage";
import { emojify } from "@/components/chat/CustomEmoji";
import { EmbeddedNaddr, EmbeddedNote } from "@/components/chat/EmbeddedNote";
import { Lightbox } from "@/components/chat/Lightbox";
import { LinkEmbed } from "@/components/chat/LinkEmbed";
import { VideoPlayer } from "@/components/chat/VideoPlayer";
import { useAuthor } from "@/hooks/useAuthor";
import { useCustomEmojis } from "@/hooks/useCustomEmojis";
import { buildEmojiMap } from "@/lib/customEmoji";
import { getDisplayName } from "@/lib/getDisplayName";
import { HASHTAG_PATTERN } from "@/lib/hashtag";
import { parseImetaMap } from "@/lib/imeta";
import { EMBED_MEDIA_URL_REGEX, IMAGE_URL_REGEX } from "@/lib/mediaUrls";
import { relayToRouteParam } from "@/lib/platform";
import { sanitizeUrl } from "@/lib/sanitizeUrl";
import { cn } from "@/lib/utils";

import type { AddrCoords } from "@/hooks/useEvent";
import type { NostrEvent } from "@nostrify/nostrify";

interface ChatContentProps {
  event: NostrEvent;
  className?: string;
  /** When true, nested nostr:nevent/note/naddr embeds render as inline links
   *  instead of cards. Used inside embedded cards to prevent recursion. */
  disableNoteEmbeds?: boolean;
}

/** Bech32 charset used by NIP-19 identifiers. */
const BECH32_CHARS = "023456789acdefghjklmnpqrstuvwxyz";

/** Regex to extract an naddr1 identifier from a URL path (e.g. habla links). */
const NADDR_IN_URL_REGEX = new RegExp(`naddr1[${BECH32_CHARS}]{10,}`, "i");

/** Try to extract naddr coordinates from a URL containing an naddr1 identifier. */
function extractNaddrFromUrl(url: string): AddrCoords | null {
  const match = url.match(NADDR_IN_URL_REGEX);
  if (!match) return null;
  try {
    const decoded = nip19.decode(match[0]);
    if (decoded.type === "naddr") {
      return decoded.data as AddrCoords;
    }
  } catch {
    // invalid naddr
  }
  return null;
}

/** A parsed token from message content. */
type ContentToken =
  | { type: "text"; value: string }
  | { type: "image-embed"; url: string }
  | { type: "image-gallery"; urls: string[] }
  | { type: "media-embed"; url: string }
  | { type: "link-embed"; url: string }
  | { type: "inline-link"; url: string }
  | { type: "mention"; pubkey: string }
  | { type: "nevent-embed"; eventId: string; relays?: string[]; author?: string }
  | { type: "naddr-embed"; addr: AddrCoords; url?: string }
  | { type: "nostr-link"; id: string; raw: string }
  | { type: "hashtag"; tag: string; raw: string }
  | { type: "relay-link"; url: string }
  | { type: "lightning-invoice"; invoice: string };

/**
 * Regex segment matching a single visual emoji unit (ZWJ sequences, skin
 * tones, flags, keycaps, tag sequences, and basic presentation emojis).
 */
const EMOJI_UNIT = [
  "(?:" +
  "(?:\\p{Emoji_Presentation}|\\p{Emoji}\\uFE0F)" +
  "[\\u{1F3FB}-\\u{1F3FF}]?" +
  "(?:\\u200D(?:\\p{Emoji_Presentation}|\\p{Emoji}\\uFE0F)[\\u{1F3FB}-\\u{1F3FF}]?)+" +
  ")",
  "(?:[\\u{1F1E6}-\\u{1F1FF}]{2})",
  "(?:[0-9#*]\\uFE0F\\u20E3)",
  "(?:\\u{1F3F4}[\\u{E0020}-\\u{E007E}]+\\u{E007F})",
  "(?:(?:\\p{Emoji_Presentation}|\\p{Emoji}\\uFE0F)[\\u{1F3FB}-\\u{1F3FF}]?)",
].join("|");

/** NIP-30 custom emoji shortcode pattern. */
const CUSTOM_EMOJI_SHORTCODE = ":([a-zA-Z0-9_-]+):";

/** Matches a string of only emoji (unicode and/or custom shortcodes), max 10. */
const EMOJI_OR_CUSTOM_ONLY_REGEX = new RegExp(
  `^\\s*(?:(?:${CUSTOM_EMOJI_SHORTCODE}|${EMOJI_UNIT})\\s*){1,10}$`,
  "u",
);

/** Check if a string contains only emojis / resolvable custom shortcodes. */
function isOnlyEmojisOrCustom(text: string, emojiMap: Map<string, string>): boolean {
  if (!EMOJI_OR_CUSTOM_ONLY_REGEX.test(text)) return false;
  const shortcodeMatches = text.matchAll(/:([a-zA-Z0-9_-]+):/g);
  for (const m of shortcodeMatches) {
    if (!emojiMap.has(m[1])) return false;
  }
  return true;
}

/** Kinds whose imeta tags describe attached media for the content body. */
const MEDIA_IMETA_KINDS = new Set([1, 9, 11, 1111, 1222, 1244]);

/**
 * Rich message content renderer. Tokenizes the event content and renders:
 * URLs (inline images/galleries, video and audio players, link preview
 * cards), nostr: URIs (mentions, embedded note/naddr cards), hashtags,
 * NIP-30 custom emoji, and lightning invoices.
 */
export function ChatContent({ event, className, disableNoteEmbeds = false }: ChatContentProps) {
  const tokens = useMemo(() => {
    const text = event.content;

    // Map of imeta-declared URL → MIME, so extension-less media URLs (e.g.
    // blossom sha256 filenames) declared in an imeta tag still render as an
    // embed rather than a bare link followed by a duplicate embed.
    const imetaMimeByUrl = new Map<string, string>();
    if (MEDIA_IMETA_KINDS.has(event.kind)) {
      for (const tag of event.tags) {
        if (tag[0] !== "imeta") continue;
        let rawUrl: string | undefined;
        let mime: string | undefined;
        for (let j = 1; j < tag.length; j++) {
          const sp = tag[j].indexOf(" ");
          if (sp === -1) continue;
          const key = tag[j].slice(0, sp);
          if (key === "url") rawUrl = tag[j].slice(sp + 1);
          else if (key === "m") mime = tag[j].slice(sp + 1);
        }
        const u = sanitizeUrl(rawUrl);
        if (u && mime) imetaMimeByUrl.set(u, mime);
      }
    }

    // Match: BOLT11 invoices | URLs | nostr:-prefixed NIP-19 ids | @-prefixed or bare NIP-19 ids | hashtags
    const regex = new RegExp(
      "(?:lightning:)?(ln(?:bc|tb|bcrt|tbs)\\d*[munp]?1[023456789acdefghjklmnpqrstuvwxyz]+)" +
      "|((?:https?|wss?):\\/\\/[^\\s]+)" +
      "|nostr:(npub1|note1|nprofile1|nevent1|naddr1)([023456789acdefghjklmnpqrstuvwxyz]+)" +
      "|@?(npub1|note1|nprofile1|nevent1|naddr1)([023456789acdefghjklmnpqrstuvwxyz]+)" +
      `|(${HASHTAG_PATTERN})`,
      "giu",
    );

    const result: ContentToken[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    let hadMatches = false;

    while ((match = regex.exec(text)) !== null) {
      let [fullMatch] = match;
      const bolt11 = match[1];
      let url = match[2];
      const hashtag = match[7];
      const { 3: nostrPrefix, 4: nostrData, 5: barePrefix, 6: bareData } = match;
      const index = match.index;
      hadMatches = true;

      // Add text before this match
      if (index > lastIndex) {
        result.push({ type: "text", value: text.substring(lastIndex, index) });
      }

      if (bolt11) {
        result.push({ type: "lightning-invoice", invoice: bolt11.toLowerCase() });
      } else if (url) {
        // Strip common trailing punctuation that's likely not part of the URL
        const trailingPunctMatch = url.match(/^(.*?)([.,;:!?)\]]+)$/);
        if (trailingPunctMatch) {
          const [, urlWithoutPunct] = trailingPunctMatch;
          if (urlWithoutPunct && urlWithoutPunct.length > 10) {
            url = urlWithoutPunct;
            fullMatch = urlWithoutPunct;
          }
        }

        // WebSocket relay URLs → internal server page link
        if (/^wss?:\/\//i.test(url)) {
          result.push({ type: "relay-link", url });
          lastIndex = index + fullMatch.length;
          continue;
        }

        // Image URLs → render inline at their position in the text
        if (IMAGE_URL_REGEX.test(url)) {
          if (result.length > 0) {
            const prev = result[result.length - 1];
            if (prev.type === "text") {
              prev.value = prev.value.replace(/\s+$/, "");
            }
          }
          result.push({ type: "image-embed", url });
          lastIndex = index + fullMatch.length;
          const leadingWs = text.substring(lastIndex).match(/^\s+/);
          if (leadingWs) lastIndex += leadingWs[0].length;
          continue;
        }

        // Non-image media URLs (video, audio) — render inline at their position.
        // Match by extension, or by an imeta-declared audio/video MIME (covers
        // extension-less upload URLs like blossom sha256 filenames).
        const imetaMime = imetaMimeByUrl.get(url);
        const isImetaMedia = imetaMime?.startsWith("audio/") || imetaMime?.startsWith("video/");
        if (EMBED_MEDIA_URL_REGEX.test(url) || isImetaMedia) {
          if (result.length > 0) {
            const prev = result[result.length - 1];
            if (prev.type === "text") {
              prev.value = prev.value.replace(/\s+$/, "");
            }
          }
          result.push({ type: "media-embed", url });
          lastIndex = index + fullMatch.length;
          const leadingWs = text.substring(lastIndex).match(/^\s+/);
          if (leadingWs) lastIndex += leadingWs[0].length;
          continue;
        }

        // A URL gets a preview card when nothing meaningful follows it on
        // the same line; mid-sentence URLs stay plain links.
        const afterUrl = text.substring(index + fullMatch.length);
        const nextNewline = afterUrl.indexOf("\n");
        const lineSuffix = nextNewline === -1 ? afterUrl : afterUrl.substring(0, nextNewline);
        const isEndOfLine = lineSuffix.trim() === "";

        const naddrFromUrl = extractNaddrFromUrl(url);
        if (naddrFromUrl) {
          result.push({ type: "naddr-embed", addr: naddrFromUrl, url });
        } else if (isEndOfLine) {
          result.push({ type: "link-embed", url });
        } else {
          result.push({ type: "inline-link", url });
        }
      } else if ((nostrPrefix && nostrData) || (barePrefix && bareData)) {
        const prefix = nostrPrefix || barePrefix;
        const data = nostrData || bareData;
        try {
          const nostrId = `${prefix}${data}`;
          const decoded = nip19.decode(nostrId);

          if (decoded.type === "npub") {
            result.push({ type: "mention", pubkey: decoded.data });
          } else if (decoded.type === "nprofile") {
            result.push({ type: "mention", pubkey: decoded.data.pubkey });
          } else if (decoded.type === "note") {
            result.push({ type: "nevent-embed", eventId: decoded.data as string });
          } else if (decoded.type === "nevent") {
            result.push({
              type: "nevent-embed",
              eventId: decoded.data.id,
              relays: decoded.data.relays,
              author: decoded.data.author,
            });
          } else if (decoded.type === "naddr") {
            result.push({ type: "naddr-embed", addr: decoded.data as AddrCoords });
          } else {
            result.push({ type: "nostr-link", id: nostrId, raw: fullMatch });
          }
        } catch {
          result.push({ type: "text", value: fullMatch });
        }
      } else if (hashtag) {
        const tag = hashtag.slice(1);
        result.push({ type: "hashtag", tag, raw: hashtag });
      }

      lastIndex = index + fullMatch.length;
    }

    // Add any remaining text
    if (lastIndex < text.length) {
      result.push({ type: "text", value: text.substring(lastIndex) });
    }

    if (result.length === 0 && !hadMatches) {
      result.push({ type: "text", value: text });
    }

    // Enrich nevent-embed tokens with relay/author hints from `q` tags.
    const qTagMap = new Map<string, { relay?: string; author?: string }>();
    for (const tag of event.tags) {
      if (tag[0] === "q" && tag[1]) {
        qTagMap.set(tag[1], { relay: tag[2] || undefined, author: tag[3] || undefined });
      }
    }
    if (qTagMap.size > 0) {
      for (const token of result) {
        if (token.type === "nevent-embed") {
          const qInfo = qTagMap.get(token.eventId);
          if (qInfo) {
            if ((!token.relays || token.relays.length === 0) && qInfo.relay) {
              token.relays = [qInfo.relay];
            }
            if (!token.author && qInfo.author) {
              token.author = qInfo.author;
            }
          }
        }
      }
    }

    // Append media-embed tokens for imeta-declared media URLs not found in
    // the content (NIP-92 attachments without inline URLs).
    if (MEDIA_IMETA_KINDS.has(event.kind)) {
      const contentMediaUrls = new Set(
        result
          .filter((t): t is { type: "media-embed"; url: string } => t.type === "media-embed")
          .map((t) => t.url),
      );
      for (const tag of event.tags) {
        if (tag[0] !== "imeta") continue;
        let rawUrl: string | undefined;
        let mime: string | undefined;
        for (let j = 1; j < tag.length; j++) {
          const sp = tag[j].indexOf(" ");
          if (sp === -1) continue;
          const key = tag[j].slice(0, sp);
          if (key === "url") rawUrl = tag[j].slice(sp + 1);
          else if (key === "m") mime = tag[j].slice(sp + 1);
        }
        const url = sanitizeUrl(rawUrl);
        if (!url || contentMediaUrls.has(url)) continue;
        if (mime?.startsWith("audio/") || mime?.startsWith("video/")) {
          result.push({ type: "media-embed", url });
        }
      }
    }

    // Collapse excessive whitespace around block-level tokens.
    for (let i = 0; i < result.length; i++) {
      const token = result[i];
      const isBlock = token.type === "image-embed" || token.type === "media-embed"
        || token.type === "link-embed" || token.type === "nevent-embed"
        || (token.type === "naddr-embed" && !token.url) || token.type === "lightning-invoice";

      if (isBlock) {
        if (i > 0) {
          const prev = result[i - 1];
          if (prev.type === "text") {
            prev.value = prev.value.replace(/\s+$/, "");
          }
        }
        if (i < result.length - 1) {
          const next = result[i + 1];
          if (next.type === "text") {
            next.value = next.value.replace(/^\s+/, "");
          }
        }
      }
    }

    // Trim leading/trailing whitespace from edge text tokens.
    if (result.length > 0) {
      const first = result[0];
      if (first.type === "text") {
        first.value = first.value.replace(/^\s+/, "");
      }
      const last = result[result.length - 1];
      if (last.type === "text") {
        last.value = last.value.replace(/\s+$/, "");
      }
    }

    // Filter out empty text tokens
    return result.filter((t) => !(t.type === "text" && t.value === ""));
  }, [event]);

  // Build emoji map for NIP-30 custom emoji rendering. Merge the event's own
  // emoji tags with the viewer's collection so shortcodes still render when
  // the published event omitted the tag.
  const { emojis: viewerEmojis } = useCustomEmojis();
  const emojiMap = useMemo(() => {
    const map = buildEmojiMap(event.tags);
    for (const e of viewerEmojis) {
      if (!map.has(e.shortcode)) {
        map.set(e.shortcode, e.url);
      }
    }
    return map;
  }, [event.tags, viewerEmojis]);

  // Parse imeta tags — used for media poster/dim/waveform metadata
  const imetaMap = useMemo(() => parseImetaMap(event.tags), [event.tags]);

  // Group consecutive image-embed tokens (≥2) into image-gallery tokens
  const groupedTokens = useMemo(() => {
    const result: ContentToken[] = [];
    let i = 0;
    while (i < tokens.length) {
      const token = tokens[i];
      if (token.type === "image-embed") {
        const run: string[] = [token.url];
        let j = i + 1;
        while (j < tokens.length && tokens[j].type === "image-embed") {
          run.push((tokens[j] as { type: "image-embed"; url: string }).url);
          j++;
        }
        if (run.length >= 2) {
          result.push({ type: "image-gallery", urls: run });
        } else {
          result.push(token);
        }
        i = j;
      } else {
        result.push(token);
        i++;
      }
    }
    return result;
  }, [tokens]);

  // Collect all inline image URLs (in order) for the shared lightbox
  const allImages = useMemo(
    () =>
      groupedTokens.flatMap((t) => {
        if (t.type === "image-embed") return [t.url];
        if (t.type === "image-gallery") return t.urls;
        return [];
      }),
    [groupedTokens],
  );

  // Shared lightbox state for inline images
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const closeLightbox = useCallback(() => setLightboxIndex(null), []);
  const goNext = useCallback(
    () => setLightboxIndex((p) => (p !== null ? (p + 1) % allImages.length : null)),
    [allImages.length],
  );
  const goPrev = useCallback(
    () => setLightboxIndex((p) => (p !== null ? (p - 1 + allImages.length) % allImages.length : null)),
    [allImages.length],
  );

  // Map from grouped token index → starting image list index
  const tokenImageIndex = useMemo(() => {
    const map = new Map<number, number>();
    let imgCount = 0;
    groupedTokens.forEach((t, i) => {
      if (t.type === "image-embed") {
        map.set(i, imgCount++);
      } else if (t.type === "image-gallery") {
        map.set(i, imgCount);
        imgCount += t.urls.length;
      }
    });
    return map;
  }, [groupedTokens]);

  // Emoji-only messages render extra large
  const isEmojiOnly = groupedTokens.length === 1
    && groupedTokens[0].type === "text"
    && isOnlyEmojisOrCustom(groupedTokens[0].value, emojiMap);

  return (
    <div dir="auto" className={cn("whitespace-pre-wrap break-words overflow-hidden", className, isEmojiOnly && "text-4xl leading-tight")}>
      {groupedTokens.map((token, i) => {
        switch (token.type) {
          case "text":
            return (
              <span key={i}>
                {emojify(
                  token.value,
                  emojiMap,
                  isEmojiOnly ? "inline h-10 w-10 object-contain align-text-bottom" : undefined,
                )}
              </span>
            );
          case "image-embed": {
            const imgIndex = tokenImageIndex.get(i) ?? 0;
            return (
              <InlineImage
                key={i}
                url={token.url}
                onClick={(e) => {
                  e.stopPropagation();
                  setLightboxIndex(imgIndex);
                }}
              />
            );
          }
          case "image-gallery": {
            const galleryStartIndex = tokenImageIndex.get(i) ?? 0;
            return (
              <ImageGrid
                key={i}
                images={token.urls}
                onOpen={(idx) => setLightboxIndex(galleryStartIndex + idx)}
              />
            );
          }
          case "link-embed":
            return <LinkEmbed key={i} url={token.url} className="my-1.5" />;
          case "inline-link": {
            const safe = sanitizeUrl(token.url);
            if (!safe) return <span key={i}>{token.url}</span>;
            return (
              <a
                key={i}
                href={safe}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline break-all"
                onClick={(e) => e.stopPropagation()}
              >
                {token.url}
              </a>
            );
          }
          case "media-embed": {
            const imeta = imetaMap.get(token.url);
            const mime = imeta?.mime ?? "";
            const isAudio = mime.startsWith("audio/")
              || /\.(mp3|wav|ogg|flac|m4a|aac|opus)(\?[^\s]*)?$/i.test(token.url);
            if (isAudio) {
              const waveform = imeta ? getImetaField(event.tags, token.url, "waveform") : undefined;
              const duration = imeta ? getImetaField(event.tags, token.url, "duration") : undefined;
              return (
                <AudioMessage
                  key={i}
                  src={token.url}
                  mime={imeta?.mime}
                  waveform={waveform}
                  duration={duration}
                />
              );
            }
            return <VideoPlayer key={i} src={token.url} poster={imeta?.thumbnail} dim={imeta?.dim} />;
          }
          case "nevent-embed": {
            if (disableNoteEmbeds) {
              return <TruncatedNostrLink key={i} encode={() =>
                nip19.neventEncode({
                  id: token.eventId,
                  ...(token.author ? { author: token.author } : {}),
                  ...(token.relays?.length ? { relays: token.relays } : {}),
                })}
              />;
            }
            return (
              <EmbeddedNote
                key={i}
                eventId={token.eventId}
                relays={token.relays}
                authorHint={token.author}
              />
            );
          }
          case "naddr-embed": {
            if (disableNoteEmbeds) {
              return <TruncatedNostrLink key={i} encode={() => nip19.naddrEncode(token.addr)} />;
            }
            return (
              <span key={i}>
                {token.url && (
                  <a
                    href={token.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline break-all"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {token.url}
                  </a>
                )}
                <EmbeddedNaddr addr={token.addr} />
              </span>
            );
          }
          case "mention":
            return <NostrMention key={i} pubkey={token.pubkey} />;
          case "nostr-link":
            return (
              <a
                key={i}
                href={`https://njump.me/${token.id}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline break-all"
                onClick={(e) => e.stopPropagation()}
              >
                {token.raw.slice(0, 16)}…
              </a>
            );
          case "hashtag":
            return (
              <span key={i} className="text-primary font-medium">
                {token.raw}
              </span>
            );
          case "relay-link":
            return (
              <Link
                key={i}
                to={`/s/${relayToRouteParam(token.url)}`}
                className="text-primary hover:underline break-all"
                onClick={(e) => e.stopPropagation()}
              >
                {token.url}
              </Link>
            );
          case "lightning-invoice":
            return <LightningInvoice key={i} invoice={token.invoice} />;
        }
      })}

      {lightboxIndex !== null && (
        <Lightbox
          images={allImages}
          currentIndex={lightboxIndex}
          onClose={closeLightbox}
          onNext={goNext}
          onPrev={goPrev}
        />
      )}
    </div>
  );
}

/** Read a named field (e.g. `waveform`, `duration`) from the imeta tag for a URL. */
function getImetaField(tags: string[][], url: string, field: string): string | undefined {
  for (const tag of tags) {
    if (tag[0] !== "imeta") continue;
    if (!tag.some((part) => part === `url ${url}`)) continue;
    for (const part of tag) {
      if (part.startsWith(`${field} `)) return part.slice(field.length + 1);
    }
  }
  return undefined;
}

/** Inline image thumbnail that opens the shared lightbox on click. */
function InlineImage({ url, onClick }: { url: string; onClick: (e: React.MouseEvent) => void }) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary hover:underline break-all"
        onClick={(e) => e.stopPropagation()}
      >
        {url}
      </a>
    );
  }

  return (
    <button
      type="button"
      className="block my-1.5 rounded-lg overflow-hidden max-w-sm cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      onClick={onClick}
    >
      <div
        className={cn("relative rounded-lg overflow-hidden", !loaded && "bg-muted")}
        style={!loaded ? { minHeight: 120, minWidth: 160 } : undefined}
      >
        <img
          src={url}
          alt=""
          className="block max-w-full max-h-80 h-auto rounded-lg hover:opacity-90 transition-opacity"
          loading="lazy"
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
        />
      </div>
    </button>
  );
}

/** Compact grid for multiple consecutive images, sharing the lightbox. */
function ImageGrid({ images, onOpen }: { images: string[]; onOpen: (index: number) => void }) {
  const visible = images.slice(0, 4);
  const extra = images.length - visible.length;

  return (
    <div className="grid grid-cols-2 gap-1 my-1.5 max-w-sm">
      {visible.map((url, i) => (
        <button
          key={i}
          type="button"
          className="relative aspect-square rounded-lg overflow-hidden bg-muted cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          onClick={(e) => {
            e.stopPropagation();
            onOpen(i);
          }}
        >
          <img src={url} alt="" loading="lazy" className="absolute inset-0 w-full h-full object-cover hover:opacity-90 transition-opacity" />
          {i === visible.length - 1 && extra > 0 && (
            <span className="absolute inset-0 bg-black/60 flex items-center justify-center text-white text-lg font-semibold">
              +{extra}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

/** Mention chip resolving the profile's display name. */
function NostrMention({ pubkey }: { pubkey: string }) {
  const author = useAuthor(pubkey);
  const hasRealName = !!(author.data?.metadata?.name || author.data?.metadata?.display_name);
  const displayName = getDisplayName(author.data?.metadata, pubkey);

  return (
    <span
      className={cn(
        "font-medium",
        hasRealName ? "text-primary" : "text-muted-foreground",
      )}
      title={pubkey}
    >
      @{displayName}
    </span>
  );
}

/** Truncated external link for nested nostr references inside embedded cards. */
function TruncatedNostrLink({ encode }: { encode: () => string }) {
  const id = useMemo(() => {
    try {
      return encode();
    } catch {
      return null;
    }
  }, [encode]);

  if (!id) return null;

  return (
    <a
      href={`https://njump.me/${id}`}
      target="_blank"
      rel="noopener noreferrer"
      className="text-primary hover:underline break-all"
      onClick={(e) => e.stopPropagation()}
    >
      {id.slice(0, 16)}…
    </a>
  );
}

/** Compact copyable chip for BOLT11 lightning invoices. */
function LightningInvoice({ invoice }: { invoice: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      className="inline-flex items-center gap-1.5 max-w-full my-1 px-2.5 py-1 rounded-full border border-amber-500/40 bg-amber-500/10 text-amber-500 text-xs hover:bg-amber-500/20 transition-colors"
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard?.writeText(invoice).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      title="Copy lightning invoice"
    >
      <span aria-hidden>⚡</span>
      <span className="truncate font-mono">{invoice.slice(0, 24)}…</span>
      <span className="shrink-0">{copied ? "Copied!" : "Copy"}</span>
    </button>
  );
}
