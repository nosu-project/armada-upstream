import {
  Award, Brain, CalendarDays, Check, Eye, EyeOff, ExternalLink, FileDigit,
  FileQuestion, FileText, Film, Gem, Image as ImageIcon, Layers, List, MapPin,
  Mic, Mountain, Music, Package, Palette, RotateCw, Server, Shield, Sparkles, Swords,
  Tag, User, Users, Zap,
} from "lucide-react";
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
import { ThemeDiscoverCard } from "@/components/discover/ThemeDiscoverCard";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { FallbackImage } from "@/components/ui/FallbackImage";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { publicRelayHints, useAddrEvent, useEvent, type AddrCoords } from "@/hooks/useEvent";
import { useAuthor } from "@/hooks/useAuthor";
import { useMediaWithFallback } from "@/hooks/useMediaWithFallback";
import { toast } from "@/hooks/useToast";
import { getAvatarShape } from "@/lib/avatarShape";
import { parseCalendarEvent, type RsvpTally } from "@/lib/calendar";
import { writeClipboardText } from "@/lib/clipboard";
import { getCustomEmojiUrl, isCustomEmoji, isRenderableReactionKey } from "@/lib/customEmoji";
import { dittoEventUrl, dittoHashtagUrl, dittoNip19Url } from "@/lib/dittoUrl";
import { faviconUrl } from "@/lib/faviconUrl";
import { shortTimeAgo } from "@/lib/formatTime";
import { getDisplayName } from "@/lib/getDisplayName";
import { parseImetaMap } from "@/lib/imeta";
import { scryfallImageUrl, type CardRef } from "@/lib/scryfall";
import { tryNaddrEncode, tryNeventEncode } from "@/lib/safeNip19";
import { displayHost, externalUrl, sanitizeImageSrc } from "@/lib/sanitizeUrl";
import { openUrl } from "@/lib/share";
import { THEME_DEFINITION_KIND, parseDittoTheme } from "@/lib/themeEvent";
import { cn } from "@/lib/utils";
import { formatSats, receiptAmountSats, receiptZapRequest } from "@/lib/zaps";

import type { NostrRumor } from "@/lib/nostrRumor";
import type { PollTally } from "@/lib/polls";

interface EmbeddedNoteProps {
  eventId: string;
  /** Optional relay hints from the nevent1 identifier. */
  relays?: string[];
  /** Optional author pubkey hint from the nevent1 identifier. */
  authorHint?: string;
  /** Original URL when unfolded from another host's link (njump.me/nevent1…); shown as a source chip. */
  sourceUrl?: string;
  /** Quoting message's author, whose outbox is searched when the id names no author. */
  fallbackAuthor?: string;
  className?: string;
}

/** Label + icon for a kind rendered as a compact preview card. */
interface KindMeta {
  label: string;
  Icon?: ComponentType<{ className?: string }>;
}

/**
 * Kinds rendered as a tag-based preview card (their content is JSON, Markdown
 * or a media manifest). Text-note kinds render through {@link ChatContent};
 * reactions, polls and emoji packs have dedicated branches.
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

/** NIP-68 photo kinds (images in imeta). */
const PHOTO_KINDS = new Set([20]);
/** NIP-71 video kinds + vines (media in imeta). */
const VIDEO_KINDS = new Set([21, 22, 34236]);

