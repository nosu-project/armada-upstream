import {
  Award, Brain, CalendarDays, Check, Eye, EyeOff, ExternalLink, FileDigit,
  FileQuestion, FileText, Film, Gem, Image as ImageIcon, Layers, List, MapPin,
  Mic, Mountain, Music, Package, Palette, Server, Shield, Sparkles, Swords,
  Tag, User, Users, Zap,
} from "lucide-react";
import { nip19 } from "nostr-tools";
import { useCallback, useMemo, useRef, useState } from "react";

import type { ComponentType, ReactNode } from "react";

import { BlurhashCanvas } from "@/components/BlurhashCanvas";
import { DittoIcon } from "@/components/brand/DittoIcon";
import { CardsIcon } from "@/components/icons/CardsIcon";
import { ChestIcon } from "@/components/icons/ChestIcon";
import { CalendarEventMessageCard } from "@/components/chat/CalendarEventCard";
import { ChatContent } from "@/components/chat/ChatContent";
import { CustomEmojiImg, EmojifiedText } from "@/components/chat/CustomEmoji";
import { EmojiPackCard } from "@/components/chat/EmojiPackCard";
import { Lightbox, type LightboxItem } from "@/components/chat/Lightbox";
import { PollView } from "@/components/chat/PollView";
import { ProfilePreviewCard } from "@/components/chat/ProfilePreviewCard";
import { VideoPlayer } from "@/components/chat/VideoPlayer";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { FallbackImage } from "@/components/ui/FallbackImage";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useAddrEvent, useEvent, type AddrCoords } from "@/hooks/useEvent";
import { useAuthor } from "@/hooks/useAuthor";
import { useMediaWithFallback } from "@/hooks/useMediaWithFallback";
import { toast } from "@/hooks/useToast";
import { getAvatarShape } from "@/lib/avatarShape";
import { parseCalendarEvent, type RsvpTally } from "@/lib/calendar";
import { writeClipboardText } from "@/lib/clipboard";
import { getCustomEmojiUrl, isCustomEmoji, isRenderableReactionKey } from "@/lib/customEmoji";
import { dittoEventUrl, dittoHashtagUrl } from "@/lib/dittoUrl";
import { faviconUrl } from "@/lib/faviconUrl";
import { shortTimeAgo } from "@/lib/formatTime";
import { getDisplayName } from "@/lib/getDisplayName";
import { parseImetaMap } from "@/lib/imeta";
import { scryfallImageUrl, type CardRef } from "@/lib/scryfall";
import { tryNaddrEncode, tryNeventEncode } from "@/lib/safeNip19";
import { displayHost, externalUrl, sanitizeImageSrc } from "@/lib/sanitizeUrl";
import { openUrl } from "@/lib/share";
import { cn } from "@/lib/utils";
import { formatSats, receiptAmountSats, receiptZapRequest } from "@/lib/zaps";

import type { NostrRumor } from "@/lib/nostrRumor";
import type { PollTally } from "@/lib/polls";

interface EmbeddedNoteProps {
  /** Hex event ID to fetch and display. */
  eventId: string;
  /** Optional relay hints from the nevent1 identifier. */
  relays?: string[];
  /** Optional author pubkey hint from the nevent1 identifier. */
  authorHint?: string;
  /** When the embed was unfolded from a link on another host (an
   *  `njump.me/nevent1…` URL), the original URL — surfaced as a favicon+host
   *  chip that opens the source. */
  sourceUrl?: string;
  className?: string;
}

/** Label + icon for a kind rendered as a compact preview card. */
interface KindMeta {
  label: string;
  Icon?: ComponentType<{ className?: string }>;
}

/**
 * Kinds that get a tag-based preview card (cover / title / summary) instead of
 * running their content — JSON metadata, Markdown, or a media manifest — through
 * the kind-1 text tokenizer. Text-note kinds (1, 11, 1111, 9, 42, 14, voice,
 * …) are deliberately absent: those render their body through {@link ChatContent},
 * which already handles inline media and encrypted attachments. Reactions (7),
 * polls (1068), and emoji packs (30030) have dedicated branches.
 */
const KIND_META: Record<number, KindMeta> = {
  0: { label: "Profile", Icon: User },
  3: { label: "Follow list", Icon: Users },
  6: { label: "Repost" },
  8: { label: "Badge award", Icon: Award },
  16: { label: "Repost" },
  20: { label: "Photo", Icon: ImageIcon },
  21: { label: "Video", Icon: Film },
  22: { label: "Short video", Icon: Film },
  8333: { label: "Zap", Icon: Zap },
  9735: { label: "Zap receipt", Icon: Zap },
  10002: { label: "Relay list", Icon: Server },
  30000: { label: "People list", Icon: Users },
  30009: { label: "Badge", Icon: Award },
  30023: { label: "Article", Icon: FileText },
  30024: { label: "Article draft", Icon: FileText },
  30040: { label: "Publication", Icon: FileText },
  30041: { label: "Publication section", Icon: FileText },
  30054: { label: "Podcast", Icon: Mic },
  30055: { label: "Podcast trailer", Icon: Mic },
  30402: { label: "Listing", Icon: Tag },
  31922: { label: "Calendar event", Icon: CalendarDays },
  31923: { label: "Calendar event", Icon: CalendarDays },
  34139: { label: "Playlist", Icon: Music },
  34236: { label: "Short video", Icon: Film },
  36787: { label: "Music", Icon: Music },
  37381: { label: "Magic deck", Icon: Layers },
  37516: { label: "Treasure", Icon: Gem },
  39089: { label: "People list", Icon: Users },
};

/** Photo kinds whose images live in imeta tags (NIP-68). */
const PHOTO_KINDS = new Set([20]);
/** Video kinds whose media lives in imeta tags (NIP-71 + vines). */
const VIDEO_KINDS = new Set([21, 22, 34236]);

