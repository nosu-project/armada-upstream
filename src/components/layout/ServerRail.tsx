import { Bluetooth, FolderOpen, Headphones, Lock, MessageSquare, Plus, Settings } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";

import type React from "react";

import { AddDialog } from "@/components/dialogs/AddDialog";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAppContext } from "@/hooks/useAppContext";
import { useCall } from "@/hooks/useCall";
import { useConcordList, useConcordCommunity } from "@/concord-v1/hooks/useConcordList";
import { useConcord1Unread } from "@/concord-v1/hooks/useConcord1Unread";
import { useConcordMetadata } from "@/concord-v1/hooks/useConcordMetadata";
import { useCommunityImageDescriptors } from "@/concord-v1/hooks/useCommunityImageDescriptors";
import { useDecryptedCommunityImage } from "@/concord-v1/hooks/useDecryptedCommunityImage";
import { useCommunity2, useIsExcluded2, useLiveCommunities2 } from "@/concord-v2/hooks/useCommunityList2";
import { useChannels2, useControlFold2 } from "@/concord-v2/hooks/useControlPlane2";
import { useConcord2Unread } from "@/concord-v2/hooks/useConcord2Unread";
import { useDecryptedImage2 } from "@/concord-v2/hooks/useDecryptedImage2";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useHasUnreadDMs } from "@/hooks/useDirectMessages";
import { useMeshTransport } from "@/hooks/useMeshTransport";
import { useMutes } from "@/hooks/useMutes";
import { useNotifLevels, communityScopeKey } from "@/hooks/useNotifLevels";
import { NotifLevelMenu } from "@/components/NotifLevelMenu";
import { useRelayGroups } from "@/hooks/useRelayGroups";
import { useRelayInfo } from "@/hooks/useRelayInfo";
import { useRelayUnread } from "@/hooks/useRelayUnread";
import { useServerActions } from "@/hooks/useServerActions";
import { useUpdateUserGroupList } from "@/hooks/useUserGroupList";
import { impact } from "@/lib/haptics";
import { normalizeRelayUrl, PINNED_RAIL_RELAYS, relayToRouteParam } from "@/lib/platform";
import {
  applyDrop,
  dissolveFolder,
  flattenLayout,
  folderAnchor,
  itemAnchor,
  mergeLayout,
  normalizeLayout,
  planDrop,
  renameFolder,
} from "@/lib/railLayout";
import { cn } from "@/lib/utils";

import type {
  RailDragSource,
  RailDropPlan,
  RailLayoutNode,
  RailSlot,
} from "@/lib/railLayout";

function RailTooltipContent({ className, ...props }: React.ComponentProps<typeof TooltipContent>) {
  return <TooltipContent className={cn("rail-tooltip-content", className)} {...props} />;
}

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
 * flavours of Concord community live in one list; each carries a stable `key`
 * used for drag/reorder, folders, and the persisted layout.
 */
type RailItem =
  | { kind: "server"; key: string; url: string }
  | { kind: "concord1"; key: string; communityId: string; name: string }
  | { kind: "concord2"; key: string; communityId: string; name: string };

/** Stable rail key for a Concord V1 community. */
const concord1Key = (communityId: string) => `c1:${communityId}`;
/** Stable rail key for a Concord V2 community. */
const concord2Key = (communityId: string) => `c2:${communityId}`;

/** A rail node resolved against the currently-live items (render model). */
type RenderNode =
  | { type: "item"; item: RailItem }
  | { type: "folder"; id: string; name: string; items: RailItem[] };

/**
 * Drag-related props shared by every rail entry (items and folders). The rail
 * attaches pointer listeners natively via a ref (Radix `asChild` Slots do not
 * reliably forward React pointer props), and tags each draggable node with
 * `data-rail-anchor` (+ `data-rail-parent` for folder children) so slot
 * geometry can be frozen at drag pickup.
 */
interface RailDragProps {
  /** Whether this entry can be drag-reordered. */
  draggable?: boolean;
  /** This entry is the one currently being dragged (dims to placeholder). */
  dragging?: boolean;
  /** Whether any drag is in progress (locks touch-action). */
  reordering?: boolean;
  /** This entry is the current drop target (combine / drop-into-folder). */
  highlight?: boolean;
  /** Folder id when this entry is rendered inside an expanded folder. */
  dragParent?: string;
  /** Begin a potential drag from this entry. */
  onDragPointerDown?: (e: PointerEvent) => void;
  /** Returns true if a click should be suppressed (a drag just finished). */
  shouldSuppressClick?: () => boolean;
}

/** data-* attributes identifying a draggable node for slot hit-testing. */
function dragAttrs(anchor: string, parent?: string): Record<string, string> {
  return { "data-rail-anchor": anchor, ...(parent ? { "data-rail-parent": parent } : {}) };
}

/** Attach a native pointerdown listener (see RailDragProps docs). */
function useDragPointerDown(
  ref: React.RefObject<HTMLElement | null>,
  draggable: boolean | undefined,
  onDragPointerDown: ((e: PointerEvent) => void) | undefined,
) {
  const handlerRef = useRef(onDragPointerDown);
  handlerRef.current = onDragPointerDown;
  useEffect(() => {
    const el = ref.current;
    if (!el || !draggable) return;
    const handler = (e: PointerEvent) => handlerRef.current?.(e);
    el.addEventListener("pointerdown", handler);
    return () => el.removeEventListener("pointerdown", handler);
  }, [ref, draggable]);
}

// ─── Mini icons (folder grids + drag ghosts) ────────────────────────────

/** Tiny unread/mention dot for mini icons inside a collapsed folder. */
function MiniUnreadDot({ mention, unread }: { mention: boolean; unread: boolean }) {
  if (!mention && !unread) return null;
  return (
    <span
      className={cn(
        "absolute -top-px -right-px z-10 size-1.5 rounded-full ring-1 ring-background",
        mention ? "bg-primary" : "bg-foreground",
      )}
      aria-label={mention ? "You were mentioned" : "Unread messages"}
    />
  );
}

function ServerMiniIcon({ url }: { url: string }) {
  const { data: info } = useRelayInfo(url);
  const { user } = useCurrentUser();
  const { data: groups } = useRelayGroups(user ? url : undefined);
  const groupIds = useMemo(() => (groups ?? []).map((g) => g.id), [groups]);
  const { anyUnread, anyMention } = useRelayUnread(user ? url : undefined, groupIds);
  const name = info?.name || relayHost(url);
  const initial = name.trim().charAt(0).toUpperCase() || "?";
  return (
    <span className="relative flex items-center justify-center overflow-hidden rounded-sm bg-secondary">
      {info?.icon ? (
        <img src={info.icon} alt="" draggable={false} className="size-full object-cover" />
      ) : (
        <span className="text-[9px] font-semibold leading-none text-secondary-foreground">{initial}</span>
      )}
      <MiniUnreadDot mention={anyMention} unread={anyUnread} />
    </span>
  );
}

