import { Headphones, MessageSquare, Plus, Radio, Settings, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";

import type React from "react";

import { AddDialog } from "@/components/dialogs/AddDialog";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAppContext } from "@/hooks/useAppContext";
import { useCall } from "@/hooks/useCall";
import { useConcordList, useConcordCommunity } from "@/hooks/useConcordList";
import { useConcordMetadata } from "@/hooks/useConcordMetadata";
import { useCommunityImageDescriptors } from "@/hooks/useCommunityImageDescriptors";
import { useDecryptedCommunityImage } from "@/hooks/useDecryptedCommunityImage";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useHasUnreadDMs } from "@/hooks/useDirectMessages";
import { useRelayGroups } from "@/hooks/useRelayGroups";
import { useRelayInfo } from "@/hooks/useRelayInfo";
import { useRelayUnread } from "@/hooks/useRelayUnread";
import { useUpdateUserGroupList } from "@/hooks/useUserGroupList";
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
 * The floating "ghost" icon that follows the pointer while dragging a server.
 * Rendered in a portal-free fixed layer; mirrors the server avatar so the drag
 * feels like you're physically carrying the icon.
 */
function DragGhost({ url, x, y }: { url: string; x: number; y: number }) {
  const { data: info } = useRelayInfo(url);
  const host = relayHost(url);
  const name = info?.name || host;
  const initial = name.trim().charAt(0).toUpperCase() || "?";

  return (
    <div
      className="pointer-events-none fixed z-[300] -translate-x-1/2 -translate-y-1/2 animate-in zoom-in-75 duration-150"
      style={{ left: x, top: y }}
    >
      <span className="block size-12 rotate-[-6deg] scale-110 [filter:drop-shadow(0_8px_16px_rgba(0,0,0,0.55))_drop-shadow(0_0_8px_hsl(var(--primary)/0.6))]">
        <Avatar className="size-12 clip-corner-lg ring-2 ring-primary">
          <AvatarImage src={info?.icon} alt={name} />
          <AvatarFallback className="bg-secondary font-semibold text-primary">
            {initial}
          </AvatarFallback>
        </Avatar>
      </span>
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
  // fires. `touch-action: none` is set in the class so touch long-press works.
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

  const triggerClass = "group relative flex items-center justify-center shrink-0 touch-none";

  const dragClass = cn(
    draggable && "cursor-grab",
    dragging && "cursor-grabbing",
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
  const interactionProps = draggable ? { "data-server-url": url } : {};

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
}: {
  communityId: string;
  name: string;
  onNavigate?: () => void;
}) {
  const initials = name.trim().slice(0, 2).toUpperCase() || "··";
  // Resolve the community's authoritative GroupRoot icon: rehydrate from the
  // membership bundle, overlay the folded metadata (the owner-controlled icon),
  // then decrypt the encrypted Blossom blob for display. Falls back to initials.
  const community = useConcordCommunity(communityId);
  const { data: folded } = useConcordMetadata(community);
  // Resolve the icon descriptor with a synchronous, disk-backed fallback so it's
  // present on the first frame after reload (the folded metadata that normally
  // carries it lands asynchronously, which is what made the avatar flicker).
  const { icon } = useCommunityImageDescriptors(community, folded);
  const iconUrl = useDecryptedCommunityImage(icon);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <NavLink
          to={`/c/${encodeURIComponent(communityId)}`}
          aria-label={name}
          onClick={onNavigate}
          className="group relative flex items-center justify-center shrink-0"
        >
          {({ isActive }) => (
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
                  <img src={iconUrl} alt="" className="size-full object-cover" />
                ) : (
                  <span className="text-sm font-semibold">{initials}</span>
                )}
              </span>
              {/* Shield sits in the lower-left corner, OUTSIDE the clipped box so
                  the corner-clip can't crop it. */}
              <span className="absolute -bottom-1 -left-1 z-10 flex size-4 items-center justify-center rounded-full bg-success text-success-foreground ring-2 ring-background">
                <ShieldCheck className="size-2.5" />
              </span>
            </span>
          )}
        </NavLink>
      </TooltipTrigger>
      <TooltipContent side="right" className="font-medium">
        {name}
        <span className="block text-xs text-success">End-to-end encrypted</span>
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
  const hasUnreadDMs = useHasUnreadDMs();
  const { mutateAsync: updateList } = useUpdateUserGroupList();
  const { data: concord } = useConcordList();
  const [addOpen, setAddOpen] = useState(false);

  // Build the full rail list (pinned platform relays + user-added ones),
  // de-duplicated, then apply the user's saved rail order (`config.serverOrder`)
  // on top. Any server missing from the saved order keeps its default position
  // (pinned first, then added); unknown saved entries are ignored.
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
    const order = config.serverOrder.filter((u) => seen.has(u));
    if (order.length === 0) return base;
    const ordered = [...order];
    for (const url of base) {
      if (!order.includes(url)) ordered.push(url);
    }
    return ordered;
  }, [config.addedRelays, config.serverOrder]);

  // Long-press drag-to-reorder for the servers. Works for both touch and mouse
  // via pointer events: press and hold (~300ms) to pick a server up, then drag
  // to slide it into a new spot — the other icons shift to open a gap and a
  // floating ghost follows the pointer. A short press/tap still navigates.
  //
  // The rendered DOM order never changes during a drag (it stays `servers`);
  // instead each icon gets a vertical `shiftY` to open the drop gap. This
  // avoids reading the DOM mid-animation, which previously caused flicker.
  const [dragUrl, setDragUrl] = useState<string | null>(null);
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  // Target slot index (in the original `servers` list) the dragged item lands.
  const [targetIndex, setTargetIndex] = useState<number | null>(null);
  const navRef = useRef<HTMLElement | null>(null);
  const longPressTimer = useRef<number | null>(null);
  const startPos = useRef<{ x: number; y: number } | null>(null);
  // Tracks the in-flight drag outside React state (read inside listeners).
  const dragActive = useRef<string | null>(null);
  // Set briefly after a drag so the ensuing click doesn't navigate/select.
  const didDragRef = useRef(false);
  // Snapshot of the order at drag start, so the math is stable mid-gesture.
  const serversRef = useRef(servers);
  serversRef.current = servers;
  // Frozen slot centers (viewport Y) + pitch, captured once at pickup from
  // clean DOM. Drives the arithmetic, never re-measured during the drag.
  const slotCentersRef = useRef<number[]>([]);
  const pitchRef = useRef(68);
  const targetIndexRef = useRef<number | null>(null);
  targetIndexRef.current = targetIndex;

  const persistOrder = useCallback(
    (list: string[]) => {
      // Persist the rail order in app config (covers pinned + added servers).
      updateConfig((current) => ({ ...current, serverOrder: list }));

      // Also sync the relative order of user-added relays to the kind 10009
      // list (the cross-device source of truth for the added-server set).
      const pinnedSet = new Set(PLATFORM_RELAYS);
      const addedOrder = list.filter((u) => !pinnedSet.has(u));
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

  /** Build the reordered url list from a target index. */
  const orderForTarget = useCallback((draggedUrl: string, target: number): string[] => {
    const without = serversRef.current.filter((u) => u !== draggedUrl);
    const clamped = Math.max(0, Math.min(target, without.length));
    const next = [...without];
    next.splice(clamped, 0, draggedUrl);
    return next;
  }, []);

  const handleServerPointerDown = useCallback(
    (url: string, e: PointerEvent) => {
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
            ti === null ? serversRef.current : orderForTarget(dragActive.current, ti);
          persistOrder(finalOrder);
          didDragRef.current = true;
          // Keep the guard up long enough to swallow the click that the
          // browser synthesizes after pointerup, then clear it.
          window.setTimeout(() => {
            didDragRef.current = false;
          }, 300);
        }
        dragActive.current = null;
        setDragUrl(null);
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
          const els = nav.querySelectorAll<HTMLElement>("[data-server-url]");
          els.forEach((el) => {
            const r = el.getBoundingClientRect();
            centers.push(r.top + r.height / 2);
          });
        }
        slotCentersRef.current = centers;
        if (centers.length >= 2) pitchRef.current = centers[1] - centers[0];

        dragActive.current = url;
        setDragUrl(url);
        setDragPos({ x: e.clientX, y: e.clientY });
        setTargetIndex(serversRef.current.indexOf(url));
        // Haptic nudge on supported devices.
        navigator.vibrate?.(15);
      }, 300);
    },
    [indexForY, orderForTarget, persistOrder],
  );

  // Per-item vertical shift while dragging: each icon translates from its
  // original slot to the slot it would occupy in the previewed order. Pure
  // arithmetic off frozen state — no DOM reads — so it can't feedback/flicker.
  const reordering = dragUrl !== null;
  const shiftFor = useCallback(
    (url: string): number => {
      if (!dragUrl || targetIndex === null || url === dragUrl) return 0;
      const previewOrder = orderForTarget(dragUrl, targetIndex);
      const fromIdx = servers.indexOf(url);
      const toIdx = previewOrder.indexOf(url);
      if (fromIdx === -1 || toIdx === -1) return 0;
      return (toIdx - fromIdx) * pitchRef.current;
    },
    [dragUrl, targetIndex, servers, orderForTarget],
  );

  return (
    <nav
      ref={navRef}
      aria-label="Servers"
      className={cn(
        // Chrome plane — deepest part of the recessed frame. The rail reaches
        // both screen edges on mobile, so it owns the top/bottom safe-area
        // insets (status bar above, gesture/nav bar below) on top of its base
        // padding. On desktop the env() insets are 0, so this is a no-op there.
        "flex flex-col items-center gap-5 w-[72px] shrink-0 overflow-y-auto bg-chrome-deep",
        "pt-[calc(0.75rem+var(--safe-area-inset-top,env(safe-area-inset-top,0px)))]",
        "pb-[calc(0.75rem+var(--safe-area-inset-bottom,env(safe-area-inset-bottom,0px)))]",
        // Lock scrolling while dragging so the rail doesn't fight the gesture.
        dragUrl && "overflow-hidden",
        className,
      )}
    >
      {/* Nearby Bluetooth mesh chat — peer-to-peer, above DMs. Android-only at
          runtime; the page shows an "unavailable here" state elsewhere, so the
          entry is always present when signed in. */}
      {user && (
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
                  <Radio className="size-5" />
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

      {servers.map((url) => (
        <ServerButton
          key={url}
          url={url}
          onNavigate={onNavigate}
          onSelect={onServerSelect}
          selected={onServerSelect ? selectedServer === url : undefined}
          inCall={!activeCall?.dmPeer && activeCall?.relayUrl === url}
          draggable={servers.length > 1}
          dragging={dragUrl === url}
          shiftY={shiftFor(url)}
          reordering={reordering}
          onDragPointerDown={(e) => handleServerPointerDown(url, e)}
          shouldSuppressClick={() => didDragRef.current}
        />
      ))}

      <div className="w-7 h-px bg-chrome-divider shrink-0" />

      {/* End-to-end-encrypted Concord communities (distinct trust model from the
          relay-hosted servers above; rendered from the encrypted membership list). */}
      {user && concord && concord.list.entries.length > 0 && (
        <>
          {concord.list.entries.map((entry) => (
            <ConcordButton
              key={entry.communityId}
              communityId={entry.communityId}
              name={entry.current.name}
              onNavigate={onNavigate}
            />
          ))}
          <div className="w-7 h-px bg-chrome-divider shrink-0" />
        </>
      )}

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
      {dragUrl && dragPos && <DragGhost url={dragUrl} x={dragPos.x} y={dragPos.y} />}
    </nav>
  );
}
