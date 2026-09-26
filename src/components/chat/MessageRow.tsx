import { Reply } from "lucide-react";
import { memo, useEffect, useState } from "react";

import { ExpirationTimerIcon } from "@/components/chat/ExpirationTimerIcon";
import { MeshProfilePreviewCard } from "@/components/chat/MeshProfilePreviewCard";
import { ProfilePreviewCard } from "@/components/chat/ProfilePreviewCard";
import { BotPill } from "@/components/BotPill";
import { DisplayName } from "@/components/DisplayName";
import { ProxyPill } from "@/components/ProxyPill";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { useAuthor } from "@/hooks/useAuthor";
import { useScopedIdentity } from "@/hooks/useScopedDisplayName";
import { getAvatarShape } from "@/lib/avatarShape";
import { shortClockTime, shortTimeAgo } from "@/lib/formatTime";
import { formatTimeLeft } from "@/lib/nip17/disappearing";
import { cn } from "@/lib/utils";
import { useLongPress } from "@/hooks/useLongPress";
import { useSwipeToReply } from "@/hooks/useSwipeToReply";

import type { ProxyInfo } from "@/lib/nip48";
import type { ReactNode } from "react";

const NO_TAGS: string[][] = [];

/**
 * An explicit display identity for a message author, used by surfaces whose
 * authors are NOT Nostr identities (the Bluetooth mesh). When supplied,
 * MessageRow renders this directly and skips the kind-0 author lookup and
 * server-scoped profile resolution entirely (no wasted relay queries, no
 * "Anonymous" fallback for a non-pubkey author key).
 */
export interface MessageIdentity {
  /** Name to display. */
  name: string;
  /** Username color (CSS color), or undefined for the default. */
  color?: string;
  /** A muted suffix shown after the name (e.g. a mesh `#abcd` disambiguator). */
  suffix?: string;
}

/** Below this much time left, the countdown is spelled out beside the icon. */
const EXPIRY_URGENT_SECS = 60 * 60;

/**
 * Signal's disappearing-message clock on any message carrying a NIP-40
 * `expiration`: a live timer face that empties as the deadline approaches
 * ({@link ExpirationTimerIcon} owns that animation and its own scheduling).
 *
 * The face alone carries the fact for most of a message's life — a "30d"
 * countdown on every row would be noise — and the remaining time is spelled out
 * only in the last hour, when it's what the reader actually wants. The tooltip
 * always has it.
 *
 * Header rows only. A run of messages from one author expires as a run (the
 * deadline is send time plus one shared timer), so the clock on the run's first
 * row already states the fact for all of them; repeating it on every
 * continuation only added a floating glyph in the right margin.
 *
 * This wrapper's own timer exists purely for that TEXT: once a second in the
 * final minute, twice a minute below an hour, and otherwise a single timeout
 * armed for the moment the label appears at all.
 */
function ExpirationClock({ createdAt, expiresAt }: { createdAt: number; expiresAt: number }) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    const left = expiresAt - Math.floor(Date.now() / 1000);
    if (left <= 0) return;
    const delayMs =
      left <= 60 ? 1000 : left <= EXPIRY_URGENT_SECS ? 30_000 : (left - EXPIRY_URGENT_SECS) * 1000;
    // setTimeout's delay is a 32-bit int; a longer wait re-arms on the next tick.
    const id = setTimeout(() => setNow(Math.floor(Date.now() / 1000)), Math.min(delayMs, 2 ** 31 - 1));
    return () => clearTimeout(id);
  }, [expiresAt, now]);

  const left = expiresAt - now;
  const label = formatTimeLeft(expiresAt, now);
  return (
    <span
      className="inline-flex items-center gap-0.5 shrink-0 text-[10px] text-muted-foreground/60 tabular-nums"
      title={`Disappears in ${label}`}
      role="img"
      aria-label={`Disappearing message, ${label} left`}
    >
      <ExpirationTimerIcon createdAt={createdAt} expiresAt={expiresAt} />
      {left <= EXPIRY_URGENT_SECS && <span>{label}</span>}
    </span>
  );
}