/**
 * NIP-21 `nostr:` URI: `naddr` for addressable events, else `nevent` with the
 * author hint. Undefined for malformed id/pubkey.
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

export function EmbeddedNote({ eventId, relays, authorHint, sourceUrl, fallbackAuthor, className }: EmbeddedNoteProps) {
  const hints = useMemo(() => publicRelayHints(relays), [relays]);
  const { data: event, isLoading, isFetching, refetch } = useEvent(eventId, hints, authorHint, {
    fallbackAuthor,
    discover: true,
  });
  const nevent = useMemo(
    () => tryNeventEncode({
      id: eventId,
      ...(authorHint ? { author: authorHint } : {}),
      ...(relays?.length ? { relays } : {}),
    }),
    [eventId, authorHint, relays],
  );

  if (isLoading) {
    return <EmbeddedNoteSkeleton className={className} />;
  }

  if (!event) {
    return (
      <EmbeddedNoteTombstone
        label={eventId}
        nip19Id={nevent}
        retrying={isFetching}
        onRetry={refetch}
        className={className}
      />
    );
  }

  return <EmbeddedEventCard event={event} sourceUrl={sourceUrl} className={className} />;
}

export function EmbeddedNaddr({ addr, relays, className }: { addr: AddrCoords; relays?: string[]; className?: string }) {
  const hints = useMemo(() => publicRelayHints(relays), [relays]);
  const { data: event, isLoading, isFetching, refetch } = useAddrEvent(addr, hints);
  const naddr = useMemo(
    () => tryNaddrEncode({ ...addr, ...(relays?.length ? { relays } : {}) }),
    [addr, relays],
  );

  if (isLoading) {
    return <EmbeddedNoteSkeleton className={className} />;
  }

  if (!event) {
    return (
      <EmbeddedNoteTombstone
        label={naddr ?? addr.identifier}
        nip19Id={naddr}
        retrying={isFetching}
        onRetry={refetch}
        className={className}
      />
    );
  }

  return <EmbeddedEventCard event={event} className={className} />;
}

/** Shared card body for any resolved event, modeled on Ditto's NoteCard. */
export function EmbeddedEventCard({ event, sourceUrl, className }: { event: NostrRumor; sourceUrl?: string; className?: string }) {
  // NIP-30 emoji packs: emojis live in tags, content is empty.
  if (event.kind === 30030) {
    return <EmojiPackCard event={event} className={className} />;
  }
  // An unparseable theme keeps the generic body.
  if (event.kind === THEME_DEFINITION_KIND && parseDittoTheme(event)) {
    return <ThemeDiscoverCard event={event} className={cn("max-w-sm my-1.5", className)} />;
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

  const reactionEmoji = event.kind === 7
    ? (event.content === "+" || event.content === "" ? "👍" : event.content === "-" ? "👎" : event.content)
    : null;

  const dittoHref = dittoEventUrl(event);
  const nostrUri = eventNostrUri(event);
  // A source from another host takes the footer's lead slot; ditto.pub doesn't
  // count (it's the DittoLink off-ramp already).
  const safeSource = externalUrl(sourceUrl);
  const externalSource = safeSource && displayHost(safeSource) !== "ditto.pub" ? safeSource : undefined;

  return (
    <div
      className={cn(
        "group block max-w-md w-full clip-hairline-lg [--edge:var(--border)/0.5] [--fill:var(--background)/0.4] [--fill-hover:var(--secondary)/0.4] overflow-hidden my-1.5",
        className,
      )}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="px-3 py-2 space-y-1 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <ProfilePreviewCard pubkey={event.pubkey}>
            <button type="button" className="shrink-0" onClick={(e) => e.stopPropagation()}>
              <Avatar shape={getAvatarShape(metadata)} className="size-5">
                <AvatarImage src={metadata?.picture} imeta={author.data?.imeta?.picture} alt={displayName} />
                <AvatarFallback className="bg-primary/20 text-primary text-3xs">
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
            <span className="text-3xs px-1.5 py-px rounded-full bg-secondary text-muted-foreground shrink-0">
              {label}
            </span>
          )}

          <span className="text-xs text-muted-foreground shrink-0">
            · {shortTimeAgo(event.created_at)}
          </span>
        </div>

        {/* Dispatched by kind; real renderers where the timeline has them, else a tag preview or note text. */}
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

        {(dittoHref || nostrUri || externalSource) && (
          <div className="mt-0.5 flex items-center gap-2 min-w-0">
            {externalSource ? (
              <SourceLink url={externalSource} />
            ) : (
              dittoHref && <DittoLink href={dittoHref} />
            )}
            <div className="ml-auto flex items-center gap-1 shrink-0">
              {externalSource && dittoHref && <DittoLink href={dittoHref} iconOnly />}
              {nostrUri && <CopyIdButton uri={nostrUri} />}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * NIP-88 poll via the timeline's {@link PollView}, read-only (empty tally,
 * `canVote={false}`). PollView reads only tags, so the question is shown above.
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

/** NIP-52 calendar event via {@link CalendarEventMessageCard}, read-only; tag preview if unparseable. */
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
 * Zap receipt (9735) / on-chain zap (8333). Only a verified amount is shown;
 * otherwise a bare "Zap".
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

/** Media thumbnail resolved/decrypted like the timeline; opens the shared {@link Lightbox}. */
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

/** NIP-68 picture post (kind 20); tag preview when no imeta media resolves. */
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

/** NIP-71 video (21/22/34236) via {@link VideoPlayer}; tag preview when no imeta media resolves. */
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

const DECK_FORMAT_LABELS: Record<string, string> = {
  standard: "Standard", modern: "Modern", commander: "Commander", legacy: "Legacy",
  vintage: "Vintage", pioneer: "Pioneer", pauper: "Pauper", cedh: "cEDH",
  limited: "Limited", draft: "Draft", sealed: "Sealed", brawl: "Brawl",
  historic: "Historic", explorer: "Explorer", alchemy: "Alchemy", timeless: "Timeless",
};
const DECK_ARCHETYPE_LABELS: Record<string, string> = {
  aggro: "Aggro", midrange: "Midrange", control: "Control", combo: "Combo",
  tempo: "Tempo", ramp: "Ramp", tribal: "Tribal", burn: "Burn", mill: "Mill",
  stax: "Stax", tokens: "Tokens", reanimator: "Reanimator", voltron: "Voltron",
  aristocrats: "Aristocrats",
};

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
        <span className="text-3xs text-muted-foreground uppercase tracking-wider shrink-0 ml-2">{card.setId}</span>
      )}
    </div>
  );
}