/**
 * NIP-21 `nostr:` URI for a resolved event, so the user can copy it and
 * paste into their preferred client. Addressable events encode to an
 * `naddr` (stable across edits); everything else to an `nevent` carrying
 * the author pubkey as a relay hint. Returns `undefined` for malformed
 * id/pubkey (matching `dittoEventUrl`'s routing).
 */
function eventNostrUri(event: NostrRumor): string | undefined {
  if (event.kind >= 30000 && event.kind < 40000) {
    const identifier = event.tags.find((t) => t[0] === "d")?.[1] ?? "";
    const naddr = tryNaddrEncode({ kind: event.kind, pubkey: event.pubkey, identifier });
    return naddr ? `nostr:${naddr}` : undefined;
  }
  const nevent = tryNeventEncode({ id: event.id, author: event.pubkey });
  return nevent ? `nostr:${nevent}` : undefined;
}

/** Inline embedded note card – like a link preview but for Nostr events. */
export function EmbeddedNote({ eventId, relays, authorHint, sourceUrl, className }: EmbeddedNoteProps) {
  const { data: event, isLoading } = useEvent(eventId, relays, authorHint);

  if (isLoading) {
    return <EmbeddedNoteSkeleton className={className} />;
  }

  if (!event) {
    return <EmbeddedNoteTombstone eventId={eventId} className={className} />;
  }

  return <EmbeddedEventCard event={event} sourceUrl={sourceUrl} className={className} />;
}

/** Inline embedded card for an addressable event (naddr). */
export function EmbeddedNaddr({ addr, className }: { addr: AddrCoords; className?: string }) {
  const { data: event, isLoading } = useAddrEvent(addr);

  if (isLoading) {
    return <EmbeddedNoteSkeleton className={className} />;
  }

  if (!event) {
    let naddr: string | undefined;
    try {
      naddr = nip19.naddrEncode(addr);
    } catch {
      naddr = undefined;
    }
    return <EmbeddedNoteTombstone eventId={naddr ?? addr.identifier} className={className} />;
  }

  return <EmbeddedEventCard event={event} className={className} />;
}

/**
 * Shared card body for any resolved event.
 *
 * Modeled on Ditto's NoteCard/EmbeddedCardShell: a soft `rounded-2xl`
 * card with a whole-card hover tint, an author row (avatar + name +
 * `· timeAgo`), the height-capped note content, and a "View on Ditto"
 * off-ramp footer.
 */
export function EmbeddedEventCard({ event, sourceUrl, className }: { event: NostrRumor; sourceUrl?: string; className?: string }) {
  // NIP-30 emoji packs get a dedicated preview + "Add" card rather than the
  // generic event body (whose content is empty — the emojis live in tags).
  if (event.kind === 30030) {
    return <EmojiPackCard event={event} className={className} />;
  }
  return <GenericEventCard event={event} sourceUrl={sourceUrl} className={className} />;
}