interface MessageRowProps {
  /** Author of the message; drives the avatar, display name and profile card. */
  pubkey: string;
  /**
   * Explicit author identity (mesh peers). When set, the avatar/name come from
   * this instead of a Nostr profile lookup, and the profile-preview card is
   * suppressed (there's no Nostr profile behind a mesh peer).
   */
  identityOverride?: MessageIdentity;
  /**
   * Mesh-only: makes the avatar/name a click-triggered `MeshProfilePreviewCard`
   * (with Message/Mention actions) instead of plain text. Requires
   * `identityOverride` to be set. `peerID` is the author's mesh peer id (the
   * row's `pubkey`); `onMessage`/`onMention` wire the popover's actions and
   * `isSelf` hides them for our own messages.
   */
  meshActions?: {
    peerID: string;
    isSelf?: boolean;
    onMessage?: (peerID: string) => void;
    onMention?: (peerID: string) => void;
  };
  /** Unix-seconds creation time, rendered as a short relative timestamp. */
  createdAt: number;
  /** The message body (rich content, poll, /me action, edit field, …). */
  children: ReactNode;
  /** Whether to show the spinning "sending" indicator next to the name. */
  pending?: boolean;
  /** Whether to show an "(edited)" marker next to the timestamp. */
  edited?: boolean;
  /**
   * NIP-40 deadline (unix seconds) for a disappearing message. When set, a
   * timer glyph + countdown renders beside the timestamp on the header row
   * (ignored on `continuation` rows, which have no header). Absent on messages
   * with no `expiration` tag — a reader can't tell whether a client that
   * ignored the tag kept a copy, so the clock only ever claims what the
   * message itself says.
   */
  expiresAt?: number;
  /**
   * A small badge rendered next to the author's name (after the bot pill) —
   * e.g. the DM page's "NIP-04" legacy-encryption marker. Hidden on
   * continuation rows (no header line).
   */
  nameBadge?: ReactNode;
  /**
   * NIP-48 origin of a bridged message, shown as a pill next to the bot pill.
   * Absent on messages that weren't bridged.
   */
  proxy?: ProxyInfo | null;
  /**
   * Extra controls rendered right-aligned on the header row (action toolbar).
   * Mounted lazily — the node is only rendered once the row is first hovered or
   * focused, so passing it costs nothing on rows the reader never touches.
   */
  actions?: ReactNode;
  /** Extra content rendered above the body (e.g. a reply-context line). */
  beforeBody?: ReactNode;
  /** Extra content rendered below the body (reactions, reply count, errors). */
  afterBody?: ReactNode;
  /**
   * Render as a continuation of the previous message from the same author:
   * hides the avatar/name/timestamp header and tightens spacing, showing only
   * a hover-revealed clock time in the avatar gutter.
   */
  continuation?: boolean;
  className?: string;
  /** Forwarded to the row container (data attrs, handlers). */
  containerProps?: React.HTMLAttributes<HTMLDivElement>;
  /**
   * Swipe-to-reply callback. When set, a swipe-LEFT gesture on touch devices
   * calls this (wired to `onReply` in ChatMessage). Ignored on desktop.
   * Leftward on purpose: a rightward swipe anywhere on the chat pane is the
   * SwipeReveal "leave room" gesture, so direction alone disambiguates intent.
   */
  onSwipeReply?: () => void;
  /**
   * Press-and-hold callback for touch devices, wired to the message action
   * sheet. Presses that start on an interactive child (a link, a reaction
   * pill, the avatar) are ignored so those keep their own gestures, and a
   * press that turns into a scroll or a swipe cancels.
   */
  onLongPress?: () => void;
}

/**
 * Shared presentational shell for a single chat message: a flat, Discord-style
 * row with a per-message avatar, the author's name, a relative timestamp and a
 * body slot. Used by both group chat (`ChatMessage`) and direct messages so the
 * two render identically.
 */