function Concord1MiniIcon({ communityId, name }: { communityId: string; name: string }) {
  const community = useConcordCommunity(communityId);
  const { data: folded } = useConcordMetadata(community, false);
  const { icon } = useCommunityImageDescriptors(community, folded);
  const iconUrl = useDecryptedCommunityImage(icon);
  const initial = name.trim().charAt(0).toUpperCase() || "·";
  const { byChannel } = useConcord1Unread(community);
  const { isConcordChannelMuted } = useMutes();
  return (
    <span className="relative flex items-center justify-center overflow-hidden rounded-sm bg-muted text-success">
      {iconUrl ? (
        <img src={iconUrl} alt="" draggable={false} className="size-full object-cover" />
      ) : (
        <span className="text-[9px] font-semibold leading-none">{initial}</span>
      )}
      <MiniUnreadDot
        mention={Object.values(byChannel).some((u) => u.mention)}
        unread={Object.keys(byChannel).some((id) => !isConcordChannelMuted("c1", communityId, id))}
      />
    </span>
  );
}

function Concord2MiniIcon({ communityId, name }: { communityId: string; name: string }) {
  const community = useCommunity2(communityId);
  const { data: folded } = useControlFold2(community, false);
  const iconUrl = useDecryptedImage2(folded?.metadata?.icon);
  const displayName = folded?.metadata?.name || name;
  const initial = displayName.trim().charAt(0).toUpperCase() || "·";
  const channels = useChannels2(community, false);
  const { byChannel } = useConcord2Unread(channels);
  const { isConcordChannelMuted } = useMutes();
  return (
    <span className="relative flex items-center justify-center overflow-hidden rounded-sm bg-muted text-success">
      {iconUrl ? (
        <img src={iconUrl} alt="" draggable={false} className="size-full object-cover" />
      ) : (
        <span className="text-[9px] font-semibold leading-none">{initial}</span>
      )}
      <MiniUnreadDot
        mention={Object.values(byChannel).some((u) => u.mention)}
        unread={Object.keys(byChannel).some((id) => !isConcordChannelMuted("c2", communityId, id))}
      />
    </span>
  );
}

function RailMiniIcon({ item }: { item: RailItem }) {
  if (item.kind === "server") return <ServerMiniIcon url={item.url} />;
  if (item.kind === "concord1") {
    return <Concord1MiniIcon communityId={item.communityId} name={item.name} />;
  }
  return <Concord2MiniIcon communityId={item.communityId} name={item.name} />;
}

// ─── Unread probes (folder-level notification rollup) ───────────────────
//
// A collapsed folder must light up when ANY member has activity — including
// members beyond the four shown in its mini grid. Hooks can't be called in a
// loop, so each member mounts an invisible probe component that runs its
// kind's unread hooks and reports the result up to the folder.

function ServerUnreadProbe({
  url,
  onChange,
}: {
  url: string;
  onChange: (unread: boolean, mention: boolean) => void;
}) {
  const { user } = useCurrentUser();
  const { data: groups } = useRelayGroups(user ? url : undefined);
  const groupIds = useMemo(() => (groups ?? []).map((g) => g.id), [groups]);
  const { anyUnread, anyMention } = useRelayUnread(user ? url : undefined, groupIds);
  useEffect(() => onChange(anyUnread, anyMention), [anyUnread, anyMention, onChange]);
  return null;
}

function Concord2UnreadProbe({
  communityId,
  onChange,
}: {
  communityId: string;
  onChange: (unread: boolean, mention: boolean) => void;
}) {
  const community = useCommunity2(communityId);
  const channels = useChannels2(community, false);
  const { byChannel } = useConcord2Unread(channels);
  const { isConcordChannelMuted } = useMutes();
  const unread = Object.keys(byChannel).some(
    (id) => !isConcordChannelMuted("c2", communityId, id),
  );
  const mention = Object.values(byChannel).some((u) => u.mention);
  useEffect(() => onChange(unread, mention), [unread, mention, onChange]);
  return null;
}

function Concord1UnreadProbe({
  communityId,
  onChange,
}: {
  communityId: string;
  onChange: (unread: boolean, mention: boolean) => void;
}) {
  const community = useConcordCommunity(communityId);
  const { byChannel } = useConcord1Unread(community);
  const { isConcordChannelMuted } = useMutes();
  const unread = Object.keys(byChannel).some(
    (id) => !isConcordChannelMuted("c1", communityId, id),
  );
  const mention = Object.values(byChannel).some((u) => u.mention);
  useEffect(() => onChange(unread, mention), [unread, mention, onChange]);
  return null;
}

function RailItemUnreadProbe({
  item,
  onChange,
}: {
  item: RailItem;
  onChange: (unread: boolean, mention: boolean) => void;
}) {
  if (item.kind === "server") return <ServerUnreadProbe url={item.url} onChange={onChange} />;
  if (item.kind === "concord2") {
    return <Concord2UnreadProbe communityId={item.communityId} onChange={onChange} />;
  }
  return <Concord1UnreadProbe communityId={item.communityId} onChange={onChange} />;
}

/**
 * Discord-style collapsed-folder face: a 2×2 grid of the first four member
 * icons inside the rail's cut-corner square.
 */
function FolderMiniGrid({ items }: { items: RailItem[] }) {
  return (
    <span className="grid size-12 grid-cols-2 grid-rows-2 gap-1 clip-corner-lg bg-secondary/80 p-1.5">
      {items.slice(0, 4).map((item) => (
        <RailMiniIcon key={item.key} item={item} />
      ))}
    </span>
  );
}

// ─── Drag ghosts ─────────────────────────────────────────────────────────

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

/** Fixed pointer-following layer carrying the dragged item or folder. */
function DragGhost({
  item,
  folderItems,
  x,
  y,
}: {
  item?: RailItem;
  folderItems?: RailItem[];
  x: number;
  y: number;
}) {
  return (
    <div
      className="pointer-events-none fixed z-[300] -translate-x-1/2 -translate-y-1/2 animate-in zoom-in-75 duration-150"
      style={{ left: x, top: y }}
    >
      {folderItems ? (
        <span className="block rotate-[-6deg] scale-110 [filter:drop-shadow(0_8px_16px_rgba(0,0,0,0.55))_drop-shadow(0_0_8px_hsl(var(--primary)/0.6))]">
          <FolderMiniGrid items={folderItems} />
        </span>
      ) : item?.kind === "server" ? (
        <ServerDragGhost url={item.url} />
      ) : item?.kind === "concord1" ? (
        <Concord1DragGhost communityId={item.communityId} name={item.name} />
      ) : item ? (
        <Concord2DragGhost communityId={item.communityId} name={item.name} />
      ) : null}
    </div>
  );
}