function GenericEventCard({ event, sourceUrl, className }: { event: NostrRumor; sourceUrl?: string; className?: string }) {
  const author = useAuthor(event.pubkey);
  const metadata = author.data?.metadata;
  const displayName = getDisplayName(metadata, event.pubkey);
  const meta = KIND_META[event.kind];
  const label = meta?.label ?? null;
  const title = event.tags.find(([name]) => name === "title")?.[1];

  // Reactions render their emoji rather than raw content.
  const reactionEmoji = event.kind === 7
    ? (event.content === "+" || event.content === "" ? "👍" : event.content === "-" ? "👎" : event.content)
    : null;

  // Off-ramp to the fuller social view of this event on ditto.pub.
  const dittoHref = dittoEventUrl(event);
  // NIP-21 identifier to copy for pasting into any other Nostr client.
  const nostrUri = eventNostrUri(event);

  return (
    <div
      className={cn(
        "group block max-w-md w-full rounded-2xl border border-border overflow-hidden",
        "transition-colors hover:bg-secondary/40 my-1.5",
        className,
      )}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="px-3 py-2 space-y-1 min-w-0">
        {/* Author row */}
        <div className="flex items-center gap-2 min-w-0">
          <ProfilePreviewCard pubkey={event.pubkey}>
            <button type="button" className="shrink-0" onClick={(e) => e.stopPropagation()}>
              <Avatar shape={getAvatarShape(metadata)} className="size-5">
                <AvatarImage src={metadata?.picture} alt={displayName} />
                <AvatarFallback className="bg-primary/20 text-primary text-[10px]">
                  {displayName[0]?.toUpperCase()}
                </AvatarFallback>
              </Avatar>
            </button>
          </ProfilePreviewCard>

          <ProfilePreviewCard pubkey={event.pubkey}>
            <button
              type="button"
              className="text-sm font-semibold truncate hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {author.data?.event
                ? <EmojifiedText tags={author.data.event.tags}>{displayName}</EmojifiedText>
                : displayName}
            </button>
          </ProfilePreviewCard>

          {label && (
            <span className="text-[10px] px-1.5 py-px rounded-full bg-secondary text-muted-foreground shrink-0">
              {label}
            </span>
          )}

          <span className="text-xs text-muted-foreground shrink-0">
            · {shortTimeAgo(event.created_at)}
          </span>
        </div>

        {/* Body — dispatched by kind: a reaction shows its emoji; the media,
            poll, calendar and zap kinds get their real renderers (the same
            components the timeline uses); the remaining non-note kinds
            (article, listing, publication, badge, …) a tag-driven preview
            card; everything else the note text through the shared renderer. */}
        {reactionEmoji !== null ? (
          <div className="text-2xl">
            {isCustomEmoji(reactionEmoji)
              ? (() => {
                const url = getCustomEmojiUrl(reactionEmoji, event.tags);
                return url
                  ? <CustomEmojiImg name={reactionEmoji.slice(1, -1)} url={url} className="inline h-7 w-7 object-contain" fallback={reactionEmoji} />
                  : reactionEmoji;
              })()
              : isRenderableReactionKey(reactionEmoji) ? reactionEmoji : "❓"}
          </div>
        ) : event.kind === 1068 ? (
          <EmbeddedPollCard event={event} />
        ) : (event.kind === 31922 || event.kind === 31923) ? (
          <EmbeddedCalendarCard event={event} meta={meta!} />
        ) : (event.kind === 9735 || event.kind === 8333) ? (
          <EmbeddedZapCard event={event} />
        ) : PHOTO_KINDS.has(event.kind) ? (
          <EmbeddedPhotoCard event={event} meta={meta!} />
        ) : VIDEO_KINDS.has(event.kind) ? (
          <EmbeddedVideoCard event={event} meta={meta!} />
        ) : event.kind === 37381 ? (
          <EmbeddedMagicDeckCard event={event} />
        ) : event.kind === 37516 ? (
          <EmbeddedTreasureCard event={event} />
        ) : meta ? (
          <TagPreviewCard event={event} meta={meta} />
        ) : (
          <EmbedTruncatedBody>
            {title && <p className="text-sm font-semibold leading-snug mb-0.5 line-clamp-2">{title}</p>}
            <ChatContent event={event} className="text-sm leading-relaxed" disableNoteEmbeds />
          </EmbedTruncatedBody>
        )}

        {/* Source back-link: when this card was unfolded from a link on
            another host, a favicon+host chip that opens the original. */}
        <SourceLink url={sourceUrl} />

        {/* Off-ramp footer: view on Ditto (left) + copy id (lower-right) */}
        {(dittoHref || nostrUri) && (
          <div className="mt-0.5 flex items-center">
            {dittoHref && <DittoLink href={dittoHref} />}
            {nostrUri && <CopyIdButton uri={nostrUri} className="ml-auto" />}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * NIP-88 poll (kind 1068) rendered through the SAME {@link PollView} the
 * timeline uses — read-only here (no vote fetch across the embed boundary): an
 * empty tally with `canVote={false}` yields the result-bar layout at 0%. The
 * question (the `content`) is shown above it, since PollView reads only tags.
 */
function EmbeddedPollCard({ event }: { event: NostrRumor }) {
  const tally: PollTally = useMemo(
    () => ({ counts: new Map(), totalVoters: 0, myVote: undefined }),
    [],
  );
  const question = event.content.trim();
  return (
    <div className="space-y-1.5 min-w-0">
      {question.length > 0 && (
        <p className="text-sm font-medium leading-snug break-words line-clamp-3">{question}</p>
      )}
      <PollView event={event} tally={tally} canVote={false} onVote={() => {}} />
    </div>
  );
}

/**
 * NIP-52 calendar event (31922/31923) rendered through the SAME
 * {@link CalendarEventMessageCard} the timeline uses — read-only (no RSVP fetch
 * across the embed boundary), so an empty tally with `canRsvp={false}`. Falls
 * back to the tag preview when the event doesn't parse.
 */
function EmbeddedCalendarCard({ event, meta }: { event: NostrRumor; meta: KindMeta }) {
  const calendar = useMemo(() => parseCalendarEvent(event), [event]);
  const emptyTally: RsvpTally = useMemo(() => ({ accepted: [], declined: [], tentative: [] }), []);
  if (!calendar) return <TagPreviewCard event={event} meta={meta} />;
  return (
    <CalendarEventMessageCard
      event={calendar}
      tally={emptyTally}
      canRsvp={false}
      isSettingRsvp={false}
      onSetRsvp={() => {}}
    />
  );
}

/**
 * Zap receipt (9735) / on-chain zap (8333): the amount and the zapper's
 * comment. The amount is the verified one — for a Lightning receipt the bolt11
 * invoice via the embedded (signature-checked) request, for an on-chain zap the
 * `amount` tag — so a receipt that doesn't verify shows a bare "Zap".
 */
function EmbeddedZapCard({ event }: { event: NostrRumor }) {
  const { sats, comment } = useMemo(() => {
    if (event.kind === 9735) {
      const request = receiptZapRequest(event);
      return { sats: request ? receiptAmountSats(event, request) : 0, comment: request?.content ?? "" };
    }
    const amt = Number(event.tags.find(([n]) => n === "amount")?.[1]);
    return { sats: Number.isFinite(amt) && amt > 0 ? amt : 0, comment: event.content ?? "" };
  }, [event]);

  return (
    <div className="flex items-center gap-2.5 py-1 min-w-0">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-amber-500/15 text-amber-500">
        <Zap className="size-4" />
      </div>
      <div className="min-w-0">
        <div className="text-sm font-semibold">{sats > 0 ? `${formatSats(sats)} sats` : "Zap"}</div>
        {comment.trim().length > 0 && (
          <p className="text-xs text-muted-foreground truncate">{comment.trim()}</p>
        )}
      </div>
    </div>
  );
}

/**
 * A single resolved media thumbnail — decrypts an encrypted Blossom blob the
 * same way the timeline does (`useResolvedMediaSrc`), with a blurhash placeholder
 * until it paints. Clicking opens the shared cinematic {@link Lightbox}.
 */
function PreviewImage({ item, onClick, className }: { item: LightboxItem; onClick?: () => void; className?: string }) {
  const { resolved, onError, failed } = useMediaWithFallback(item);
  const [loaded, setLoaded] = useState(false);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick?.();
      }}
      className={cn("relative block w-full overflow-hidden bg-secondary/40", className)}
    >
      {item.blurhash && !loaded && (
        <BlurhashCanvas hash={item.blurhash} className="absolute inset-0 h-full w-full" />
      )}
      {resolved.status === "ready" && !failed && (
        <img
          src={resolved.src}
          alt=""
          loading="lazy"
          onLoad={() => setLoaded(true)}
          onError={onError}
          className={cn(
            "h-full w-full object-cover transition-opacity duration-300",
            loaded ? "opacity-100" : "opacity-0",
          )}
        />
      )}
    </button>
  );
}