export const MessageRow = memo(function MessageRow({
  pubkey,
  identityOverride,
  meshActions,
  createdAt,
  children,
  pending,
  edited,
  expiresAt,
  nameBadge,
  proxy,
  actions,
  beforeBody,
  afterBody,
  continuation,
  className,
  containerProps,
  onSwipeReply,
  onLongPress,
}: MessageRowProps) {
  const longPress = useLongPress(onLongPress);
  // The floated action toolbar is invisible until the row is hovered or
  // focused, but mounting it costs a reaction picker, an overflow menu and half
  // a dozen tooltip roots — per row, times every row in the window. So it is
  // not built until the pointer (or focus) actually arrives. Latched on: once a
  // row has been visited, keeping its toolbar mounted is cheaper than
  // rebuilding it every time the pointer passes back over.
  const [actionsArmed, setActionsArmed] = useState(false);
  const armActions = actions ? () => setActionsArmed(true) : undefined;
  // Mesh authors carry an explicit identity; skip the Nostr author/profile
  // lookups entirely for them (the pubkey is a mesh peer id, not a real key).
  const author = useAuthor(identityOverride ? undefined : pubkey);
  const metadata = author.data?.metadata;
  // The byline hands DisplayName and BotPill what it already resolved, so
  // neither subscribes a lookup of its own.
  const scoped = useScopedIdentity(identityOverride ? undefined : pubkey, metadata);
  const displayName = identityOverride?.name ?? scoped.displayName;
  const color = identityOverride?.color ?? scoped.color;
  const label = identityOverride ? undefined : scoped.label;
  const suffix = identityOverride?.suffix;

  // Swipe-to-reply: only active when `onSwipeReply` is set (touch devices).
  const swipe = useSwipeToReply(
    () => onSwipeReply?.(),
    Boolean(onSwipeReply),
  );

  // For mesh authors there's no Nostr profile to preview — render the avatar/
  // name as plain (non-interactive) elements rather than profile-card triggers.
  const avatar = (
    <Avatar shape={getAvatarShape(metadata)} className="size-10">
      <AvatarImage src={metadata?.picture} alt={displayName} />
      <AvatarFallback
        className="text-sm"
        style={color ? { backgroundColor: `${color}33`, color } : undefined}
      >
        {displayName[0]?.toUpperCase()}
      </AvatarFallback>
    </Avatar>
  );

  return (
    <div
      {...containerProps}
      {...(onSwipeReply ? swipe.touchHandlers : undefined)}
      {...longPress}
      onPointerEnter={(e) => {
        armActions?.();
        containerProps?.onPointerEnter?.(e);
      }}
      onFocusCapture={(e) => {
        armActions?.();
        containerProps?.onFocusCapture?.(e);
      }}
      className={cn(
        "group relative flex items-start gap-3 px-2.5 rounded hover:bg-secondary/40 transition-colors hover:z-10 focus-within:z-10",
        continuation ? "py-0.5" : "py-1.5",
        // A message still in flight pulses the whole row rather than showing a
        // spinner/glyph — no symbol, just a soft breathe until it settles.
        pending && "animate-pulse",
        // A held finger on selectable text starts the platform's own selection
        // / callout around the same 500ms, which fires `pointercancel` and eats
        // the long-press before it opens the sheet — intermittently, depending
        // on whether the press landed on text. Suppress both on the long-press
        // surface (touch only; the "Copy text" action replaces manual select).
        onLongPress && "select-none [-webkit-user-select:none] [-webkit-touch-callout:none]",
        className,
        containerProps?.className,
      )}
      style={{
        ...(onSwipeReply ? { touchAction: "pan-y" } : undefined),
        ...containerProps?.style,
      }}
    >
      {/* Swipe-to-reply: reply icon revealed at the right edge as the content
          slides left (reply is a LEFT swipe; rightward is the pane-reveal
          "leave room" gesture) */}
      {onSwipeReply && swipe.offset > 0 && (
        <div
          className="absolute right-2.5 top-1/2 -translate-y-1/2 z-0 pointer-events-none flex items-center justify-center"
          style={{
            opacity: Math.min(swipe.offset / 60, 1),
          }}
        >
          <div className="flex items-center justify-center size-9 rounded-full bg-primary/15 text-primary">
            <Reply className="size-4" />
          </div>
        </div>
      )}
      {/* Sliding content wrapper */}
      <div
        className="flex flex-col flex-1 min-w-0"
        style={
          onSwipeReply && swipe.offset !== 0
            ? {
                transform: `translateX(${-swipe.offset}px)`,
                transition: swipe.dragging ? "none" : "transform 0.25s ease-out",
              }
            : undefined
        }
      >
      {/* The reply-context preview sits ABOVE the avatar/name row so the avatar
          lines up with the name and the preview clears the avatar gutter. */}
      {beforeBody}
      {/* Avatar + content. Relatively positioned so the floated action toolbar
          and continuation markers anchor to the MESSAGE, not the preview. */}
      <div className="flex items-start gap-3 relative">
      {continuation ? (
        <span className="shrink-0 w-10 self-stretch flex items-start justify-end pr-0.5 pt-0.5 text-[10px] leading-none text-muted-foreground/60 opacity-0 group-hover:opacity-100 transition-opacity tabular-nums select-none">
          {shortClockTime(createdAt)}
        </span>
      ) : identityOverride ? (
        meshActions ? (
          <MeshProfilePreviewCard
            peerID={meshActions.peerID}
            identity={identityOverride}
            isSelf={meshActions.isSelf}
            onMessage={meshActions.onMessage}
            onMention={meshActions.onMention}
          >
            <button type="button" className="shrink-0 mt-0.5 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer transition-opacity hover:opacity-90">
              {avatar}
            </button>
          </MeshProfilePreviewCard>
        ) : (
          <span className="shrink-0 mt-0.5">{avatar}</span>
        )
      ) : (
        <ProfilePreviewCard pubkey={pubkey}>
          <button type="button" className="shrink-0 mt-0.5 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <Avatar shape={getAvatarShape(metadata)} className="size-10 cursor-pointer transition-opacity hover:opacity-90">
              <AvatarImage src={metadata?.picture} alt={displayName} />
              <AvatarFallback className="bg-primary/20 text-primary text-sm">
                {displayName[0]?.toUpperCase()}
              </AvatarFallback>
            </Avatar>
          </button>
        </ProfilePreviewCard>
      )}
      <div className="flex-1 min-w-0">
        {!continuation && (
          <div className="flex items-baseline gap-2">
            {identityOverride ? (
              meshActions ? (
                <MeshProfilePreviewCard
                  peerID={meshActions.peerID}
                  identity={identityOverride}
                  isSelf={meshActions.isSelf}
                  onMessage={meshActions.onMessage}
                  onMention={meshActions.onMention}
                >
                  <button
                    type="button"
                    className="text-[15px] font-semibold text-primary truncate min-w-0 inline-flex items-baseline gap-1 hover:underline focus:outline-none"
                    style={color ? { color } : undefined}
                  >
                    <span className="truncate">{displayName}</span>
                    {suffix && (
                      <span className="text-[11px] font-normal text-muted-foreground/70 shrink-0 no-underline">
                        #{suffix}
                      </span>
                    )}
                  </button>
                </MeshProfilePreviewCard>
              ) : (
                <span
                  className="text-[15px] font-semibold text-primary truncate min-w-0 inline-flex items-baseline gap-1"
                  style={color ? { color } : undefined}
                >
                  <span className="truncate">{displayName}</span>
                  {suffix && (
                    <span className="text-[11px] font-normal text-muted-foreground/70 shrink-0">
                      #{suffix}
                    </span>
                  )}
                </span>
              )
            ) : (
              <ProfilePreviewCard pubkey={pubkey}>
                <button
                  type="button"
                  className="text-[15px] font-semibold text-primary truncate min-w-0 hover:underline focus:outline-none"
                  style={color ? { color } : undefined}
                >
                  <DisplayName pubkey={pubkey} name={displayName} tags={author.data?.event?.tags ?? NO_TAGS} />
                </button>
              </ProfilePreviewCard>
            )}
            <BotPill metadata={metadata} />
            <ProxyPill proxy={proxy} />
            {nameBadge}
            {label && (
              <Badge variant="secondary" className="text-[10px] font-medium shrink min-w-0 max-w-[35%]">
                <span className="truncate">{label}</span>
              </Badge>
            )}
            <span className="text-[11px] text-muted-foreground/70 shrink-0">
              {shortTimeAgo(createdAt)}
            </span>
            {edited && (
              <span className="text-[10px] text-muted-foreground/60 shrink-0" title="Edited">(edited)</span>
            )}
            {expiresAt !== undefined && <ExpirationClock createdAt={createdAt} expiresAt={expiresAt} />}
          </div>
        )}
        {actions && actionsArmed && (
          // Float the action toolbar above the top-right edge of the row rather
          // than inline on the header. Inline, a long name/title would get
          // crushed by the buttons; floating keeps the full name visible and the
          // toolbar clear of the body. Solid background + a small lift keeps it
          // legible over whatever it overlaps.
          //
          // This is a POINTER affordance only — ChatMessage doesn't pass
          // `actions` on touch, where the long-press sheet takes over. A strip
          // of icon buttons at the row's edge can't hold a message's full set
          // of actions at 44px targets on a phone.
          <div className={cn(
            "absolute right-2.5 z-20 flex flex-wrap justify-end items-center max-w-[calc(100%-1.25rem)] gap-0.5 rounded-md border bg-background/95 px-1 py-0.5 shadow-sm opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity",
            // Sit just above the row's top-right edge, overlapping it so it stays
            // inside the row's hover region (a fully-detached panel vanishes when
            // the pointer leaves the row to reach it). Continuation rows are
            // compact and header-less, but the offset is the same.
            continuation ? "-top-3" : "-top-2.5",
          )}>
            {actions}
          </div>
        )}
        {children}
        {continuation && edited && (
          // Continuation rows have no header to carry the (edited) marker, so
          // render it INLINE trailing the body, in normal flow. (The header
          // rows put the same marker on the name/timestamp line.) In flow it
          // takes its own space instead of floating over a neighbour, so it can
          // never ride up and cover the message above the way the old
          // absolutely-positioned pill did.
          <div className="mt-0.5 flex items-center gap-2 leading-none">
            <span className="text-[10px] text-muted-foreground/60 shrink-0" title="Edited">(edited)</span>
          </div>
        )}
        {afterBody}
      </div>
      </div>
      </div>
    </div>
  );
});
