import { Bluetooth, Headphones, MessageSquare, Plus, Settings } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";

import type React from "react";

import { AddDialog } from "@/components/dialogs/AddDialog";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAppContext } from "@/hooks/useAppContext";
import { useCall } from "@/hooks/useCall";
import { useConcordList, useConcordCommunity } from "@/concord-v1/hooks/useConcordList";
import { useConcordMetadata } from "@/concord-v1/hooks/useConcordMetadata";
import { useCommunityImageDescriptors } from "@/concord-v1/hooks/useCommunityImageDescriptors";
import { useDecryptedCommunityImage } from "@/concord-v1/hooks/useDecryptedCommunityImage";
import { useCommunity2, useLiveCommunities2 } from "@/concord-v2/hooks/useCommunityList2";
import { useControlFold2 } from "@/concord-v2/hooks/useControlPlane2";
import { useDecryptedImage2 } from "@/concord-v2/hooks/useDecryptedImage2";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useHasUnreadDMs } from "@/hooks/useDirectMessages";
import { useMeshTransport } from "@/hooks/useMeshTransport";
import { useRelayGroups } from "@/hooks/useRelayGroups";
import { useRelayInfo } from "@/hooks/useRelayInfo";
import { useRelayUnread } from "@/hooks/useRelayUnread";
import { useUpdateUserGroupList } from "@/hooks/useUserGroupList";
import { impact } from "@/lib/haptics";
import { normalizeRelayUrl, PLATFORM_RELAYS, relayToRouteParam } from "@/lib/platform";
import { cn } from "@/lib/utils";

/** Human-ish short name for a relay URL (hostname). */
function relayHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * A single entry in the unified community rail. NIP-29 servers and both
 * flavours of Concord community live in one flat, user-reorderable list; each
 * carries a stable `key` used for drag/reorder and persisted order.
 */
type RailItem =
  | { kind: "server"; key: string; url: string }
  | { kind: "concord1"; key: string; communityId: string; name: string }
  | { kind: "concord2"; key: string; communityId: string; name: string };

/** Stable rail key for a Concord V1 community. */
const concord1Key = (communityId: string) => `c1:${communityId}`;
/** Stable rail key for a Concord V2 community. */
const concord2Key = (communityId: string) => `c2:${communityId}`;

/**
 * The floating "ghost" icon that follows the pointer while dragging a rail
 * item. Rendered in a portal-free fixed layer; mirrors the item's avatar so
 * the drag feels like you're physically carrying the icon.
 */
function ServerDragGhost({ url }: { url: string }) {
  const { data: info } = useRelayInfo(url);
  const host = relayHost(url);
  const name = info?.name || host;
  const initial = name.trim().charAt(0).toUpperCase() || "?";
  return (
    <span className="block size-12 rotate-[-6deg] scale-110 [filter:drop-shadow(0_8px_16px_rgba(0,0,0,0.55))_drop-shadow(0_0_8px_hsl(var(--primary)/0.6))]">
      <Avatar className="size-12 clip-corner-lg ring-2 ring-primary">
        <AvatarImage src={info?.icon} alt={name} />
        <AvatarFallback className="bg-secondary font-semibold text-primary">
          {initial}
        </AvatarFallback>
      </Avatar>
    </span>
  );
}

function Concord1DragGhost({ communityId, name }: { communityId: string; name: string }) {
  const initials = name.trim().slice(0, 2).toUpperCase() || "··";
  const community = useConcordCommunity(communityId);
  const { data: folded } = useConcordMetadata(community, false);
  const { icon } = useCommunityImageDescriptors(community, folded);
  const iconUrl = useDecryptedCommunityImage(icon);
  return (
    <span className="flex items-center justify-center size-12 rotate-[-6deg] scale-110 clip-corner-lg overflow-hidden bg-muted text-success ring-2 ring-primary [filter:drop-shadow(0_8px_16px_rgba(0,0,0,0.55))_drop-shadow(0_0_8px_hsl(var(--primary)/0.6))]">
      {iconUrl ? (
        <img src={iconUrl} alt="" draggable={false} className="size-full object-cover" />
      ) : (
        <span className="text-sm font-semibold">{initials}</span>
      )}
    </span>
  );
}

function Concord2DragGhost({ communityId, name }: { communityId: string; name: string }) {
  const community = useCommunity2(communityId);
  const { data: folded } = useControlFold2(community, false);
  const displayName = folded?.metadata?.name || name;
  const initials = displayName.trim().slice(0, 2).toUpperCase() || "··";
  const iconUrl = useDecryptedImage2(folded?.metadata?.icon);
  return (
    <span className="flex items-center justify-center size-12 rotate-[-6deg] scale-110 clip-corner-lg overflow-hidden bg-muted text-success ring-2 ring-primary [filter:drop-shadow(0_8px_16px_rgba(0,0,0,0.55))_drop-shadow(0_0_8px_hsl(var(--primary)/0.6))]">
      {iconUrl ? (
        <img src={iconUrl} alt="" draggable={false} className="size-full object-cover" />
      ) : (
        <span className="text-sm font-semibold">{initials}</span>
      )}
    </span>
  );
}