/**
 * NIP-68 picture post (kind 20): the images live in `imeta` tags. Shows a
 * cover (or a 2×2 grid for multiples with a `+N` overflow), and clicking opens
 * the shared {@link Lightbox} at that image. Falls back to the tag preview
 * when no imeta media resolves.
 */
function EmbeddedPhotoCard({ event, meta }: { event: NostrRumor; meta: KindMeta }) {
  const title = event.tags.find(([n]) => n === "title")?.[1];
  const imeta = useMemo(() => parseImetaMap(event.tags), [event.tags]);
  const items = useMemo<LightboxItem[]>(
    () =>
      [...imeta.values()]
        .map((e): LightboxItem | null => {
          const url = sanitizeImageSrc(e.url);
          if (!url) return null;
          return {
            url,
            mime: e.mime,
            encryption: e.encryption,
            fallbacks: e.fallbacks,
            dim: e.dim,
            blurhash: e.blurhash,
          };
        })
        .filter((x): x is LightboxItem => x !== null),
    [imeta],
  );
  const [index, setIndex] = useState<number | null>(null);

  if (items.length === 0) return <TagPreviewCard event={event} meta={meta} />;

  const tiles = items.slice(0, 4);
  const multiple = tiles.length > 1;

  return (
    <div className="space-y-1.5 min-w-0">
      {title && <p className="text-sm font-semibold leading-snug line-clamp-2">{title}</p>}

      <div
        className={cn(
          "grid gap-1 overflow-hidden rounded-xl",
          multiple ? "grid-cols-2" : "grid-cols-1",
        )}
      >
        {tiles.map((item, i) => (
          <div key={item.url} className="relative">
            <PreviewImage
              item={item}
              onClick={() => setIndex(i)}
              className={cn(multiple ? "aspect-square" : "max-h-[260px] aspect-video")}
            />
            {/* The last visible tile carries the overflow count. */}
            {multiple && i === tiles.length - 1 && items.length > tiles.length && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/50 text-lg font-semibold text-white">
                +{items.length - tiles.length}
              </div>
            )}
          </div>
        ))}
      </div>

      {index !== null && (
        <Lightbox
          media={items}
          currentIndex={index}
          onClose={() => setIndex(null)}
          onNext={() => setIndex((i) => (i === null ? i : Math.min(items.length - 1, i + 1)))}
          onPrev={() => setIndex((i) => (i === null ? i : Math.max(0, i - 1)))}
        />
      )}
    </div>
  );
}

/**
 * NIP-71 video / short video / vine (21/22/34236): the media lives in `imeta`
 * tags. Renders the first source inline through the SAME {@link VideoPlayer}
 * the timeline uses. Falls back to the tag preview when no imeta media resolves.
 */
function EmbeddedVideoCard({ event, meta }: { event: NostrRumor; meta: KindMeta }) {
  const title = event.tags.find(([n]) => n === "title")?.[1];
  const imeta = useMemo(() => parseImetaMap(event.tags), [event.tags]);
  const first = useMemo(() => {
    for (const e of imeta.values()) {
      const url = sanitizeImageSrc(e.url);
      if (url) return { url, entry: e };
    }
    return undefined;
  }, [imeta]);

  if (!first) return <TagPreviewCard event={event} meta={meta} />;

  return (
    <div className="space-y-1.5 min-w-0">
      {title && <p className="text-sm font-semibold leading-snug line-clamp-2">{title}</p>}
      <div className="overflow-hidden rounded-xl" onClick={(e) => e.stopPropagation()}>
        <VideoPlayer
          src={first.url}
          poster={first.entry.thumbnail}
          dim={first.entry.dim}
          blurhash={first.entry.blurhash}
          mime={first.entry.mime}
          encryption={first.entry.encryption}
          fallbacks={first.entry.fallbacks}
        />
      </div>
    </div>
  );
}

/** A parsed card entry from a magic-deck `c` (main) or `b` (sideboard) tag. */
interface DeckCard {
  name: string;
  quantity: number;
  setId: string;
  artId: string;
  foil: boolean;
}

/** Parse a `["c"|"b", name, qty, set?, collector-number?, lang?, foil?]` tag. */
function parseDeckCard(tag: string[]): DeckCard | null {
  if (tag.length < 3) return null;
  const [, name, qty, setId, artId, , foil] = tag;
  const quantity = parseInt(qty, 10);
  if (!name || !Number.isFinite(quantity) || quantity < 1) return null;
  return { name, quantity, setId: setId ?? "", artId: artId ?? "", foil: foil === "foil" || foil === "true" };
}

/** MTG format tags → display labels (drives the format badge row). */
const DECK_FORMAT_LABELS: Record<string, string> = {
  standard: "Standard", modern: "Modern", commander: "Commander", legacy: "Legacy",
  vintage: "Vintage", pioneer: "Pioneer", pauper: "Pauper", cedh: "cEDH",
  limited: "Limited", draft: "Draft", sealed: "Sealed", brawl: "Brawl",
  historic: "Historic", explorer: "Explorer", alchemy: "Alchemy", timeless: "Timeless",
};
/** Non-format archetype tags → display labels. */
const DECK_ARCHETYPE_LABELS: Record<string, string> = {
  aggro: "Aggro", midrange: "Midrange", control: "Control", combo: "Combo",
  tempo: "Tempo", ramp: "Ramp", tribal: "Tribal", burn: "Burn", mill: "Mill",
  stax: "Stax", tokens: "Tokens", reanimator: "Reanimator", voltron: "Voltron",
  aristocrats: "Aristocrats",
};