// ─── Rail entries ────────────────────────────────────────────────────────

/**
 * Keeps a rail entry's real content MOUNTED while it is being dragged,
 * hiding it and overlaying the dashed slot placeholder instead. Swapping the
 * subtree out (the old approach) unmounted the exact DOM node the finger was
 * touching — and a detached touch target's events stop bubbling, so Chrome
 * cancelled the whole gesture (pointercancel) on the first movement. This is
 * why touch drags died the moment they were picked up.
 */
function DragSlot({ dragging, children }: { dragging?: boolean; children: React.ReactNode }) {
  return (
    <>
      <span className={cn("contents", dragging && "invisible")}>{children}</span>
      {dragging && (
        <span className="absolute left-1/2 top-1/2 size-12 -translate-x-1/2 -translate-y-1/2 rounded-xl border-2 border-dashed border-primary/50 bg-primary/5" />
      )}
    </>
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
  reordering,
  highlight,
  dragParent,
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
} & RailDragProps) {
  const triggerRef = useRef<HTMLElement | null>(null);
  useDragPointerDown(triggerRef, draggable, onDragPointerDown);

  const { data: info } = useRelayInfo(url);
  const { user } = useCurrentUser();
  const { data: groups } = useRelayGroups(user ? url : undefined);
  const groupIds = useMemo(() => (groups ?? []).map((g) => g.id), [groups]);
  const { anyUnread, anyMention } = useRelayUnread(user ? url : undefined, groupIds);
  const { communityLevel, setLevel: setNotifLevel } = useNotifLevels();
  const { isRemovable, removeServer } = useServerActions(url);
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
          // Drop-combine target: dragging another item onto this one folders them.
          highlight && "rounded-xl ring-2 ring-primary scale-110",
        )}
      >
        <Avatar
          className={cn(
            "size-12 clip-corner-lg transition-all duration-150",
            // Idle-dim + brighten-on-hover, matched to the Concord buttons so
            // NIP-29 servers and encrypted communities share one rail feel.
            "opacity-60 saturate-75 group-hover:opacity-100 group-hover:saturate-100",
            (isActive || highlight) && "opacity-100 saturate-100",
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
    // No grab-on-hover cursor: entries read as normal links until actually
    // picked up (the hover hand suggested HTML5 dragging and confused people).
    // While a drag is live the body carries a global grabbing cursor.
    dragging && "cursor-grabbing",
    // While a reorder is in flight, lock touch-action so the browser can't
    // steal the (mostly vertical) gesture as a pan and stop delivering moves.
    reordering && "touch-none",
  );

  // Identify the draggable node for hit-testing; the pointerdown listener is
  // attached natively via `triggerRef` (see useDragPointerDown).
  const interactionProps = draggable ? dragAttrs(itemAnchor(url), dragParent) : {};

  return (
    <ContextMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <ContextMenuTrigger asChild>
            {onSelect ? (
              <button
                ref={triggerRef as React.RefObject<HTMLButtonElement>}
                type="button"
                aria-label={name}
                onClick={() => {
                  if (shouldSuppressClick?.()) return;
                  onSelect(url);
                }}
                className={cn(triggerClass, dragClass, selected && "is-active")}
                {...interactionProps}
              >
                <DragSlot dragging={dragging}>{inner(Boolean(selected))}</DragSlot>
              </button>
            ) : (
              <NavLink
                ref={triggerRef as React.RefObject<HTMLAnchorElement>}
                to={`/s/${relayToRouteParam(url)}`}
                aria-label={name}
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
                {({ isActive }) => <DragSlot dragging={dragging}>{inner(isActive)}</DragSlot>}
              </NavLink>
            )}
          </ContextMenuTrigger>
        </TooltipTrigger>
        <RailTooltipContent side="right" className="font-medium">
          {name}
          <span className="block text-xs text-muted-foreground">{url}</span>
        </RailTooltipContent>
      </Tooltip>
      <ContextMenuContent>
        <NotifLevelMenu
          label="Server notifications"
          level={communityLevel(url)}
          onChange={(lvl) => setNotifLevel(communityScopeKey(url), lvl)}
        />
        {isRemovable && (
          <ContextMenuItem
            className="text-destructive focus:text-destructive"
            onSelect={removeServer}
          >
            Remove server
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
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
  reordering,
  highlight,
  dragParent,
  onDragPointerDown,
  shouldSuppressClick,
}: {
  communityId: string;
  name: string;
  onNavigate?: () => void;
} & RailDragProps) {
  const triggerRef = useRef<HTMLAnchorElement | null>(null);
  useDragPointerDown(triggerRef, draggable, onDragPointerDown);

  const { communityLevel, setLevel: setNotifLevel } = useNotifLevels();

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

  // Per-channel unread from the wire-fed event store (same model as V2).
  const { byChannel: c1ByChannel } = useConcord1Unread(community);
  const { isConcordChannelMuted } = useMutes();
  const c1AnyUnread = Object.keys(c1ByChannel).some(
    (id) => !isConcordChannelMuted("c1", communityId, id),
  );
  const c1AnyMention = Object.values(c1ByChannel).some((u) => u.mention);

  return (
    <ContextMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <ContextMenuTrigger asChild>
            <NavLink
              ref={triggerRef}
              to={`/c1/${encodeURIComponent(communityId)}`}
              aria-label={name}
              onClick={(e) => {
                if (shouldSuppressClick?.()) {
                  e.preventDefault();
                  return;
                }
                onNavigate?.();
              }}
              className={cn(
                "group relative flex items-center justify-center shrink-0 touch-none",
                dragging && "cursor-grabbing",
                reordering && "touch-none",
              )}
              {...(draggable ? dragAttrs(itemAnchor(concord1Key(communityId)), dragParent) : {})}
            >
              {({ isActive }) => (
                <DragSlot dragging={dragging}>
                  <>
                    {/* Active marker: the same neon blade servers get, so the
                        open room keeps its left-bar highlight (incl. in folders). */}
                    <span
                      className={cn(
                        "absolute -left-2 w-[3px] bg-primary transition-all",
                        isActive
                          ? "h-12 opacity-100"
                          : "h-2 opacity-0 group-hover:opacity-60 group-hover:h-6",
                      )}
                    />
                    <span
                      className={cn(
                        "relative block size-12",
                        highlight && "rounded-xl ring-2 ring-primary scale-110 transition-all duration-150",
                      )}
                    >
                      <span
                        className={cn(
                          "flex items-center justify-center size-12 clip-corner-lg overflow-hidden transition-all duration-150",
                          "bg-muted text-success opacity-60 saturate-75",
                          "group-hover:opacity-100 group-hover:saturate-100",
                          (isActive || highlight) && "opacity-100 saturate-100",
                          isActive && "is-active",
                        )}
                      >
                        {iconUrl ? (
                          <img src={iconUrl} alt="" draggable={false} className="size-full object-cover" />
                        ) : (
                          <span className="text-sm font-semibold">{initials}</span>
                        )}
                      </span>
                      {/* Unread / mention indicator (hidden while active — you're reading it). */}
                      {!isActive && c1AnyMention ? (
                        <span
                          className="absolute -top-1 -right-1 z-10 flex min-w-4 h-4 px-1 items-center justify-center rounded-full bg-primary text-primary-foreground text-[10px] font-bold leading-none ring-2 ring-background"
                          aria-label="You were mentioned"
                        >
                          @
                        </span>
                      ) : !isActive && c1AnyUnread ? (
                        <span
                          className="absolute -top-0.5 -right-0.5 z-10 size-3 rounded-full bg-foreground ring-2 ring-background"
                          aria-label="Unread messages"
                        />
                      ) : null}
                    </span>
                  </>
                </DragSlot>
              )}
            </NavLink>
          </ContextMenuTrigger>
        </TooltipTrigger>
        <RailTooltipContent side="right" className="font-medium">
          {name}
        </RailTooltipContent>
      </Tooltip>
      <ContextMenuContent>
        <NotifLevelMenu
          label="Community notifications"
          level={communityLevel(concord1Key(communityId))}
          onChange={(lvl) => setNotifLevel(concord1Key(communityId), lvl)}
          allowMentions={false}
        />
      </ContextMenuContent>
    </ContextMenu>
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
  reordering,
  highlight,
  dragParent,
  onDragPointerDown,
  shouldSuppressClick,
}: {
  communityId: string;
  name: string;
  onNavigate?: () => void;
} & RailDragProps) {
  const triggerRef = useRef<HTMLAnchorElement | null>(null);
  useDragPointerDown(triggerRef, draggable, onDragPointerDown);

  const community = useCommunity2(communityId);
  // Rail buttons only need the icon/name, which the fold serves from its
  // persisted snapshot. Pass active=false so we DON'T fan out a control-plane
  // REQ per relay for every community on pageload — the community's page
  // (active=true) syncs it on navigation, sharing this query key.
  const { data: folded } = useControlFold2(community, false);
  // Kicked/banned: the icon STAYS (only Leave/Dissolve remove it), but we mark
  // it so the user isn't left wondering why the room went read-only.
  const excluded = useIsExcluded2(communityId);
  const displayName = folded?.metadata?.name || name;
  const initials = displayName.trim().slice(0, 2).toUpperCase() || "··";
  const iconUrl = useDecryptedImage2(folded?.metadata?.icon);

  // Aggregate unread across the community's channels, computed purely from the
  // local rumor cache (no extra relay fan-out — active=false shares the fold
  // query key). Mirrors the NIP-29 rail badge. Muted channels (or a muted
  // community) don't light the unread dot; unread mentions still badge.
  const channels = useChannels2(community, false);
  const { byChannel } = useConcord2Unread(channels);
  const { isConcordChannelMuted } = useMutes();
  const { communityLevel, setLevel: setNotifLevel } = useNotifLevels();

  const anyUnread = Object.keys(byChannel).some(
    (id) => !isConcordChannelMuted("c2", communityId, id),
  );
  const anyMention = Object.values(byChannel).some((u) => u.mention);

  return (
    <ContextMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <ContextMenuTrigger asChild>
            <NavLink
              ref={triggerRef}
          to={`/c/${encodeURIComponent(communityId)}`}
          aria-label={displayName}
          onClick={(e) => {
            if (shouldSuppressClick?.()) {
              e.preventDefault();
              return;
            }
            onNavigate?.();
          }}
          className={cn(
            "group relative flex items-center justify-center shrink-0 touch-none",
            dragging && "cursor-grabbing",
            reordering && "touch-none",
          )}
          {...(draggable ? dragAttrs(itemAnchor(concord2Key(communityId)), dragParent) : {})}
        >
          {({ isActive }) => (
            <DragSlot dragging={dragging}>
              <>
                {/* Active marker: the same neon blade servers get, so the
                    open room keeps its left-bar highlight (incl. in folders). */}
                <span
                  className={cn(
                    "absolute -left-2 w-[3px] bg-primary transition-all",
                    isActive
                      ? "h-12 opacity-100"
                      : "h-2 opacity-0 group-hover:opacity-60 group-hover:h-6",
                  )}
                />
                <span
                  className={cn(
                    "relative block size-12",
                    highlight && "rounded-xl ring-2 ring-primary scale-110 transition-all duration-150",
                  )}
                >
                  <span
                    className={cn(
                      "flex items-center justify-center size-12 clip-corner-lg overflow-hidden transition-all duration-150",
                      "bg-muted text-success opacity-60 saturate-75",
                      "group-hover:opacity-100 group-hover:saturate-100",
                      (isActive || highlight) && "opacity-100 saturate-100",
                      isActive && "is-active",
                    )}
                  >
                    {iconUrl ? (
                      <img src={iconUrl} alt="" draggable={false} className="size-full object-cover" />
                    ) : (
                      <span className="text-sm font-semibold">{initials}</span>
                    )}
                  </span>
                  {/* Excluded (kicked/banned): a lock badge; the icon stays put
                      until the user leaves or is re-included by a Refounding. */}
                  {excluded ? (
                    <span
                      className="absolute -bottom-1 -right-1 z-10 flex size-4 items-center justify-center rounded-full bg-muted text-muted-foreground ring-2 ring-background"
                      aria-label="You no longer have access to this community"
                    >
                      <Lock className="size-2.5" />
                    </span>
                  ) : null}
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
            </DragSlot>
          )}
        </NavLink>
          </ContextMenuTrigger>
        </TooltipTrigger>
        <RailTooltipContent side="right" className="font-medium">
          {displayName}
          {excluded ? <span className="ml-1 font-normal text-muted-foreground">· no access</span> : null}
        </RailTooltipContent>
      </Tooltip>
      <ContextMenuContent>
        <NotifLevelMenu
          label="Community notifications"
          level={communityLevel(concord2Key(communityId))}
          onChange={(lvl) => setNotifLevel(concord2Key(communityId), lvl)}
        />
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * A Discord-style server folder in the rail. Collapsed it shows a 2×2 grid of
 * its members' icons; clicking expands it in place, listing the members
 * inside a tinted container. Right-click to rename or remove (dissolve) it.
 * The folder itself drags as one unit to reorder it in the rail.
 */
function RailFolder({
  id,
  name,
  items,
  open,
  active,
  onToggle,
  onRenameRequest,
  onDissolve,
  draggable,
  dragging,
  reordering,
  highlight,
  onDragPointerDown,
  shouldSuppressClick,
  children,
}: {
  id: string;
  name: string;
  items: RailItem[];
  open: boolean;
  /** A member of this folder is the active route (shown while collapsed). */
  active: boolean;
  onToggle: () => void;
  onRenameRequest: () => void;
  onDissolve: () => void;
  children?: React.ReactNode;
} & RailDragProps) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  useDragPointerDown(triggerRef, draggable, onDragPointerDown);

  const label = name.trim() || "Folder";

  // Aggregate unread/mention across ALL members (not just the four visible
  // in the mini grid), reported by the invisible per-member probes below.
  // Shown on the folder face only while collapsed — expanded, the members'
  // own buttons carry their badges.
  const [memberUnread, setMemberUnread] = useState<
    Record<string, { unread: boolean; mention: boolean }>
  >({});
  const reportUnread = useCallback((key: string, unread: boolean, mention: boolean) => {
    setMemberUnread((prev) => {
      const cur = prev[key];
      if (cur && cur.unread === unread && cur.mention === mention) return prev;
      return { ...prev, [key]: { unread, mention } };
    });
  }, []);
  const anyUnread = !open && items.some((it) => memberUnread[it.key]?.unread);
  const anyMention = !open && items.some((it) => memberUnread[it.key]?.mention);
  const probes = !open
    ? items.map((it) => (
        <RailItemUnreadProbe
          key={it.key}
          item={it}
          onChange={(unread, mention) => reportUnread(it.key, unread, mention)}
        />
      ))
    : null;

  const header = (
    <ContextMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <ContextMenuTrigger asChild>
            <button
              ref={triggerRef}
              type="button"
              aria-label={label}
              aria-expanded={open}
              onClick={() => {
                if (shouldSuppressClick?.()) return;
                onToggle();
              }}
              className={cn(
                "group relative flex items-center justify-center shrink-0 touch-none cursor-pointer",
                dragging && "cursor-grabbing",
                reordering && "touch-none",
              )}
              {...(draggable ? dragAttrs(folderAnchor(id)) : {})}
            >
              {/* Active blade while collapsed (a member is the open route). */}
              <span
                className={cn(
                  "absolute -left-2 w-[3px] bg-primary transition-all",
                  !open && active
                    ? "h-12 opacity-100"
                    : "h-2 opacity-0 group-hover:opacity-60 group-hover:h-6",
                )}
              />
              <DragSlot dragging={dragging && !open}>
                <span
                  className={cn(
                    "relative block size-12 transition-all duration-150",
                    highlight && "rounded-xl ring-2 ring-primary scale-110",
                  )}
                >
                  {/* Dimming lives on an inner wrapper so the notification
                      badge outside it stays at full strength (mirrors how
                      server buttons keep badges outside the dimmed avatar). */}
                  <span
                    className={cn(
                      "block size-12 transition-all duration-150",
                      !open && !active && !highlight &&
                        "opacity-70 saturate-75 group-hover:opacity-100 group-hover:saturate-100",
                    )}
                  >
                    {open ? (
                      <span className="flex size-12 items-center justify-center clip-corner-lg bg-secondary/80 text-primary">
                        <FolderOpen className="size-5" />
                      </span>
                    ) : (
                      <FolderMiniGrid items={items} />
                    )}
                  </span>
                  {/* Folder-level rollup: any member mentioned / unread. */}
                  {anyMention ? (
                    <span
                      className="absolute -top-1 -right-1 z-10 flex min-w-4 h-4 px-1 items-center justify-center rounded-full bg-primary text-primary-foreground text-[10px] font-bold leading-none ring-2 ring-background"
                      aria-label="You were mentioned"
                    >
                      @
                    </span>
                  ) : anyUnread ? (
                    <span
                      className="absolute -top-0.5 -right-0.5 z-10 size-3 rounded-full bg-foreground ring-2 ring-background"
                      aria-label="Unread messages"
                    />
                  ) : null}
                </span>
              </DragSlot>
            </button>
          </ContextMenuTrigger>
        </TooltipTrigger>
        <RailTooltipContent side="right" className="font-medium">
          {label}
          <span className="block text-xs text-muted-foreground">
            {items.length === 1 ? "1 community" : `${items.length} communities`}
          </span>
        </RailTooltipContent>
      </Tooltip>
      <ContextMenuContent>
        <ContextMenuItem onSelect={onRenameRequest}>Rename folder</ContextMenuItem>
        <ContextMenuItem onSelect={onDissolve}>Remove folder</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );

  if (!open) {
    return (
      <>
        {probes}
        {header}
      </>
    );
  }

  return (
    <div
      className={cn(
        "flex flex-col items-center gap-4 sidebar:gap-5 shrink-0 rounded-2xl bg-secondary/40 px-1.5 py-1.5 transition-colors",
        // While this folder itself is being dragged, dim it in place (its
        // frozen slot geometry must not change mid-gesture).
        dragging && "opacity-40",
      )}
    >
      {header}
      {children}
    </div>
  );
}

/**
 * Far-left vertical rail listing every community — NIP-29 servers and Concord
 * (V1/V2) communities in one user-arranged list with Discord-style folders —
 * plus DMs, add-community and settings actions.
 *
 * Drag interactions (Discord semantics):
 * - Mouse: press and move a few pixels to pick an entry up immediately.
 * - Touch: press and hold (~300ms), then drag (a short tap navigates).
 * - Drop in a gap to reorder; drop onto another community to create a folder;
 *   drop onto a folder to move it inside; drag out of a folder to remove it.
 *   Folders holding a single item dissolve automatically.
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
  const location = useLocation();
  const { activeCall } = useCall();
  const { user } = useCurrentUser();
  const { mesh } = useMeshTransport();
  const hasUnreadDMs = useHasUnreadDMs();
  const { mutateAsync: updateList } = useUpdateUserGroupList();
  const { data: concord } = useConcordList();
  const concord2 = useLiveCommunities2();
  const [addOpen, setAddOpen] = useState(false);

  // Build the full rail list (any opt-in pinned relays + user-added ones),
  // de-duplicated. By default `PINNED_RAIL_RELAYS` is empty, so the rail shows
  // only servers the user actually added/joined (via an invite/server link).
  // Order/grouping is applied by the layout below.
  const servers = useMemo(() => {
    const base: string[] = [];
    const seen = new Set<string>();
    for (const url of [...PINNED_RAIL_RELAYS, ...config.addedRelays]) {
      const normalized = normalizeRelayUrl(url);
      if (normalized && !seen.has(normalized)) {
        seen.add(normalized);
        base.push(normalized);
      }
    }
    return base;
  }, [config.addedRelays]);

  // Every live rail item (NIP-29 servers and Concord V1/V2 communities) in
  // discovery order. The persisted layout arranges these into the visible
  // ordered list + folders.
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
    return base;
  }, [servers, concord, concord2, user]);

  const liveByKey = useMemo(() => new Map(items.map((it) => [it.key, it])), [items]);

  // The working layout: the synced `railLayout` (seeded from the legacy flat
  // `railOrder` when absent) with newly-discovered items appended. Keys the
  // layout knows but that aren't live yet (still loading / since removed) are
  // KEPT in the data — they're only skipped at render — so an early drag can't
  // wipe another device's folders.
  const layout = useMemo(
    () => mergeLayout(config.railLayout, config.railOrder, items.map((it) => it.key)),
    [config.railLayout, config.railOrder, items],
  );
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  // Resolve the layout against live items for rendering.
  const renderNodes = useMemo<RenderNode[]>(() => {
    const out: RenderNode[] = [];
    for (const node of layout) {
      if (node.type === "item") {
        const item = liveByKey.get(node.key);
        if (item) out.push({ type: "item", item });
      } else {
        const kids = node.keys
          .map((k) => liveByKey.get(k))
          .filter((it): it is RailItem => it !== undefined);
        if (kids.length > 0) out.push({ type: "folder", id: node.id, name: node.name, items: kids });
      }
    }
    return out;
  }, [layout, liveByKey]);

  const openFolders = useMemo(() => new Set(config.railOpenFolders), [config.railOpenFolders]);
  const toggleFolder = useCallback(
    (id: string) => {
      updateConfig((current) => {
        const open = new Set(current.railOpenFolders);
        if (open.has(id)) open.delete(id);
        else open.add(id);
        return { ...current, railOpenFolders: [...open] };
      });
    },
    [updateConfig],
  );

  /** Whether a rail item is the active route / drawer selection. */
  const isItemActive = useCallback(
    (item: RailItem): boolean => {
      if (item.kind === "server" && onServerSelect) return selectedServer === item.url;
      const base =
        item.kind === "server"
          ? `/s/${relayToRouteParam(item.url)}`
          : item.kind === "concord1"
            ? `/c1/${encodeURIComponent(item.communityId)}`
            : `/c/${encodeURIComponent(item.communityId)}`;
      return location.pathname === base || location.pathname.startsWith(`${base}/`);
    },
    [location.pathname, onServerSelect, selectedServer],
  );

  /** Persist a layout change everywhere it needs to go. */
  const persistLayout = useCallback(
    (nodes: RailLayoutNode[]) => {
      const normalized = normalizeLayout(nodes);
      const keys = flattenLayout(normalized);
      updateConfig((current) => ({
        ...current,
        // The structured layout (items + folders) — the source of truth.
        railLayout: normalized,
        // Flattened orders kept in sync for the QuickSwitcher and for older
        // clients that only understand the flat lists.
        railOrder: keys,
        serverOrder: keys.filter((k) => !k.startsWith("c1:") && !k.startsWith("c2:")),
      }));

      // Also sync the relative order of user-added relays to the kind 10009
      // list (the cross-device source of truth for the added-server set).
      const pinnedSet = new Set(PINNED_RAIL_RELAYS);
      const addedOrder = keys.filter(
        (k) => !k.startsWith("c1:") && !k.startsWith("c2:") && !pinnedSet.has(k),
      );
      if (user && addedOrder.length > 0) {
        updateList({ type: "reorder-servers", urls: addedOrder }).catch((err) =>
          console.warn("Failed to persist server order:", err),
        );
      }
    },
    [updateConfig, updateList, user],
  );

  // ─── Drag to reorder / fold (Discord semantics) ─────────────────────────
  //
  // Press and hold (~300ms) picks an entry up on every pointer type — the
  // cursor flips to the grabbing hand at that moment, never on mere movement.
  // Mouse movement during the hold neither triggers nor cancels the pickup
  // (the long press still completes, at the cursor's current position); on
  // touch, early movement converts the gesture to a scroll instead.
  //
  // The rendered DOM order never changes during a drag; slot geometry is
  // frozen at pickup and a fixed-position indicator line / target highlight
  // previews the drop (`planDrop`). On release the drop is applied to the
  // layout (`applyDrop`) and persisted.
  const [dragSource, setDragSource] = useState<RailDragSource | null>(null);
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  const [dropPlan, setDropPlan] = useState<RailDropPlan | null>(null);
  const navRef = useRef<HTMLElement | null>(null);
  const longPressTimer = useRef<number | null>(null);
  const startPos = useRef<{ x: number; y: number } | null>(null);
  // Tracks the in-flight drag outside React state (read inside listeners).
  const dragActive = useRef<RailDragSource | null>(null);
  // Set briefly after a drag so the ensuing click doesn't navigate/toggle.
  const didDragRef = useRef(false);
  // Frozen slot geometry + rail frame, captured once at pickup from clean DOM.
  const slotsRef = useRef<RailSlot[]>([]);
  const navRectRef = useRef<{ left: number; width: number } | null>(null);
  const dropPlanRef = useRef<RailDropPlan | null>(null);

  // A PERMANENT non-passive touchmove canceller on the rail. Chrome decides
  // at gesture start (touchstart) whether a blocking touch listener exists in
  // the region; a listener attached mid-gesture (e.g. in pointerdown) is not
  // consulted, its preventDefault is silently ignored, and the browser still
  // pans the rail — killing the drag with pointercancel. This listener exists
  // before any gesture starts, and only cancels moves while a drag is live,
  // so normal rail scrolling stays native. Touch events keep targeting the
  // touchstart element, so drags that wander outside the rail still bubble
  // through it.
  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const onTouchMove = (ev: TouchEvent) => {
      if (dragActive.current !== null && ev.cancelable) ev.preventDefault();
    };
    nav.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => nav.removeEventListener("touchmove", onTouchMove);
  }, []);

  const beginDrag = useCallback((source: RailDragSource, x: number, y: number) => {
    const nav = navRef.current;
    if (nav) {
      const slots: RailSlot[] = [];
      nav.querySelectorAll<HTMLElement>("[data-rail-anchor]").forEach((el) => {
        const r = el.getBoundingClientRect();
        slots.push({
          anchor: el.dataset.railAnchor!,
          parentFolderId: el.dataset.railParent || undefined,
          top: r.top,
          height: r.height,
        });
      });
      slotsRef.current = slots;
      const navRect = nav.getBoundingClientRect();
      navRectRef.current = { left: navRect.left, width: navRect.width };
    }
    dragActive.current = source;
    const plan = planDrop(y, slotsRef.current, source);
    dropPlanRef.current = plan;
    setDragSource(source);
    setDragPos({ x, y });
    setDropPlan(plan);
    // Haptic nudge on supported devices.
    impact("medium");
  }, []);

  const handleDragPointerDown = useCallback(
    (source: RailDragSource, e: PointerEvent) => {
      // Only left mouse / touch / pen; ignore right-click etc.
      if (e.button !== 0 && e.pointerType === "mouse") return;
      startPos.current = { x: e.clientX, y: e.clientY };
      const pointerId = e.pointerId;
      const isMouse = e.pointerType === "mouse";
      // Touch-scroll fallback state (see onMove): set once the gesture is
      // classified as a scroll rather than a long-press drag.
      let manualScroll = false;
      let lastScrollY = e.clientY;
      // Latest pointer position, so a long press that fires after the pointer
      // has wandered picks up at the cursor, not at the press point.
      let lastX = e.clientX;
      let lastY = e.clientY;

      const clear = () => {
        if (longPressTimer.current !== null) {
          window.clearTimeout(longPressTimer.current);
          longPressTimer.current = null;
        }
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        window.removeEventListener("contextmenu", onContextMenu, true);
      };

      // While a drag is in flight, swallow the context menu the browser
      // synthesizes for a touch long-press (~500ms on Android) — it would
      // otherwise pop the folder's Radix menu in the middle of the gesture.
      const onContextMenu = (ev: Event) => {
        if (dragActive.current !== null) {
          ev.preventDefault();
          ev.stopPropagation();
        }
      };

      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        if (dragActive.current === null) {
          lastX = ev.clientX;
          lastY = ev.clientY;
          // Touch gesture that committed to scrolling: pan the rail manually.
          // Entries carry `touch-action: none` (the ONLY reliable way to keep
          // Chrome from claiming the drag as a pan and killing it with
          // pointercancel — its gesture arbitration is racy no matter what we
          // preventDefault), so the browser never scrolls the rail for
          // gestures that start on an entry; we do it here instead.
          if (manualScroll) {
            const nav = navRef.current;
            if (nav) nav.scrollTop -= ev.clientY - lastScrollY;
            lastScrollY = ev.clientY;
            return;
          }
          // Mouse movement neither picks up (only the long press does) nor
          // cancels the pending long press.
          if (isMouse) return;
          const s = startPos.current;
          if (!s) return;
          const dist = Math.hypot(ev.clientX - s.x, ev.clientY - s.y);
          if (dist > 10) {
            // Touch: movement before the long-press fires is a scroll — hand
            // the rest of the gesture to the manual panner above.
            if (longPressTimer.current !== null) {
              window.clearTimeout(longPressTimer.current);
              longPressTimer.current = null;
            }
            manualScroll = true;
            lastScrollY = ev.clientY;
          }
          return;
        }
        ev.preventDefault();
        setDragPos({ x: ev.clientX, y: ev.clientY });
        const plan = planDrop(ev.clientY, slotsRef.current, dragActive.current);
        dropPlanRef.current = plan;
        setDropPlan(plan);
      };

      const onUp = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        if (dragActive.current !== null) {
          const plan = dropPlanRef.current;
          try {
            if (plan) {
              persistLayout(applyDrop(layoutRef.current, dragActive.current, plan.target));
            }
          } catch (err) {
            // Never let a failed drop wedge the drag state / leave listeners
            // attached (this bit us when crypto.randomUUID threw over http).
            console.error("Failed to apply rail drop:", err);
          }
          didDragRef.current = true;
          // Keep the guard up long enough to swallow the click that the
          // browser synthesizes after pointerup, then clear it.
          window.setTimeout(() => {
            didDragRef.current = false;
          }, 300);
        }
        dragActive.current = null;
        dropPlanRef.current = null;
        setDragSource(null);
        setDragPos(null);
        setDropPlan(null);
        clear();
      };

      // The browser reclaimed the pointer (scroll takeover, palm rejection,
      // system gesture): abort WITHOUT applying the drop — the last computed
      // plan no longer reflects the user's intent.
      const onCancel = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        dragActive.current = null;
        dropPlanRef.current = null;
        setDragSource(null);
        setDragPos(null);
        setDropPlan(null);
        clear();
      };

      window.addEventListener("pointermove", onMove, { passive: false });
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
      window.addEventListener("contextmenu", onContextMenu, true);

      // Press-and-hold pickup — the ONLY trigger, on every pointer type.
      // Guarded: a touch gesture that converted to a scroll cleared the timer.
      longPressTimer.current = window.setTimeout(() => {
        if (dragActive.current === null) beginDrag(source, lastX, lastY);
      }, 300);
    },
    [beginDrag, persistLayout],
  );

  const reordering = dragSource !== null;
  const draggable = items.length > 1;
  const shouldSuppressClick = useCallback(() => didDragRef.current, []);

  // While an entry is picked up, carry the grabbing cursor globally as a
  // fallback (the full-viewport overlay below is what makes the flip visible
  // in Chromium; this covers other engines and any hit-test edge cases). At
  // rest, entries show the normal link cursor — the old grab-on-hover hand
  // suggested a drag affordance before anything was picked up, which
  // confused people.
  useEffect(() => {
    if (!reordering) return;
    const prev = document.body.style.cursor;
    document.body.style.cursor = "grabbing";
    return () => {
      document.body.style.cursor = prev;
    };
  }, [reordering]);

  // What the floating ghost carries.
  const draggedItem =
    dragSource?.kind === "item" ? (liveByKey.get(dragSource.key) ?? null) : null;
  const draggedFolder =
    dragSource?.kind === "folder"
      ? (renderNodes.find(
          (n): n is Extract<RenderNode, { type: "folder" }> =>
            n.type === "folder" && n.id === dragSource.id,
        ) ?? null)
      : null;

  // Folder rename dialog.
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const requestRename = useCallback(
    (id: string) => {
      const folder = layoutRef.current.find(
        (n): n is Extract<RailLayoutNode, { type: "folder" }> =>
          n.type === "folder" && n.id === id,
      );
      setRenameValue(folder?.name ?? "");
      setRenameId(id);
    },
    [],
  );
  const submitRename = useCallback(() => {
    if (renameId !== null) {
      persistLayout(renameFolder(layoutRef.current, renameId, renameValue.trim()));
    }
    setRenameId(null);
  }, [renameId, renameValue, persistLayout]);

  const renderItem = (item: RailItem, parentFolderId?: string) => {
    const common: RailDragProps = {
      draggable,
      dragging: dragSource?.kind === "item" && dragSource.key === item.key,
      reordering,
      highlight: dropPlan?.highlightAnchor === itemAnchor(item.key),
      dragParent: parentFolderId,
      onDragPointerDown: (e: PointerEvent) =>
        handleDragPointerDown({ kind: "item", key: item.key }, e),
      shouldSuppressClick,
    };
    if (item.kind === "server") {
      return (
        <ServerButton
          key={item.key}
          url={item.url}
          onNavigate={onNavigate}
          onSelect={onServerSelect}
          selected={onServerSelect ? selectedServer === item.url : undefined}
          inCall={!activeCall?.dmPeer && activeCall?.relayUrl === item.url}
          {...common}
        />
      );
    }
    if (item.kind === "concord1") {
      return (
        <ConcordButton
          key={item.key}
          communityId={item.communityId}
          name={item.name}
          onNavigate={onNavigate}
          {...common}
        />
      );
    }
    return (
      <Concord2Button
        key={item.key}
        communityId={item.communityId}
        name={item.name}
        onNavigate={onNavigate}
        {...common}
      />
    );
  };

  return (
    <nav
      ref={navRef}
      aria-label="Servers"
      // Suppress the browser's native HTML5 drag (images and <a>/NavLink are
      // draggable by default). Without this, a press-and-drag on a community
      // icon starts a native image/link drag that hijacks our custom
      // reorder gesture.
      onDragStart={(e) => e.preventDefault()}
      className={cn(
        // Chrome plane — deepest part of the recessed frame. The rail reaches
        // both screen edges on mobile, so it owns the top/bottom safe-area
        // insets (status bar above, gesture/nav bar below) on top of its base
        // padding. On desktop the env() insets are 0, so this is a no-op there.
        // Slimmer + tighter on the mobile drill-down (where it shares the width
        // with the channel/DM list) so it doesn't read as a squeezed desktop
        // rail; widens to the full desktop rail at the `sidebar:` breakpoint.
        "flex flex-col items-center gap-4 sidebar:gap-5 w-[60px] sidebar:w-[72px] shrink-0 overflow-y-auto bg-chrome-deep select-none",
        "pt-[calc(0.75rem+var(--safe-area-inset-top,env(safe-area-inset-top,0px)))]",
        // Match the ChannelSidebar account switcher, which sits inside pb-safe
        // AND adds an extra pb-2 (0.5rem) so it ends at the same line above the
        // safe-area inset. Fold that same 0.5rem into the rail's base padding so
        // the settings icon lines up with the switcher instead of sitting lower.
        "pb-[calc(var(--safe-area-pad-bottom,0.75rem)+0.5rem)] sidebar:pb-[calc(var(--safe-area-pad-bottom-tight,0.25rem)+0.5rem)]",
        // Lock scrolling while dragging so the rail doesn't fight the gesture.
        reordering && "overflow-hidden",
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
              {/* Active marker: the same neon blade the community buttons use
                  (see `inner`), so DMs/Mesh signal the active route identically.
                  Driven by aria-current=page rather than an isActive prop. */}
              <span
                className={cn(
                  "absolute -left-2 w-[3px] bg-primary transition-all",
                  "h-2 opacity-0 group-hover:opacity-60 group-hover:h-6",
                  "group-aria-[current=page]:h-12 group-aria-[current=page]:opacity-100",
                )}
              />
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
          <RailTooltipContent side="right" className="font-medium">
            Nearby mesh
          </RailTooltipContent>
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
              {/* Active marker: the same neon blade the community buttons use
                  (see `inner`), so DMs/Mesh signal the active route identically.
                  Driven by aria-current=page rather than an isActive prop. */}
              <span
                className={cn(
                  "absolute -left-2 w-[3px] bg-primary transition-all",
                  "h-2 opacity-0 group-hover:opacity-60 group-hover:h-6",
                  "group-aria-[current=page]:h-12 group-aria-[current=page]:opacity-100",
                )}
              />
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
          <RailTooltipContent side="right" className="font-medium">
            Direct messages
          </RailTooltipContent>
        </Tooltip>
      )}

      {/* One unified, user-arranged community list: NIP-29 servers and Concord
          (V1/V2) communities intermixed, with Discord-style folders. */}
      {renderNodes.map((node) =>
        node.type === "item" ? (
          renderItem(node.item)
        ) : (
          <RailFolder
            key={node.id}
            id={node.id}
            name={node.name}
            items={node.items}
            open={openFolders.has(node.id)}
            active={node.items.some(isItemActive)}
            onToggle={() => toggleFolder(node.id)}
            onRenameRequest={() => requestRename(node.id)}
            onDissolve={() => persistLayout(dissolveFolder(layoutRef.current, node.id))}
            draggable={draggable}
            dragging={dragSource?.kind === "folder" && dragSource.id === node.id}
            reordering={reordering}
            highlight={dropPlan?.highlightAnchor === folderAnchor(node.id)}
            onDragPointerDown={(e) => handleDragPointerDown({ kind: "folder", id: node.id }, e)}
            shouldSuppressClick={shouldSuppressClick}
          >
            {node.items.map((item) => renderItem(item, node.id))}
          </RailFolder>
        ),
      )}

      {/* Separates the community list from the add/settings actions below. */}
      {renderNodes.length > 0 && <div className="w-7 h-px bg-chrome-divider shrink-0" />}

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
        <RailTooltipContent side="right">Add a server or chat</RailTooltipContent>
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
        <RailTooltipContent side="right">Settings</RailTooltipContent>
      </Tooltip>

      <AddDialog open={addOpen} onOpenChange={setAddOpen} />

      {/* Folder rename dialog (from the folder context menu). */}
      <Dialog open={renameId !== null} onOpenChange={(open) => !open && setRenameId(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename folder</DialogTitle>
            <DialogDescription>Name this group of communities.</DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submitRename();
            }}
            className="space-y-4"
          >
            <Input
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              placeholder="Folder name"
              autoFocus
              maxLength={64}
            />
            <DialogFooter>
              <Button type="submit">Save</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Floating ghost that follows the pointer during a drag. */}
      {dragSource && dragPos && (draggedItem || draggedFolder) && (
        <DragGhost
          item={draggedItem ?? undefined}
          folderItems={draggedFolder?.items}
          x={dragPos.x}
          y={dragPos.y}
        />
      )}

      {/* While an entry is held, a full-viewport layer carries the grabbing
          cursor. This is what makes the cursor actually flip at pickup:
          Chromium does not re-evaluate a style-only cursor change while a
          mouse button is down and the pointer is stationary (so the body
          cursor set in the effect above is invisible until something else
          forces it) — but a NEW element appearing under the pointer forces
          the recompute. It also blocks hover states beneath the drag. It
          must NOT be pointer-events-none (hit-test-transparent elements
          don't contribute a cursor); the gesture's listeners live on window,
          so events bubbling through it are still seen. */}
      {reordering && (
        <div data-rail-drag-overlay className="fixed inset-0 z-[298] cursor-grabbing" aria-hidden />
      )}

      {/* Insertion indicator: where a gap drop would land. */}
      {reordering && dropPlan?.indicatorY !== undefined && navRectRef.current && (
        <div
          className="pointer-events-none fixed z-[299] h-0.5 rounded-full bg-primary shadow-[0_0_6px_hsl(var(--primary)/0.7)]"
          style={{
            left: navRectRef.current.left + 6,
            width: navRectRef.current.width - 12,
            top: dropPlan.indicatorY - 1,
          }}
        />
      )}
    </nav>
  );
}