function DeckCardTile({ card, onClick }: { card: DeckCard; onClick?: () => void }) {
  const [failed, setFailed] = useState(false);
  const ref: CardRef = { setId: card.setId || undefined, artId: card.artId || undefined, name: card.name };

  if (failed) {
    return (
      <div
        className="aspect-[5/7] clip-hairline-lg [--edge:var(--border)/0.5] [--fill:var(--secondary)/0.6] [--fill-hover:var(--secondary)/0.6] flex items-center justify-center p-1 cursor-pointer"
        onClick={onClick}
      >
        <span className="text-3xs text-center text-muted-foreground leading-tight line-clamp-3">{card.name}</span>
        {card.quantity > 1 && <DeckQuantityBadge quantity={card.quantity} />}
      </div>
    );
  }

  return (
    <div className="relative aspect-[5/7] clip-corner-lg overflow-hidden group cursor-pointer" onClick={onClick}>
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
    <span className="absolute top-1 right-1 bg-black/70 text-white text-3xs font-bold px-1.5 py-0.5 rounded-full leading-none backdrop-blur-sm">
      x{quantity}
    </span>
  );
}

/**
 * Magic deck (kind 37381): `c` main / `b` sideboard (Scryfall printings), `C`
 * commanders, `S` companion, `t` format/archetype, `banner`. Ported from
 * Ditto's MagicDeckContent.
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

  const lightboxItems = useMemo<LightboxItem[]>(
    () => allCards.map((c) => ({ url: scryfallImageUrl({ setId: c.setId || undefined, artId: c.artId || undefined, name: c.name }, "large"), mime: "image/jpeg" })),
    [allCards],
  );

  const badge = (key: string, tagName: string, variant: "secondary" | "outline", label: string, icon?: ReactNode) => (
    <a key={key} href={dittoHashtagUrl(tagName)} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
      <Badge variant={variant} className="text-2xs gap-1 font-medium hover:bg-secondary/80 transition-colors">
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
          <span className="text-chat font-semibold leading-snug">{title}</span>
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
          <Badge variant="secondary" className="text-2xs gap-1 font-medium">
            <CardsIcon className="size-3" />
            {totalCards} cards
          </Badge>
        )}
        {totalSideboard > 0 && (
          <Badge variant="secondary" className="text-2xs gap-1 font-medium">{totalSideboard} sideboard</Badge>
        )}
      </div>

      {mainDeck.length > 0 && (
        <div className="clip-hairline-lg [--edge:var(--border)/0.5] [--fill:var(--background)/0.4] [--fill-hover:var(--background)/0.4] overflow-hidden" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-between px-3 py-1.5 bg-secondary/30 border-b border-border/50">
            <span className="text-2xs font-medium text-muted-foreground">{visualView ? "Visual spoiler" : "Decklist"}</span>
            <button
              type="button"
              onClick={() => setVisualView((v) => !v)}
              className="flex items-center gap-1 text-2xs text-muted-foreground hover:text-foreground transition-colors touch:py-1"
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
                    <span className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">Sideboard</span>
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
                    <span className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">Sideboard</span>
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

function TreasurePips({ value, max = 5 }: { value: number; max?: number }) {
  return (
    <div className="flex gap-0.5">
      {Array.from({ length: max }).map((_, i) => (
        <div key={i} className={cn("size-2 rounded-full", i < value ? "bg-primary" : "bg-muted-foreground/25")} />
      ))}
    </div>
  );
}

/** Treasure hints are rot13-obscured, like a geocache. */
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
 * Treasure/geocache (kind 37516): `name`, difficulty `D`, terrain `T`, size `S`,
 * type `t`, geohash `g`, rot13 `hint`, `image`s; description in content.
 * Ported from Ditto's GeocacheContent.
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
          <span className="text-chat font-semibold leading-snug">{name}</span>
        </div>
      )}

      <div className="flex flex-wrap gap-1.5">
        <Badge variant="secondary" className="text-2xs gap-1 font-medium">{TREASURE_TYPE_LABELS[cacheType] ?? cacheType}</Badge>
        <Badge variant="secondary" className="text-2xs gap-1 font-medium">
          <Package className="size-3" />
          {TREASURE_SIZE_LABELS[size] ?? size}
        </Badge>
        {geohash && (
          <Badge variant="secondary" className="text-2xs gap-1 font-medium">
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

/** Long-tail fallback: title/summary/cover from tags, never the raw content. */
function TagPreviewCard({ event, meta }: { event: NostrRumor; meta: KindMeta }) {
  const tag = (name: string) => event.tags.find(([n]) => n === name)?.[1];
  const title = tag("title") || tag("name") || tag("subject");
  const summary = tag("summary") || tag("description");
  const Icon = meta.Icon;

  // Never the imeta `url`: for audio kinds that's the audio blob.
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
          <FallbackImage
            src={cover}
            alt=""
            className="w-full max-h-[220px] object-cover"
            loading="lazy"
          />
        </div>
      )}

      {summary && (
        <p className="text-xs text-muted-foreground leading-relaxed line-clamp-3">{summary}</p>
      )}

      {/* Name the kind so the card isn't an empty shell. */}
      {!title && !summary && !cover && (
        <div className="flex items-center gap-2 py-1 text-muted-foreground">
          {Icon && <Icon className="size-4 shrink-0" />}
          <span className="text-sm font-medium">{meta.label}</span>
        </div>
      )}
    </div>
  );
}