/** A single decklist row (quantity × name, foil-tinted). */
function DeckCardRow({ card, onClick }: { card: DeckCard; onClick?: () => void }) {
  return (
    <div
      className="flex items-center justify-between px-3 py-1 text-[13px] hover:bg-secondary/30 transition-colors cursor-pointer"
      onClick={onClick}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-muted-foreground tabular-nums text-xs w-5 text-right shrink-0">{card.quantity}x</span>
        <span className={cn("truncate", card.foil && "bg-gradient-to-r from-foreground via-primary to-foreground bg-clip-text text-transparent")}>
          {card.name}
        </span>
        {card.foil && <Sparkles className="size-3 text-primary shrink-0" />}
      </div>
      {card.setId && (
        <span className="text-[10px] text-muted-foreground uppercase tracking-wider shrink-0 ml-2">{card.setId}</span>
      )}
    </div>
  );
}

/** A card as a Scryfall-image tile (falls back to its name on a load error). */
function DeckCardTile({ card, onClick }: { card: DeckCard; onClick?: () => void }) {
  const [failed, setFailed] = useState(false);
  const ref: CardRef = { setId: card.setId || undefined, artId: card.artId || undefined, name: card.name };

  if (failed) {
    return (
      <div
        className="relative aspect-[5/7] rounded-lg bg-secondary/60 border border-border flex items-center justify-center p-1 cursor-pointer"
        onClick={onClick}
      >
        <span className="text-[9px] text-center text-muted-foreground leading-tight line-clamp-3">{card.name}</span>
        {card.quantity > 1 && <DeckQuantityBadge quantity={card.quantity} />}
      </div>
    );
  }

  return (
    <div className="relative aspect-[5/7] rounded-lg overflow-hidden group cursor-pointer" onClick={onClick}>
      <img
        src={scryfallImageUrl(ref, "normal")}
        alt={card.name}
        className="w-full h-full object-cover transition-transform group-hover:scale-105"
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
      />
      {card.foil && <div className="absolute inset-0 bg-gradient-to-br from-transparent via-white/10 to-transparent pointer-events-none" />}
      {card.quantity > 1 && <DeckQuantityBadge quantity={card.quantity} />}
    </div>
  );
}

function DeckQuantityBadge({ quantity }: { quantity: number }) {
  return (
    <span className="absolute top-1 right-1 bg-black/70 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full leading-none backdrop-blur-sm">
      x{quantity}
    </span>
  );
}

/**
 * NIP magic-deck (kind 37381): the decklist lives in `c` (main) / `b`
 * (sideboard) tags — Scryfall printings — with the commanders in `C`, companion
 * in `S`, format/archetype in `t`, and a `banner`. Ported from Ditto's
 * MagicDeckContent: banner, title, commanders, a badge row, and a text/visual
 * decklist toggle whose tiles open the shared {@link Lightbox} on the card art.
 */