function DragGhost({ item, x, y }: { item: RailItem; x: number; y: number }) {
  return (
    <div
      className="pointer-events-none fixed z-[300] -translate-x-1/2 -translate-y-1/2 animate-in zoom-in-75 duration-150"
      style={{ left: x, top: y }}
    >
      {item.kind === "server" ? (
        <ServerDragGhost url={item.url} />
      ) : item.kind === "concord1" ? (
        <Concord1DragGhost communityId={item.communityId} name={item.name} />
      ) : (
        <Concord2DragGhost communityId={item.communityId} name={item.name} />
      )}
    </div>
  );
}

function ServerButton({
  url,
  onNavigate,
  onSelect,
  selected,
  inCall,
  draggable,
  dragging,
  shiftY,
  reordering,
  onDragPointerDown,
  shouldSuppressClick,
}: {
  url: string;
  onNavigate?: () => void;
  /** When provided, selecting a server fires this instead of navigating. */
  onSelect?: (url: string) => void;
  /** Active state when driven by `onSelect` (controlled mode). */
  selected?: boolean;
  /** Whether the active voice call is on this server. */
  inCall?: boolean;
  /** Whether this server can be drag-reordered. */
  draggable?: boolean;
  /** This server is the one currently being dragged (collapsed to placeholder). */
  dragging?: boolean;
  /** Vertical offset (px) this item shifts to make room for the dragged one. */
  shiftY?: number;
  /** Whether a drag is in progress (enables smooth shift transitions). */
  reordering?: boolean;
  /** Begin a potential long-press drag from this server. */
  onDragPointerDown?: (e: PointerEvent) => void;
  /** Returns true if a click should be suppressed (a drag just finished). */
  shouldSuppressClick?: () => boolean;
}) {
  const triggerRef = useRef<HTMLElement | null>(null);
  const dragHandlerRef = useRef(onDragPointerDown);
  dragHandlerRef.current = onDragPointerDown;

  // Attach the long-press pointerdown listener natively on the rendered DOM
  // node. Going through a React prop on a Radix `asChild` trigger proved
  // unreliable (the Slot did not always forward it); a direct listener always
  // fires. `touch-action: pan-y` is set in the class so the rail can still be
  // scrolled vertically by touch-dragging an item, while the long-press
  // drag-to-reorder gesture (which holds still, then moves) still works.
  useEffect(() => {
    const el = triggerRef.current;
    if (!el || !draggable) return;
    const handler = (e: PointerEvent) => dragHandlerRef.current?.(e);
    el.addEventListener("pointerdown", handler);
    return () => el.removeEventListener("pointerdown", handler);
  }, [draggable]);

  const { data: info } = useRelayInfo(url);
  const { user } = useCurrentUser();
  const { data: groups } = useRelayGroups(user ? url : undefined);
  const groupIds = useMemo(() => (groups ?? []).map((g) => g.id), [groups]);
  const { anyUnread, anyMention } = useRelayUnread(user ? url : undefined, groupIds);
  const host = relayHost(url);
  const name = info?.name || host;
  const initial = name.trim().charAt(0).toUpperCase() || "?";

  const inner = (isActive: boolean) => (
    <>
      {/* Active marker: a thin neon blade in the gutter. */}
      <span
        className={cn(
          "absolute -left-2 w-[3px] bg-primary transition-all",
          isActive ? "h-12 opacity-100" : "h-2 opacity-0 group-hover:opacity-60 group-hover:h-6",
        )}
      />
      {/*
        Angular crest. Glow lives on the wrapper as a drop-shadow so it
        traces the fin silhouette (a box-shadow would be clipped away
        by the child's clip-path). Restrained: one soft shadow.
      */}
      <span
        className={cn(
          "relative block size-12 transition-all duration-150",
          isActive && "[filter:drop-shadow(0_0_3px_hsl(var(--primary)/0.6))]",
        )}
      >
        <Avatar
          className={cn(
            "size-12 clip-corner-lg transition-all duration-150",
            !isActive && "opacity-50 saturate-50 group-hover:opacity-100 group-hover:saturate-100",
          )}
        >
          <AvatarImage src={info?.icon} alt={name} />
          <AvatarFallback
            className={cn(
              "bg-secondary font-semibold",
              isActive ? "text-primary" : "text-secondary-foreground",
            )}
          >
            {initial}
          </AvatarFallback>
        </Avatar>
        {/* Voice indicator: a headphones badge when a call is live here. */}
        {inCall && (
          <span className="absolute -bottom-1 -right-1 z-10 flex size-4 items-center justify-center rounded-full bg-success text-success-foreground ring-2 ring-background">
            <Headphones className="size-2.5" />
          </span>
        )}
        {/* Unread / mention indicator (hidden while active — you're reading it). */}
        {!isActive && anyMention ? (
          <span
            className="absolute -top-1 -right-1 z-10 flex min-w-4 h-4 px-1 items-center justify-center rounded-full bg-primary text-primary-foreground text-[10px] font-bold leading-none ring-2 ring-background"
            aria-label="You were mentioned"
          >
            @
          </span>
        ) : !isActive && anyUnread ? (
          <span
            className="absolute -top-0.5 -right-0.5 z-10 size-3 rounded-full bg-foreground ring-2 ring-background"
            aria-label="Unread messages"
          />
        ) : null}
      </span>
    </>
  );

  const triggerClass = "group relative flex items-center justify-center shrink-0 touch-pan-y";

  const dragClass = cn(
    draggable && "cursor-grab",
    dragging && "cursor-grabbing",
    // While a reorder is in flight, lock touch-action so the browser can't
    // steal the (mostly vertical) gesture as a pan and stop delivering moves.
    reordering && "touch-none",
  );

  // While this item is the one being dragged, its slot becomes a dashed
  // placeholder (the floating ghost carries the real icon).
  const placeholder = (
    <span className="relative block size-12">
      <span className="absolute inset-0 rounded-xl border-2 border-dashed border-primary/50 bg-primary/5" />
    </span>
  );

  // Identify the draggable node for hit-testing; the pointerdown listener is
  // attached natively via `triggerRef` (see effect above).
  const interactionProps = draggable ? { "data-rail-key": url } : {};

  // Shift this icon (smoothly) to open a gap for the dragged item. The dragged
  // item itself is not shifted (its placeholder stays put; the ghost moves).
  const shiftStyle: React.CSSProperties =
    !dragging && shiftY
      ? { transform: `translateY(${shiftY}px)`, transition: "transform 180ms ease" }
      : { transform: "translateY(0)", transition: reordering ? "transform 180ms ease" : undefined };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {onSelect ? (
          <button
            ref={triggerRef as React.RefObject<HTMLButtonElement>}
            type="button"
            aria-label={name}
            style={shiftStyle}
            onClick={() => {
              if (shouldSuppressClick?.()) return;
              onSelect(url);
            }}
            className={cn(triggerClass, dragClass, selected && "is-active")}
            {...interactionProps}
          >
            {dragging ? placeholder : inner(Boolean(selected))}
          </button>
        ) : (
          <NavLink
            ref={triggerRef as React.RefObject<HTMLAnchorElement>}
            to={`/s/${relayToRouteParam(url)}`}
            aria-label={name}
            style={shiftStyle}
            onClick={(e) => {
              if (shouldSuppressClick?.()) {
                e.preventDefault();
                return;
              }
              onNavigate?.();
            }}
            className={({ isActive }) => cn(triggerClass, dragClass, isActive && "is-active")}
            {...interactionProps}
          >
            {({ isActive }) => (dragging ? placeholder : inner(isActive))}
          </NavLink>
        )}
      </TooltipTrigger>
      <TooltipContent side="right" className="font-medium">
        {name}
        <span className="block text-xs text-muted-foreground">{url}</span>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * A rail button for an end-to-end-encrypted Concord community. Visually
 * distinguished from NIP-29 servers by the shield accent (different trust model).
 */
function ConcordButton({
  communityId,
  name,
  onNavigate,
  draggable,
  dragging,
  shiftY,
  reordering,
  onDragPointerDown,
  shouldSuppressClick,
}: {
  communityId: string;
  name: string;
  onNavigate?: () => void;
  draggable?: boolean;
  dragging?: boolean;
  shiftY?: number;
  reordering?: boolean;
  onDragPointerDown?: (e: PointerEvent) => void;
  shouldSuppressClick?: () => boolean;
}) {
  const triggerRef = useRef<HTMLAnchorElement | null>(null);
  const dragHandlerRef = useRef(onDragPointerDown);
  dragHandlerRef.current = onDragPointerDown;
  useEffect(() => {
    const el = triggerRef.current;
    if (!el || !draggable) return;
    const handler = (e: PointerEvent) => dragHandlerRef.current?.(e);
    el.addEventListener("pointerdown", handler);
    return () => el.removeEventListener("pointerdown", handler);
  }, [draggable]);

  const initials = name.trim().slice(0, 2).toUpperCase() || "··";
  // Resolve the community's authoritative GroupRoot icon: rehydrate from the
  // membership bundle, overlay the folded metadata (the owner-controlled icon),
  // then decrypt the encrypted Blossom blob for display. Falls back to initials.
  const community = useConcordCommunity(communityId);
  // Rail buttons only need the icon/name, served by the fold's persisted
  // snapshot. Pass active=false so pageload doesn't fan out a per-relay 3308
  // control-plane query for every community — the community's page (active=true)
  // syncs it on navigation, sharing this query key.
  const { data: folded } = useConcordMetadata(community, false);
  // Resolve the icon descriptor with a synchronous, disk-backed fallback so it's
  // present on the first frame after reload (the folded metadata that normally
  // carries it lands asynchronously, which is what made the avatar flicker).
  const { icon } = useCommunityImageDescriptors(community, folded);
  const iconUrl = useDecryptedCommunityImage(icon);

  const shiftStyle: React.CSSProperties =
    !dragging && shiftY
      ? { transform: `translateY(${shiftY}px)`, transition: "transform 180ms ease" }
      : { transform: "translateY(0)", transition: reordering ? "transform 180ms ease" : undefined };

  const placeholder = (
    <span className="relative block size-12">
      <span className="absolute inset-0 rounded-xl border-2 border-dashed border-primary/50 bg-primary/5" />
    </span>
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <NavLink
          ref={triggerRef}
          to={`/c1/${encodeURIComponent(communityId)}`}
          aria-label={name}
          style={shiftStyle}
          onClick={(e) => {
            if (shouldSuppressClick?.()) {
              e.preventDefault();
              return;
            }
            onNavigate?.();
          }}
          className={cn(
            "group relative flex items-center justify-center shrink-0 touch-pan-y",
            draggable && "cursor-grab",
            dragging && "cursor-grabbing",
            reordering && "touch-none",
          )}
          {...(draggable ? { "data-rail-key": concord1Key(communityId) } : {})}
        >
          {({ isActive }) =>
            dragging ? (
              placeholder
            ) : (
              <span className="relative block size-12">
                <span
                  className={cn(
                    "flex items-center justify-center size-12 clip-corner-lg overflow-hidden transition-all duration-150",
                    "bg-muted text-success opacity-60 saturate-75",
                    "group-hover:opacity-100 group-hover:saturate-100",
                    isActive && "opacity-100 saturate-100 is-active",
                  )}
                >
                  {iconUrl ? (
                    <img src={iconUrl} alt="" draggable={false} className="size-full object-cover" />
                  ) : (
                    <span className="text-sm font-semibold">{initials}</span>
                  )}
                </span>
              </span>
            )
          }
        </NavLink>
      </TooltipTrigger>
      <TooltipContent side="right" className="font-medium">
        {name}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * A rail button for an end-to-end-encrypted Concord V2 community (CORD-02).
 * Same shield accent as V1 (same trust model); navigates to `/c/…` and pulls
 * its authoritative icon from the folded Control Plane metadata.
 */
function Concord2Button({
  communityId,
  name,
  onNavigate,
  draggable,
  dragging,
  shiftY,
  reordering,
  onDragPointerDown,
  shouldSuppressClick,
}: {
  communityId: string;
  name: string;
  onNavigate?: () => void;
  draggable?: boolean;
  dragging?: boolean;
  shiftY?: number;
  reordering?: boolean;
  onDragPointerDown?: (e: PointerEvent) => void;
  shouldSuppressClick?: () => boolean;
}) {
  const triggerRef = useRef<HTMLAnchorElement | null>(null);
  const dragHandlerRef = useRef(onDragPointerDown);
  dragHandlerRef.current = onDragPointerDown;
  useEffect(() => {
    const el = triggerRef.current;
    if (!el || !draggable) return;
    const handler = (e: PointerEvent) => dragHandlerRef.current?.(e);
    el.addEventListener("pointerdown", handler);
    return () => el.removeEventListener("pointerdown", handler);
  }, [draggable]);

  const community = useCommunity2(communityId);
  // Rail buttons only need the icon/name, which the fold serves from its
  // persisted snapshot. Pass active=false so we DON'T fan out a control-plane
  // REQ per relay for every community on pageload — the community's page
  // (active=true) syncs it on navigation, sharing this query key.
  const { data: folded } = useControlFold2(community, false);
  const displayName = folded?.metadata?.name || name;
  const initials = displayName.trim().slice(0, 2).toUpperCase() || "··";
  const iconUrl = useDecryptedImage2(folded?.metadata?.icon);

  const shiftStyle: React.CSSProperties =
    !dragging && shiftY
      ? { transform: `translateY(${shiftY}px)`, transition: "transform 180ms ease" }
      : { transform: "translateY(0)", transition: reordering ? "transform 180ms ease" : undefined };

  const placeholder = (
    <span className="relative block size-12">
      <span className="absolute inset-0 rounded-xl border-2 border-dashed border-primary/50 bg-primary/5" />
    </span>
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <NavLink
          ref={triggerRef}
          to={`/c/${encodeURIComponent(communityId)}`}
          aria-label={displayName}
          style={shiftStyle}
          onClick={(e) => {
            if (shouldSuppressClick?.()) {
              e.preventDefault();
              return;
            }
            onNavigate?.();
          }}
          className={cn(
            "group relative flex items-center justify-center shrink-0 touch-pan-y",
            draggable && "cursor-grab",
            dragging && "cursor-grabbing",
            reordering && "touch-none",
          )}
          {...(draggable ? { "data-rail-key": concord2Key(communityId) } : {})}
        >
          {({ isActive }) =>
            dragging ? (
              placeholder
            ) : (
              <span className="relative block size-12">
                <span
                  className={cn(
                    "flex items-center justify-center size-12 clip-corner-lg overflow-hidden transition-all duration-150",
                    "bg-muted text-success opacity-60 saturate-75",
                    "group-hover:opacity-100 group-hover:saturate-100",
                    isActive && "opacity-100 saturate-100 is-active",
                  )}
                >
                  {iconUrl ? (
                    <img src={iconUrl} alt="" draggable={false} className="size-full object-cover" />
                  ) : (
                    <span className="text-sm font-semibold">{initials}</span>
                  )}
                </span>
              </span>
            )
          }
        </NavLink>
      </TooltipTrigger>
      <TooltipContent side="right" className="font-medium">
        {displayName}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Far-left vertical rail listing every server (relay): pinned platform
 * relays first, then user-added ones, then add-server and settings actions.
 */
export function ServerRail({
  onNavigate,
  onServerSelect,
  selectedServer,
  className,
}: {
  onNavigate?: () => void;
  /** When set, tapping a server fires this instead of navigating (drawer mode). */
  onServerSelect?: (url: string) => void;
  /** The currently-selected server in drawer mode. */
  selectedServer?: string;
  className?: string;
}) {
  const { config, updateConfig } = useAppContext();
  const navigate = useNavigate();
  const { activeCall } = useCall();
  const { user } = useCurrentUser();
  const { mesh } = useMeshTransport();
  const hasUnreadDMs = useHasUnreadDMs();
  const { mutateAsync: updateList } = useUpdateUserGroupList();
  const { data: concord } = useConcordList();
  const concord2 = useLiveCommunities2();
  const [addOpen, setAddOpen] = useState(false);

  // Build the full rail list (pinned platform relays + user-added ones),
  // de-duplicated. Order is applied at the unified-list level below.
  const servers = useMemo(() => {
    const base: string[] = [];
    const seen = new Set<string>();
    for (const url of [...PLATFORM_RELAYS, ...config.addedRelays]) {
      const normalized = normalizeRelayUrl(url);
      if (normalized && !seen.has(normalized)) {
        seen.add(normalized);
        base.push(normalized);
      }
    }
    return base;
  }, [config.addedRelays]);

  // Unify NIP-29 servers and Concord (V1/V2) communities into one flat list,
  // then apply the user's saved rail order (`config.railOrder`) on top. Any
  // item missing from the saved order keeps its default position (servers
  // first, then Concord V1, then V2, in discovery order); unknown saved entries
  // are ignored. This is the single reorderable list shown in the rail.
  const items = useMemo<RailItem[]>(() => {
    const base: RailItem[] = [];
    base.push(...servers.map((url) => ({ kind: "server" as const, key: url, url })));
    if (user) {
      for (const entry of concord?.list.entries ?? []) {
        base.push({
          kind: "concord1",
          key: concord1Key(entry.communityId),
          communityId: entry.communityId,
          name: entry.current.name,
        });
      }
      for (const entry of concord2) {
        base.push({
          kind: "concord2",
          key: concord2Key(entry.community_id),
          communityId: entry.community_id,
          name: entry.current.name,
        });
      }
    }

    const byKey = new Map(base.map((it) => [it.key, it]));
    const order = config.railOrder.filter((k) => byKey.has(k));
    if (order.length === 0) return base;
    const ordered: RailItem[] = [];
    const placed = new Set<string>();
    for (const key of order) {
      const it = byKey.get(key)!;
      ordered.push(it);
      placed.add(key);
    }
    for (const it of base) {
      if (!placed.has(it.key)) ordered.push(it);
    }
    return ordered;
  }, [servers, concord, concord2, user, config.railOrder]);

  // Long-press drag-to-reorder for the whole community rail. Works for both
  // touch and mouse via pointer events: press and hold (~300ms) to pick an item
  // up, then drag to slide it into a new spot — the other icons shift to open a
  // gap and a floating ghost follows the pointer. A short press/tap navigates.
  //
  // The rendered DOM order never changes during a drag (it stays `items`);
  // instead each icon gets a vertical `shiftY` to open the drop gap. This
  // avoids reading the DOM mid-animation, which previously caused flicker.
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  // Target slot index (in the original `items` list) the dragged item lands.
  const [targetIndex, setTargetIndex] = useState<number | null>(null);
  const navRef = useRef<HTMLElement | null>(null);
  const longPressTimer = useRef<number | null>(null);
  const startPos = useRef<{ x: number; y: number } | null>(null);
  // Tracks the in-flight drag outside React state (read inside listeners).
  const dragActive = useRef<string | null>(null);
  // Set briefly after a drag so the ensuing click doesn't navigate/select.
  const didDragRef = useRef(false);
  // Snapshot of the order at drag start, so the math is stable mid-gesture.
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const orderKeysRef = useRef<string[]>([]);
  orderKeysRef.current = items.map((it) => it.key);
  // Frozen slot centers (viewport Y) + pitch, captured once at pickup from
  // clean DOM. Drives the arithmetic, never re-measured during the drag.
  const slotCentersRef = useRef<number[]>([]);
  const pitchRef = useRef(68);
  const targetIndexRef = useRef<number | null>(null);
  targetIndexRef.current = targetIndex;

  const persistOrder = useCallback(
    (keys: string[]) => {
      // Persist the unified rail order in app config (servers + communities).
      updateConfig((current) => ({
        ...current,
        railOrder: keys,
        // Keep the legacy server-only order in sync for backward compat.
        serverOrder: keys.filter((k) => !k.startsWith("c1:") && !k.startsWith("c2:")),
      }));

      // Also sync the relative order of user-added relays to the kind 10009
      // list (the cross-device source of truth for the added-server set).
      const pinnedSet = new Set(PLATFORM_RELAYS);
      const addedOrder = keys.filter((k) => !k.startsWith("c1:") && !k.startsWith("c2:") && !pinnedSet.has(k));
      if (user && addedOrder.length > 0) {
        updateList({ type: "reorder-servers", urls: addedOrder }).catch((err) =>
          console.warn("Failed to persist server order:", err),
        );
      }
    },
    [updateConfig, updateList, user],
  );

  /** Nearest slot index for a pointer Y, from the frozen slot centers. */
  const indexForY = useCallback((y: number): number => {
    const centers = slotCentersRef.current;
    if (centers.length === 0) return 0;
    let idx = 0;
    let best = Infinity;
    for (let i = 0; i < centers.length; i++) {
      const d = Math.abs(y - centers[i]);
      if (d < best) {
        best = d;
        idx = i;
      }
    }
    return idx;
  }, []);

  /** Build the reordered key list from a target index. */
  const orderForTarget = useCallback((draggedKey: string, target: number): string[] => {
    const without = orderKeysRef.current.filter((k) => k !== draggedKey);
    const clamped = Math.max(0, Math.min(target, without.length));
    const next = [...without];
    next.splice(clamped, 0, draggedKey);
    return next;
  }, []);

  const handleItemPointerDown = useCallback(
    (key: string, e: PointerEvent) => {
      // Only left mouse / touch / pen; ignore right-click etc.
      if (e.button !== 0 && e.pointerType === "mouse") return;
      startPos.current = { x: e.clientX, y: e.clientY };
      const pointerId = e.pointerId;

      const clear = () => {
        if (longPressTimer.current !== null) {
          window.clearTimeout(longPressTimer.current);
          longPressTimer.current = null;
        }
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
      };

      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        // Before the long-press fires, treat movement as a scroll/cancel.
        if (dragActive.current === null) {
          const s = startPos.current;
          if (s && Math.hypot(ev.clientX - s.x, ev.clientY - s.y) > 10) {
            clear();
          }
          return;
        }
        ev.preventDefault();
        setDragPos({ x: ev.clientX, y: ev.clientY });
        setTargetIndex(indexForY(ev.clientY));
      };

      const onUp = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        if (dragActive.current !== null) {
          const ti = targetIndexRef.current;
          const finalOrder =
            ti === null ? orderKeysRef.current : orderForTarget(dragActive.current, ti);
          persistOrder(finalOrder);
          didDragRef.current = true;
          // Keep the guard up long enough to swallow the click that the
          // browser synthesizes after pointerup, then clear it.
          window.setTimeout(() => {
            didDragRef.current = false;
          }, 300);
        }
        dragActive.current = null;
        setDragKey(null);
        setDragPos(null);
        setTargetIndex(null);
        clear();
      };

      window.addEventListener("pointermove", onMove, { passive: false });
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);

      longPressTimer.current = window.setTimeout(() => {
        // Freeze slot geometry from clean DOM (no transforms applied yet).
        const nav = navRef.current;
        const centers: number[] = [];
        if (nav) {
          const els = nav.querySelectorAll<HTMLElement>("[data-rail-key]");
          els.forEach((el) => {
            const r = el.getBoundingClientRect();
            centers.push(r.top + r.height / 2);
          });
        }
        slotCentersRef.current = centers;
        if (centers.length >= 2) pitchRef.current = centers[1] - centers[0];

        dragActive.current = key;
        setDragKey(key);
        setDragPos({ x: e.clientX, y: e.clientY });
        setTargetIndex(orderKeysRef.current.indexOf(key));
        // Haptic nudge on supported devices.
        impact("medium");
      }, 300);
    },
    [indexForY, orderForTarget, persistOrder],
  );

  // Per-item vertical shift while dragging: each icon translates from its
  // original slot to the slot it would occupy in the previewed order. Pure
  // arithmetic off frozen state — no DOM reads — so it can't feedback/flicker.
  const reordering = dragKey !== null;
  const shiftFor = useCallback(
    (key: string): number => {
      if (!dragKey || targetIndex === null || key === dragKey) return 0;
      const previewOrder = orderForTarget(dragKey, targetIndex);
      const fromIdx = items.findIndex((it) => it.key === key);
      const toIdx = previewOrder.indexOf(key);
      if (fromIdx === -1 || toIdx === -1) return 0;
      return (toIdx - fromIdx) * pitchRef.current;
    },
    [dragKey, targetIndex, items, orderForTarget],
  );

  // The item currently being dragged (drives the floating ghost).
  const draggedItem = useMemo(
    () => (dragKey ? (items.find((it) => it.key === dragKey) ?? null) : null),
    [dragKey, items],
  );
  const draggable = items.length > 1;

  return (
    <nav
      ref={navRef}
      aria-label="Servers"
      // Suppress the browser's native HTML5 drag (images and <a>/NavLink are
      // draggable by default). Without this, a press-and-drag on a community
      // icon starts a native image/link drag that hijacks our custom
      // long-press reorder gesture.
      onDragStart={(e) => e.preventDefault()}
      className={cn(
        // Chrome plane — deepest part of the recessed frame. The rail reaches
        // both screen edges on mobile, so it owns the top/bottom safe-area
        // insets (status bar above, gesture/nav bar below) on top of its base
        // padding. On desktop the env() insets are 0, so this is a no-op there.
        // Slimmer + tighter on the mobile drill-down (where it shares the width
        // with the channel/DM list) so it doesn't read as a squeezed desktop
        // rail; widens to the full desktop rail at the `sidebar:` breakpoint.
        "flex flex-col items-center gap-4 sidebar:gap-5 w-[60px] sidebar:w-[72px] shrink-0 overflow-y-auto bg-chrome-deep",
        "pt-[calc(0.75rem+var(--safe-area-inset-top,env(safe-area-inset-top,0px)))]",
        "pb-[calc(0.75rem+var(--safe-area-inset-bottom,env(safe-area-inset-bottom,0px)))]",
        // Lock scrolling while dragging so the rail doesn't fight the gesture.
        dragKey && "overflow-hidden",
        className,
      )}
    >
      {/* Nearby Bluetooth mesh chat — peer-to-peer, above DMs. Only shown when
          the platform can actually run it (Android with BLE hardware): a rail
          entry that leads to a permanent "unavailable here" page on web/desktop
          is dead weight. Hidden while the availability probe resolves; still
          shown when supported-but-off (the page hosts the opt-in toggle). */}
      {user && mesh.available && (
        <Tooltip>
          <TooltipTrigger asChild>
            <NavLink
              to="/mesh"
              aria-label="Nearby mesh"
              onClick={onNavigate}
              className="group relative flex items-center justify-center shrink-0"
            >
              <span
                className={cn(
                  "relative block size-12 transition-all duration-150",
                  "group-aria-[current=page]:[filter:drop-shadow(0_0_3px_hsl(var(--primary)/0.6))]",
                )}
              >
                <span
                  className={cn(
                    "flex items-center justify-center size-12 clip-corner-lg transition-all duration-150",
                    "bg-muted text-primary opacity-50 saturate-50",
                    "group-hover:opacity-100 group-hover:saturate-100",
                    "group-aria-[current=page]:opacity-100 group-aria-[current=page]:saturate-100",
                  )}
                >
                  <Bluetooth className="size-5" />
                </span>
              </span>
            </NavLink>
          </TooltipTrigger>
          <TooltipContent side="right" className="font-medium">
            Nearby mesh
          </TooltipContent>
        </Tooltip>
      )}

      {/* Direct messages — account-level, above the servers (Discord-style).
          Only shown when signed in (DMs require an account). */}
      {user && (
        <Tooltip>
          <TooltipTrigger asChild>
            <NavLink
              to="/dms"
              aria-label="Direct messages"
              onClick={onNavigate}
              className="group relative flex items-center justify-center shrink-0"
            >
              <span
                className={cn(
                  "relative block size-12 transition-all duration-150",
                  "group-aria-[current=page]:[filter:drop-shadow(0_0_3px_hsl(var(--primary)/0.6))]",
                )}
              >
                <span
                  className={cn(
                    "flex items-center justify-center size-12 clip-corner-lg transition-all duration-150",
                    "bg-muted text-primary opacity-50 saturate-50",
                    "group-hover:opacity-100 group-hover:saturate-100",
                    "group-aria-[current=page]:opacity-100 group-aria-[current=page]:saturate-100",
                  )}
                >
                  <MessageSquare className="size-5" />
                </span>
                {/* Voice indicator: a headphones badge when a DM call is live. */}
                {activeCall?.dmPeer && (
                  <span className="absolute -bottom-1 -right-1 z-10 flex size-4 items-center justify-center rounded-full bg-success text-success-foreground ring-2 ring-background">
                    <Headphones className="size-2.5" />
                  </span>
                )}
                {/* Unread DM indicator (hidden on the active DMs view). */}
                {hasUnreadDMs && (
                  <span
                    className="absolute -top-0.5 -right-0.5 z-10 size-3 rounded-full bg-primary ring-2 ring-background group-aria-[current=page]:hidden"
                    aria-label="Unread direct messages"
                  />
                )}
              </span>
            </NavLink>
          </TooltipTrigger>
          <TooltipContent side="right" className="font-medium">
            Direct messages
          </TooltipContent>
        </Tooltip>
      )}

      {/* One unified, reorderable community list: NIP-29 servers and Concord
          (V1/V2) communities intermixed. There is no divider between the two
          trust models — they're a single drag-to-rearrange list. */}
      {items.map((item) =>
        item.kind === "server" ? (
          <ServerButton
            key={item.key}
            url={item.url}
            onNavigate={onNavigate}
            onSelect={onServerSelect}
            selected={onServerSelect ? selectedServer === item.url : undefined}
            inCall={!activeCall?.dmPeer && activeCall?.relayUrl === item.url}
            draggable={draggable}
            dragging={dragKey === item.key}
            shiftY={shiftFor(item.key)}
            reordering={reordering}
            onDragPointerDown={(e) => handleItemPointerDown(item.key, e)}
            shouldSuppressClick={() => didDragRef.current}
          />
        ) : item.kind === "concord1" ? (
          <ConcordButton
            key={item.key}
            communityId={item.communityId}
            name={item.name}
            onNavigate={onNavigate}
            draggable={draggable}
            dragging={dragKey === item.key}
            shiftY={shiftFor(item.key)}
            reordering={reordering}
            onDragPointerDown={(e) => handleItemPointerDown(item.key, e)}
            shouldSuppressClick={() => didDragRef.current}
          />
        ) : (
          <Concord2Button
            key={item.key}
            communityId={item.communityId}
            name={item.name}
            onNavigate={onNavigate}
            draggable={draggable}
            dragging={dragKey === item.key}
            shiftY={shiftFor(item.key)}
            reordering={reordering}
            onDragPointerDown={(e) => handleItemPointerDown(item.key, e)}
            shouldSuppressClick={() => didDragRef.current}
          />
        ),
      )}

      {/* Separates the community list from the add/settings actions below. */}
      {items.length > 0 && <div className="w-7 h-px bg-chrome-divider shrink-0" />}

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="secondary"
            size="icon"
            aria-label="Add a server or encrypted chat"
            className="size-12 shrink-0 clip-corner-lg transition-all text-success hover:bg-success hover:text-success-foreground"
            onClick={() => setAddOpen(true)}
          >
            <Plus className="size-5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="right">Add a server or chat</TooltipContent>
      </Tooltip>

      <div className="flex-1 min-h-2" />

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="secondary"
            size="icon"
            aria-label="Settings"
            className="size-12 shrink-0 clip-corner-lg transition-all"
            onClick={() => {
              onNavigate?.();
              navigate("/settings");
            }}
          >
            <Settings className="size-5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="right">Settings</TooltipContent>
      </Tooltip>

      <AddDialog open={addOpen} onOpenChange={setAddOpen} />

      {/* Floating ghost that follows the pointer during a drag. */}
      {draggedItem && dragPos && <DragGhost item={draggedItem} x={dragPos.x} y={dragPos.y} />}
    </nav>
  );
}