const EMBED_MAX_HEIGHT = 260;

/**
 * Clamp an embedded body with fade + "Show more" when it overflows
 * {@link EMBED_MAX_HEIGHT}. Lives here since embeds disable `ChatContent`'s collapse.
 */
function EmbedTruncatedBody({ children }: { children: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const innerRef = useRef<HTMLDivElement>(null);

  const measure = useCallback(() => {
    const el = innerRef.current;
    if (el) setOverflowing(el.scrollHeight > EMBED_MAX_HEIGHT + 1);
  }, []);

  // Re-measure as media and mention names resolve.
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
 * "View on <host>" off-ramp for cards unfolded from another host's link.
 * Renders nothing for same-host/invalid URLs or ditto.pub (DittoLink covers it).
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
      className="inline-flex items-center gap-1.5 min-w-0 text-xs text-muted-foreground hover:text-primary transition-colors"
    >
      {favicon
        ? <img src={favicon} alt="" className="size-3.5 shrink-0 rounded-sm object-contain" loading="lazy" />
        : <ExternalLink className="size-3 shrink-0" />}
      <span className="truncate">View on {displayHost(safe)}</span>
      <ExternalLink className="size-3 shrink-0" />
    </button>
  );
}

/** "View on Ditto" off-ramp; `iconOnly` when a source link holds the lead slot. */
function DittoLink({ href, label = "View on Ditto", iconOnly = false }: { href: string; label?: string; iconOnly?: boolean }) {
  if (iconOnly) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        title={label}
        aria-label={label}
        className={cn(
          "shrink-0 grid place-items-center size-6 touch:size-8 clip-corner-lg",
          "text-muted-foreground hover:text-primary hover:bg-secondary transition-colors",
        )}
      >
        <DittoIcon className="size-3.5 shrink-0" />
      </a>
    );
  }

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

/** Copies the NIP-21 URI (a `nostr:` href only works with a registered scheme handler). */
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
        "shrink-0 grid place-items-center size-6 touch:size-8 -mr-1 -mb-0.5 clip-corner-lg",
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
    <div className={cn("max-w-md clip-hairline-lg [--edge:var(--border)/0.5] [--fill:var(--background)/0.4] [--fill-hover:var(--background)/0.4] overflow-hidden my-1.5", className)}>
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

/** Unfound event: keeps the off-ramps plus a retry of the full lookup. */
function EmbeddedNoteTombstone({ label, nip19Id, retrying, onRetry, className }: {
  label: string;
  /** Hints included; undefined when the id is malformed. */
  nip19Id?: string;
  retrying: boolean;
  onRetry: () => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "max-w-md w-full clip-corner-lg bg-secondary/20 px-3 py-2 my-1.5 space-y-1 text-muted-foreground",
        className,
      )}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-2 min-w-0 py-1">
        <FileQuestion className="size-4 shrink-0" />
        <span className="text-sm truncate">Couldn't load event {label.slice(0, 12)}…</span>
      </div>
      <div className="flex items-center gap-2 min-w-0">
        {nip19Id && <DittoLink href={dittoNip19Url(nip19Id)} />}
        <div className="ml-auto flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRetry();
            }}
            disabled={retrying}
            title="Retry"
            aria-label="Retry"
            className={cn(
              "shrink-0 grid place-items-center size-6 touch:size-8 clip-corner-lg",
              "text-muted-foreground hover:text-primary hover:bg-secondary transition-colors disabled:opacity-60",
            )}
          >
            <RotateCw className={cn("size-3.5 shrink-0", retrying && "animate-spin")} />
          </button>
          {nip19Id && <CopyIdButton uri={`nostr:${nip19Id}`} />}
        </div>
      </div>
    </div>
  );
}