function EmbeddedMagicDeckCard({ event }: { event: NostrRumor }) {
  const tag = (name: string) => event.tags.find(([n]) => n === name)?.[1];
  const all = (name: string) => event.tags.filter(([n]) => n === name).map(([, v]) => v);
  const title = tag("title");
  const banner = sanitizeImageSrc(tag("banner"));
  const commanders = all("C");
  const companion = tag("S");
  const tTags = all("t");

  const mainDeck = useMemo(() => event.tags.filter(([n]) => n === "c").map(parseDeckCard).filter((c): c is DeckCard => c !== null), [event.tags]);
  const sideboard = useMemo(() => event.tags.filter(([n]) => n === "b").map(parseDeckCard).filter((c): c is DeckCard => c !== null), [event.tags]);
  const allCards = useMemo(() => [...mainDeck, ...sideboard], [mainDeck, sideboard]);

  const formatTags = tTags.filter((t) => t in DECK_FORMAT_LABELS);
  const archetypeTags = tTags.filter((t) => t in DECK_ARCHETYPE_LABELS);
  const otherTags = tTags.filter((t) => !(t in DECK_FORMAT_LABELS) && !(t in DECK_ARCHETYPE_LABELS));

  const totalCards = mainDeck.reduce((sum, c) => sum + c.quantity, 0);
  const totalSideboard = sideboard.reduce((sum, c) => sum + c.quantity, 0);

  const [visualView, setVisualView] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  // The Lightbox opens the card art at large size (Scryfall images are plain
  // https URLs, so no decryption ref is needed).
  const lightboxItems = useMemo<LightboxItem[]>(
    () => allCards.map((c) => ({ url: scryfallImageUrl({ setId: c.setId || undefined, artId: c.artId || undefined, name: c.name }, "large"), mime: "image/jpeg" })),
    [allCards],
  );

  const badge = (key: string, tagName: string, variant: "secondary" | "outline", label: string, icon?: ReactNode) => (
    <a key={key} href={dittoHashtagUrl(tagName)} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
      <Badge variant={variant} className="text-[11px] gap-1 font-medium hover:bg-secondary/80 transition-colors">
        {icon}
        {label}
      </Badge>
    </a>
  );

  return (
    <div className="space-y-2 min-w-0">
      {banner && (
        <div className="overflow-hidden rounded-xl empty:hidden">
          <FallbackImage
            src={banner}
            alt={title ?? "Magic deck"}
            className="w-full max-h-[200px] object-cover"
            loading="lazy"
            decoding="async"
          />
        </div>
      )}

      {title && (
        <div className="flex items-start gap-2">
          <CardsIcon className="size-4 text-primary mt-0.5 shrink-0" />
          <span className="text-[15px] font-semibold leading-snug">{title}</span>
        </div>
      )}

      {commanders.length > 0 && (
        <div className="flex items-center gap-2">
          <Shield className="size-3.5 text-muted-foreground shrink-0" />
          <span className="text-xs text-muted-foreground">Commander{commanders.length > 1 ? "s" : ""}:</span>
          <span className="text-xs font-medium truncate">{commanders.join(" & ")}</span>
        </div>
      )}

      {companion && (
        <div className="flex items-center gap-2">
          <Sparkles className="size-3.5 text-muted-foreground shrink-0" />
          <span className="text-xs text-muted-foreground">Companion:</span>
          <span className="text-xs font-medium truncate">{companion}</span>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        {formatTags.map((t) => badge(`f-${t}`, t, "secondary", DECK_FORMAT_LABELS[t] ?? t, <Swords className="size-3" />))}
        {archetypeTags.map((t) => badge(`a-${t}`, t, "outline", DECK_ARCHETYPE_LABELS[t] ?? t))}
        {otherTags.map((t) => badge(`o-${t}`, t, "outline", t))}
        {totalCards > 0 && (
          <Badge variant="secondary" className="text-[11px] gap-1 font-medium">
            <CardsIcon className="size-3" />
            {totalCards} cards
          </Badge>
        )}
        {totalSideboard > 0 && (
          <Badge variant="secondary" className="text-[11px] gap-1 font-medium">{totalSideboard} sideboard</Badge>
        )}
      </div>

      {mainDeck.length > 0 && (
        <div className="rounded-xl border border-border overflow-hidden" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-between px-3 py-1.5 bg-secondary/30 border-b border-border/50">
            <span className="text-[11px] font-medium text-muted-foreground">{visualView ? "Visual spoiler" : "Decklist"}</span>
            <button
              type="button"
              onClick={() => setVisualView((v) => !v)}
              className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors touch:py-1"
            >
              {visualView ? <List className="size-3.5" /> : <Palette className="size-3.5" />}
              {visualView ? "List" : "Visual"}
            </button>
          </div>

          {visualView ? (
            <div className="max-h-[400px] overflow-y-auto p-2">
              <div className="grid grid-cols-4 gap-1.5">
                {mainDeck.map((card, i) => (
                  <DeckCardTile key={`m-${card.name}-${i}`} card={card} onClick={() => setLightboxIndex(i)} />
                ))}
              </div>
              {sideboard.length > 0 && (
                <>
                  <div className="px-1 py-2 mt-1">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Sideboard</span>
                  </div>
                  <div className="grid grid-cols-4 gap-1.5">
                    {sideboard.map((card, i) => (
                      <DeckCardTile key={`s-${card.name}-${i}`} card={card} onClick={() => setLightboxIndex(mainDeck.length + i)} />
                    ))}
                  </div>
                </>
              )}
            </div>
          ) : (
            <div className="max-h-[240px] overflow-y-auto">
              {mainDeck.map((card, i) => (
                <DeckCardRow key={`m-${card.name}-${i}`} card={card} onClick={() => setLightboxIndex(i)} />
              ))}
              {sideboard.length > 0 && (
                <>
                  <div className="px-3 py-1.5 bg-secondary/40 border-y border-border/50">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Sideboard</span>
                  </div>
                  {sideboard.map((card, i) => (
                    <DeckCardRow key={`s-${card.name}-${i}`} card={card} onClick={() => setLightboxIndex(mainDeck.length + i)} />
                  ))}
                </>
              )}
            </div>
          )}
        </div>
      )}

      {lightboxIndex !== null && lightboxItems.length > 0 && (
        <Lightbox
          media={lightboxItems}
          currentIndex={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onNext={() => setLightboxIndex((i) => (i === null ? i : Math.min(lightboxItems.length - 1, i + 1)))}
          onPrev={() => setLightboxIndex((i) => (i === null ? i : Math.max(0, i - 1)))}
        />
      )}
    </div>
  );
}

/** Difficulty/terrain rating pips (filled to `value`, out of `max`). */
function TreasurePips({ value, max = 5 }: { value: number; max?: number }) {
  return (
    <div className="flex gap-0.5">
      {Array.from({ length: max }).map((_, i) => (
        <div key={i} className={cn("size-2 rounded-full", i < value ? "bg-primary" : "bg-muted-foreground/25")} />
      ))}
    </div>
  );
}

/** ROT13 decode (treasure hints are stored rot13-obscured, like a geocache). */
function rot13(str: string): string {
  return str.replace(/[A-Za-z]/g, (c) => {
    const base = c <= "Z" ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
  });
}

const TREASURE_SIZE_LABELS: Record<string, string> = {
  micro: "Micro", small: "Small", regular: "Regular", large: "Large", other: "Other",
};
const TREASURE_TYPE_LABELS: Record<string, string> = {
  traditional: "Traditional", multi: "Multi-cache", mystery: "Mystery",
};

/**
 * NIP treasure / geocache (kind 37516): the cache metadata lives in tags —
 * `name`, difficulty `D` / terrain `T`, size `S`, type `t`, geohash `g`,
 * rot13 `hint`, and `image`s — with the description in `content`. Ported from
 * Ditto's GeocacheContent: name, badge row, D/T pips, description, image
 * gallery, and a reveal-on-tap hint.
 */
function EmbeddedTreasureCard({ event }: { event: NostrRumor }) {
  const tag = (name: string) => event.tags.find(([n]) => n === name)?.[1];
  const all = (name: string) => event.tags.filter(([n]) => n === name).map(([, v]) => v);

  const name = tag("name");
  const difficulty = Number(tag("D") ?? 1) || 1;
  const terrain = Number(tag("T") ?? 1) || 1;
  const size = tag("S") ?? "other";
  const cacheType = tag("t") ?? "traditional";
  const geohash = all("g")
    .reduce<string | undefined>((longest, g) => (longest === undefined || g.length > longest.length ? g : longest), undefined)
    ?.slice(0, 5);
  const hint = tag("hint");
  const description = event.content.trim();

  const items = useMemo<LightboxItem[]>(
    () =>
      all("image")
        .map((u) => sanitizeImageSrc(u))
        .filter((u): u is string => !!u)
        .map((url) => ({ url, mime: "image/jpeg" })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [event.tags],
  );
  const [index, setIndex] = useState<number | null>(null);
  const [hintRevealed, setHintRevealed] = useState(false);
  const decodedHint = useMemo(() => (hint ? rot13(hint) : ""), [hint]);

  return (
    <div className="space-y-2 min-w-0">
      {name && (
        <div className="flex items-start gap-2">
          <ChestIcon className="size-4 text-primary mt-0.5 shrink-0" />
          <span className="text-[15px] font-semibold leading-snug">{name}</span>
        </div>
      )}

      <div className="flex flex-wrap gap-1.5">
        <Badge variant="secondary" className="text-[11px] gap-1 font-medium">{TREASURE_TYPE_LABELS[cacheType] ?? cacheType}</Badge>
        <Badge variant="secondary" className="text-[11px] gap-1 font-medium">
          <Package className="size-3" />
          {TREASURE_SIZE_LABELS[size] ?? size}
        </Badge>
        {geohash && (
          <Badge variant="secondary" className="text-[11px] gap-1 font-medium">
            <MapPin className="size-3" />
            {geohash}
          </Badge>
        )}
      </div>

      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <Brain className="size-3.5 text-muted-foreground shrink-0" />
          <span className="text-xs text-muted-foreground shrink-0">D</span>
          <TreasurePips value={difficulty} />
          <span className="text-xs font-medium tabular-nums">{difficulty}</span>
        </div>
        <div className="flex items-center gap-2">
          <Mountain className="size-3.5 text-muted-foreground shrink-0" />
          <span className="text-xs text-muted-foreground shrink-0">T</span>
          <TreasurePips value={terrain} />
          <span className="text-xs font-medium tabular-nums">{terrain}</span>
        </div>
      </div>

      {description && (
        <p className="text-sm leading-relaxed text-foreground/90 line-clamp-4 break-words">{description}</p>
      )}

      {items.length > 0 && (
        <div
          className={cn("grid gap-1 overflow-hidden rounded-xl", items.length > 1 ? "grid-cols-2" : "grid-cols-1")}
          onClick={(e) => e.stopPropagation()}
        >
          {items.slice(0, 4).map((item, i) => (
            <div key={item.url} className="relative">
              <PreviewImage
                item={item}
                onClick={() => setIndex(i)}
                className={cn(items.length > 1 ? "aspect-square" : "max-h-[260px] aspect-video")}
              />
              {items.length > 4 && i === 3 && (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/50 text-lg font-semibold text-white">
                  +{items.length - 4}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {hint && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setHintRevealed((v) => !v); }}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors touch:py-1"
        >
          {hintRevealed ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
          {hintRevealed ? decodedHint : "Show hint"}
        </button>
      )}

      {index !== null && items.length > 0 && (
        <Lightbox
          media={items}
          currentIndex={index}
          onClose={() => setIndex(null)}
          onNext={() => setIndex((i) => (i === null ? i : Math.min(items.length - 1, i + 1)))}
          onPrev={() => setIndex((i) => (i === null ? i : Math.max(0, i - 1)))}
        />
      )}
    </div>
  );
}

/**
 * Tag-driven preview card for a non-note kind whose body is JSON, a media
 * manifest, or Markdown (article, listing, publication, badge, podcast, music,
 * …). Reads title/summary/cover from tags rather than tokenizing content the
 * kind-1 renderer would mangle. Kinds with a real renderer (photos, videos,
 * polls, calendar events, zaps, magic decks, treasures) are dispatched BEFORE
 * reaching here, so this is the long-tail fallback.
 */
function TagPreviewCard({ event, meta }: { event: NostrRumor; meta: KindMeta }) {
  const tag = (name: string) => event.tags.find(([n]) => n === name)?.[1];
  const title = tag("title") || tag("name") || tag("subject");
  const summary = tag("summary") || tag("description");
  const Icon = meta.Icon;

  // A poster from imeta (podcasts/music carry artwork there) — never the imeta
  // `url`, which for an audio kind is the audio blob, not an image.
  const imeta = useMemo(() => parseImetaMap(event.tags), [event.tags]);
  const posterFromImeta = useMemo(() => {
    for (const e of imeta.values()) {
      const u = sanitizeImageSrc(e.thumbnail);
      if (u) return u;
    }
    return undefined;
  }, [imeta]);
  const cover = sanitizeImageSrc(tag("image") || tag("cover") || tag("thumb")) ?? posterFromImeta;

  return (
    <div className="space-y-1.5 min-w-0">
      {title && <p className="text-sm font-semibold leading-snug line-clamp-2">{title}</p>}

      {cover && (
        <div className="overflow-hidden rounded-xl">
          <img
            src={cover}
            alt=""
            className="w-full max-h-[220px] object-cover"
            loading="lazy"
            onError={(e) => {
              (e.currentTarget.parentElement as HTMLElement).style.display = "none";
            }}
          />
        </div>
      )}

      {summary && (
        <p className="text-xs text-muted-foreground leading-relaxed line-clamp-3">{summary}</p>
      )}

      {/* When nothing above surfaced, at least name the kind so the card isn't
          an empty shell. */}
      {!title && !summary && !cover && (
        <div className="flex items-center gap-2 py-1 text-muted-foreground">
          {Icon && <Icon className="size-4 shrink-0" />}
          <span className="text-sm font-medium">{meta.label}</span>
        </div>
      )}
    </div>
  );
}

/** Height at which an embedded event body collapses behind a "Show more". */
const EMBED_MAX_HEIGHT = 260;

/**
 * Height-capped body for a quoted/embedded event. Measures the rendered
 * content and, when it overflows {@link EMBED_MAX_HEIGHT}, clamps it with a
 * fade-out and a "Show more"/"Show less" toggle — so a long quoted note gets
 * an expander rather than the old hard `overflow-hidden` clip that silently
 * dropped everything past 64 units of height. Short bodies render untouched
 * with no toggle.
 *
 * The renderer inside can't provide its own expander (embeds always pass
 * `disableNoteEmbeds`, which disables `ChatContent`'s own collapse), so the
 * height governance lives here at the card level.
 */
function EmbedTruncatedBody({ children }: { children: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const innerRef = useRef<HTMLDivElement>(null);

  const measure = useCallback(() => {
    const el = innerRef.current;
    if (el) setOverflowing(el.scrollHeight > EMBED_MAX_HEIGHT + 1);
  }, []);

  // Re-measure after layout: media and mention names resolve asynchronously
  // and change whether the body overflows.
  const measureRef = useCallback((el: HTMLDivElement | null) => {
    innerRef.current = el;
    if (el) requestAnimationFrame(measure);
  }, [measure]);

  return (
    <div className="min-w-0">
      <div
        ref={measureRef}
        className={cn("relative min-w-0 overflow-hidden", !expanded && "transition-[max-height] duration-200")}
        style={{ maxHeight: expanded ? undefined : EMBED_MAX_HEIGHT }}
        onLoad={measure}
      >
        {children}
        {!expanded && overflowing && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-background to-transparent" />
        )}
      </div>
      {overflowing && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
          className="mt-0.5 text-xs touch:text-sm font-semibold text-primary hover:underline touch:py-1"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

/**
 * Favicon + hostname chip shown when an embedded event card was unfolded from
 * a link on another host (e.g. an `njump.me/nevent1…` URL pasted into chat).
 * Clicking it opens the original source. Renders nothing when there is no
 * source URL, or when it's same-host/invalid (`externalUrl`).
 *
 * A ditto.pub source is suppressed on purpose: the card already carries a
 * "View on Ditto" off-ramp footer, so a second chip pointing at the same host
 * would be redundant.
 */
function SourceLink({ url }: { url: string | undefined }) {
  const safe = externalUrl(url);
  if (!safe || displayHost(safe) === "ditto.pub") return null;
  const favicon = faviconUrl(safe);

  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void openUrl(safe);
      }}
      className={cn(
        "mt-0.5 flex items-center gap-1 max-w-full min-w-0 px-2 py-0.5 rounded-full",
        "text-xs text-muted-foreground hover:bg-primary/10 hover:text-primary transition-colors",
      )}
    >
      {favicon
        ? <img src={favicon} alt="" className="size-3.5 shrink-0 rounded-sm object-contain" loading="lazy" />
        : <ExternalLink className="size-3 shrink-0" />}
      <span className="truncate">{displayHost(safe)}</span>
    </button>
  );
}

/**
 * "View on Ditto" off-ramp — a small primary-tinted link appended to an
 * embedded event card so readers can jump to the full social thread on
 * ditto.pub (images, quotes, zaps, replies) that Armada doesn't render.
 */
function DittoLink({ href, label = "View on Ditto" }: { href: string; label?: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-primary transition-colors"
    >
      <DittoIcon className="size-3.5 shrink-0" />
      <span>{label}</span>
      <ExternalLink className="size-3 shrink-0" />
    </a>
  );
}

/**
 * Copy-ID affordance — a small "file digit" icon button in the card's
 * lower-right corner. Clicking copies the event's NIP-21 `nostr:` URI so the
 * reader can paste it into any client. Preferred over a `nostr:` href, which
 * only navigates when the OS/browser has a scheme handler registered.
 */
function CopyIdButton({ uri, className }: { uri: string; className?: string }) {
  const [copied, setCopied] = useState(false);

  const copy = (e: React.MouseEvent) => {
    e.stopPropagation();
    writeClipboardText(uri).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
        toast({ title: "Copied event ID" });
      },
      () => toast({ title: "Couldn't copy event ID", variant: "destructive" }),
    );
  };

  return (
    <button
      type="button"
      onClick={copy}
      title="Copy event ID"
      aria-label="Copy event ID"
      className={cn(
        "shrink-0 grid place-items-center size-6 touch:size-8 -mr-1 -mb-0.5 rounded-md",
        "text-muted-foreground hover:text-primary hover:bg-secondary transition-colors",
        className,
      )}
    >
      {copied
        ? <Check className="size-3.5 shrink-0" />
        : <FileDigit className="size-3.5 shrink-0" />}
    </button>
  );
}

function EmbeddedNoteSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn("max-w-md rounded-2xl border border-border overflow-hidden my-1.5", className)}>
      <div className="px-3 py-2.5 space-y-2">
        <div className="flex items-center gap-2">
          <Skeleton className="size-5 rounded-full shrink-0" />
          <Skeleton className="h-3.5 w-24" />
          <Skeleton className="h-3 w-10" />
        </div>
        <div className="space-y-1.5">
          <Skeleton className="h-3.5 w-full" />
          <Skeleton className="h-3.5 w-4/5" />
        </div>
      </div>
    </div>
  );
}

function EmbeddedNoteTombstone({ eventId, className }: { eventId: string; className?: string }) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 max-w-md rounded-2xl border border-dashed border-border px-3.5 py-4 my-1.5 text-muted-foreground",
        className,
      )}
    >
      <FileQuestion className="size-4 shrink-0" />
      <span className="text-sm truncate">Couldn't load event {eventId.slice(0, 12)}…</span>
    </div>
  );
}
