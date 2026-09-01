import { Bell, Bluetooth, CheckCheck, Compass, FolderOpen, Headphones, Lock, LogOut, MailPlus, MessageSquare, PanelLeftDashed, Plus, Settings, Trash2 } from "lucide-react";
import { nip19 } from "nostr-tools";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { NavLink, useLocation, useNavigate } from "react-router-dom";

import type React from "react";

import { AddDialog } from "@/components/dialogs/AddDialog";
import { DmAvatar } from "@/components/DmAvatar";
import { NoteToSelfAvatar, NOTE_TO_SELF_NAME } from "@/components/NoteToSelfAvatar";
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
import { MAX_RAIL_RECENT_DMS } from "@/contexts/AppContext";
import { useAppContext } from "@/hooks/useAppContext";
import { useAuthor } from "@/hooks/useAuthor";
import { useCall } from "@/hooks/useCall";
import { useCommunityManagement } from "@/concord/hooks/useCommunityActions";
import { useCommunity, useIsExcluded, useLiveCommunities } from "@/concord/hooks/useCommunityList";
import { useChannels, useControlFold } from "@/concord/hooks/useControlPlane";
import { useConcordMentions } from "@/concord/hooks/useConcordMentions";
import { useConcordUnread } from "@/concord/hooks/useConcordUnread";
import { useInviteInbox } from "@/concord/hooks/useDirectInvites";
import { useDecryptedImage } from "@/concord/hooks/useDecryptedImage";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useDmActivity, type DmActivityItem } from "@/hooks/useDmActivity";
import { useDmConversationName } from "@/hooks/useDmConversationName";
import { useDmPeerUnread, useHasUnreadDMs } from "@/hooks/useDirectMessages";
import { useMeshTransport } from "@/hooks/useMeshTransport";
import { useIsTouch } from "@/hooks/useIsMobile";
import { useMutes } from "@/hooks/useMutes";
import { useNotifLevels, communityScopeKey, dmScopeKey } from "@/hooks/useNotifLevels";
import { useRailDms } from "@/hooks/useRailDms";
import { NotifLevelMenu } from "@/components/NotifLevelMenu";
import { channelReadKey, useReadState } from "@/hooks/useReadState";
import { useRelayGroups } from "@/hooks/useRelayGroups";
import { useRelayInfo } from "@/hooks/useRelayInfo";
import { useRelayUnread } from "@/hooks/useRelayUnread";
import { useServerActions } from "@/hooks/useServerActions";
import { toast } from "@/hooks/useToast";
import { useUpdateUserGroupList } from "@/hooks/useUserGroupList";
import { useNip29Servers } from "@/hooks/useNip29Servers";
import { useDragPointerDown, usePressDrag } from "@/hooks/usePressDrag";
import { getAvatarShape } from "@/lib/avatarShape";
import { getDisplayName } from "@/lib/getDisplayName";
import { relayToRouteParam } from "@/lib/platform";
import { sanitizeImageSrc } from "@/lib/sanitizeUrl";
import {
  applyDrop,
  dissolveFolder,
  dmRailKey,
  flattenLayout,
  folderAnchor,
  itemAnchor,
  mergeLayout,
  normalizeLayout,
  planDrop,
  railDmPubkeys,
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
 * A single entry in the unified community rail. NIP-29 servers, both flavours
 * of Concord community and any DM the user put here live in one list; each
 * carries a stable `key` used for drag/reorder, folders, and the persisted
 * layout.
 */
type RailItem =
  | { kind: "server"; key: string; url: string }
  | { kind: "concord"; key: string; communityId: string; name: string }
  | { kind: "dm"; key: string; pubkey: string };

/** Stable rail key for a Concord community. */
const concordKey = (communityId: string) => `c2:${communityId}`;

/**
 * Route for a DM on the rail. The PEER's thread, not the DM list: on mobile
 * both are the same route in two states, so `/dm` would drop the user on the
 * conversation list they used this icon to skip.
 */
const dmRoute = (pubkey: string) => `/dm/${nip19.npubEncode(pubkey)}`;

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
  /**
   * Optimistic active highlight: this entry was just tapped and its navigation
   * is still rendering. Styled exactly like `isActive` so the destination
   * lights up on the tap frame, not when the (startTransition-wrapped) route
   * render finally commits.
   */
  pending?: boolean;
  /** Report a (non-suppressed) tap for the optimistic highlight above. */
  onPressed?: () => void;
}

/** data-* attributes identifying a draggable node for slot hit-testing. */
function dragAttrs(anchor: string, parent?: string): Record<string, string> {
  return { "data-rail-anchor": anchor, ...(parent ? { "data-rail-parent": parent } : {}) };
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
  // A relay's NIP-11 icon is whatever that relay says it is.
  const icon = sanitizeImageSrc(info?.icon);
  return (
    <span className="relative flex items-center justify-center overflow-hidden rounded-sm bg-secondary">
      {icon ? (
        <img src={icon} alt="" draggable={false} className="size-full object-cover" />
      ) : (
        <span className="text-[9px] font-semibold leading-none text-secondary-foreground">{initial}</span>
      )}
      <MiniUnreadDot mention={anyMention} unread={anyUnread} />
    </span>
  );
}

function Concord2MiniIcon({ communityId, name }: { communityId: string; name: string }) {
  const community = useCommunity(communityId);
  const { data: folded } = useControlFold(community, false);
  const iconUrl = useDecryptedImage(folded?.metadata?.icon);
  const displayName = folded?.metadata?.name || name;
  const initial = displayName.trim().charAt(0).toUpperCase() || "·";
  const channels = useChannels(community, false);
  const { byChannel } = useConcordUnread(community, channels);
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

function DmMiniIcon({ pubkey }: { pubkey: string }) {
  const { user } = useCurrentUser();
  const author = useAuthor(pubkey);
  const metadata = author.data?.metadata;
  const noteToSelf = pubkey === user?.pubkey;
  const name = noteToSelf ? NOTE_TO_SELF_NAME : getDisplayName(metadata, pubkey);
  const unread = useDmPeerUnread(pubkey);
  return (
    <span className="relative flex items-center justify-center">
      {noteToSelf ? (
        <NoteToSelfAvatar sizePx={16} className="size-full" />
      ) : (
        // The shared Avatar, so a profile's emoji shape masks the icon here
        // exactly as it does in the DM list (and round when it has none).
        <Avatar shape={getAvatarShape(metadata)} className="size-full">
          <AvatarImage src={metadata?.picture} alt="" draggable={false} />
          <AvatarFallback className="bg-primary/20 text-[9px] font-semibold leading-none text-primary">
            {name.trim().charAt(0).toUpperCase() || "?"}
          </AvatarFallback>
        </Avatar>
      )}
      {/* A DM has no channels to be mentioned in — the message IS the mention,
          so it lights the same dot any unread does. */}
      <MiniUnreadDot mention={false} unread={unread} />
    </span>
  );
}

function RailMiniIcon({ item }: { item: RailItem }) {
  if (item.kind === "server") return <ServerMiniIcon url={item.url} />;
  if (item.kind === "dm") return <DmMiniIcon pubkey={item.pubkey} />;
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
  const community = useCommunity(communityId);
  const channels = useChannels(community, false);
  const { byChannel } = useConcordUnread(community, channels);
  const { isConcordChannelMuted } = useMutes();
  const unread = Object.keys(byChannel).some(
    (id) => !isConcordChannelMuted("c2", communityId, id),
  );
  const mention = Object.values(byChannel).some((u) => u.mention);
  useEffect(() => onChange(unread, mention), [unread, mention, onChange]);
  return null;
}

function DmUnreadProbe({
  pubkey,
  onChange,
}: {
  pubkey: string;
  onChange: (unread: boolean, mention: boolean) => void;
}) {
  const unread = useDmPeerUnread(pubkey);
  useEffect(() => onChange(unread, false), [unread, onChange]);
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
  if (item.kind === "dm") return <DmUnreadProbe pubkey={item.pubkey} onChange={onChange} />;
  return <Concord2UnreadProbe communityId={item.communityId} onChange={onChange} />;
}

/** Feed the account-level bell from a server's already-shared unread query. */
function ServerMentionProbe({
  url,
  onChange,
}: {
  url: string;
  onChange: (key: string, mention: boolean) => void;
}) {
  const { user } = useCurrentUser();
  const { data: groups } = useRelayGroups(user ? url : undefined);
  const groupIds = useMemo(() => (groups ?? []).map((group) => group.id), [groups]);
  const { anyMention } = useRelayUnread(user ? url : undefined, groupIds);
  useEffect(() => onChange(url, anyMention), [url, anyMention, onChange]);
  useEffect(() => () => onChange(url, false), [url, onChange]);
  return null;
}

/** Feed the account-level bell from a Concord community's shared unread fold. */
function ConcordMentionProbe({
  communityId,
  onChange,
}: {
  communityId: string;
  onChange: (key: string, mention: boolean) => void;
}) {
  const community = useCommunity(communityId);
  const channels = useChannels(community, false);
  // The account center follows the community's dedicated Mentions read stamp,
  // not every channel's unread stamp. This is the same independence the
  // in-community Mentions pane already has: clearing the aggregate must clear
  // the Bell without pretending every mentioned channel was fully read.
  const { hasNew: mention } = useConcordMentions(community, channels);
  const key = concordKey(communityId);
  useEffect(() => onChange(key, mention), [key, mention, onChange]);
  useEffect(() => () => onChange(key, false), [key, onChange]);
  return null;
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

function Concord2DragGhost({ communityId, name }: { communityId: string; name: string }) {
  const community = useCommunity(communityId);
  const { data: folded } = useControlFold(community, false);
  const displayName = folded?.metadata?.name || name;
  const initials = displayName.trim().slice(0, 2).toUpperCase() || "··";
  const iconUrl = useDecryptedImage(folded?.metadata?.icon);
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

function DmDragGhost({ pubkey }: { pubkey: string }) {
  const { user } = useCurrentUser();
  const author = useAuthor(pubkey);
  const metadata = author.data?.metadata;
  const noteToSelf = pubkey === user?.pubkey;
  const name = noteToSelf ? NOTE_TO_SELF_NAME : getDisplayName(metadata, pubkey);
  return (
    <span className="block size-12 rotate-[-6deg] scale-110 [filter:drop-shadow(0_8px_16px_rgba(0,0,0,0.55))_drop-shadow(0_0_8px_hsl(var(--primary)/0.6))]">
      {noteToSelf ? (
        <NoteToSelfAvatar sizePx={48} className="size-12 ring-2 ring-primary" />
      ) : (
        <Avatar shape={getAvatarShape(metadata)} className="size-12 ring-2 ring-primary">
          <AvatarImage src={metadata?.picture} alt={name} />
          <AvatarFallback className="bg-primary/20 font-semibold text-primary">
            {name.trim().charAt(0).toUpperCase() || "?"}
          </AvatarFallback>
        </Avatar>
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
      ) : item?.kind === "dm" ? (
        <DmDragGhost pubkey={item.pubkey} />
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

const ServerButton = memo(function ServerButton({
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
  pending,
  onPressed,
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
  const { byGroup, anyUnread, anyMention } = useRelayUnread(user ? url : undefined, groupIds);
  const { markRead } = useReadState();
  const { communityLevel, setLevel: setNotifLevel } = useNotifLevels();
  const { isRemovable, removeServer } = useServerActions(url);
  const host = relayHost(url);
  const name = info?.name || host;
  const initial = name.trim().charAt(0).toUpperCase() || "?";
  const hasUnread = Object.keys(byGroup).length > 0;
  const markAllRead = useCallback(() => {
    for (const [groupId, unread] of Object.entries(byGroup)) {
      markRead(channelReadKey(url, groupId), unread.latest);
    }
  }, [byGroup, markRead, url]);

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
            // (saturate-50, not -75: 75 isn't on Tailwind's saturate scale.)
            "opacity-60 saturate-50 group-hover:opacity-100 group-hover:saturate-100",
            (isActive || highlight) && "opacity-100 saturate-100",
            isActive && "is-active",
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
                  onPressed?.();
                  onNavigate?.();
                }}
                // A STRING, not a function: this NavLink is cloned by the
                // wrapping ContextMenuTrigger/TooltipTrigger (Radix Slot), which
                // stringifies a function className into its source text — leaving
                // the anchor with no `group`/layout classes, so hover did nothing.
                // `isActive` still drives the icon via the render-prop children.
                className={cn(triggerClass, dragClass)}
                {...interactionProps}
              >
                {({ isActive }) => (
                  <DragSlot dragging={dragging}>{inner(isActive || Boolean(pending))}</DragSlot>
                )}
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
        <ContextMenuItem className="gap-2" disabled={!hasUnread} onSelect={markAllRead}>
          <CheckCheck className="size-4" />
          Mark as read
        </ContextMenuItem>
        <NotifLevelMenu
          label="Server notifications"
          level={communityLevel(url)}
          onChange={(lvl) => setNotifLevel(communityScopeKey(url), lvl)}
        />
        {isRemovable && (
          <ContextMenuItem
            className="gap-2 text-destructive focus:text-destructive"
            onSelect={removeServer}
          >
            <Trash2 className="size-4" />
            Remove server
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
});

/**
 * A rail button for an end-to-end-encrypted Concord community (CORD-02).
 * Visually distinguished from NIP-29 servers by the shield accent (different
 * trust model); navigates to `/c/…` and pulls its authoritative icon from the
 * folded Control Plane metadata.
 */
const Concord2Button = memo(function Concord2Button({
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
  pending,
  onPressed,
}: {
  communityId: string;
  name: string;
  onNavigate?: () => void;
} & RailDragProps) {
  const triggerRef = useRef<HTMLAnchorElement | null>(null);
  useDragPointerDown(triggerRef, draggable, onDragPointerDown);

  const community = useCommunity(communityId);
  // Rail buttons only need the icon/name, which the fold serves from its
  // persisted snapshot. Pass active=false so we DON'T fan out a control-plane
  // REQ per relay for every community on pageload — the community's page
  // (active=true) syncs it on navigation, sharing this query key.
  const { data: folded } = useControlFold(community, false);
  // Kicked/banned: the icon STAYS (only Leave/Dissolve remove it), but we mark
  // it so the user isn't left wondering why the room went read-only.
  const excluded = useIsExcluded(communityId);
  const displayName = folded?.metadata?.name || name;
  const initials = displayName.trim().slice(0, 2).toUpperCase() || "··";
  const iconUrl = useDecryptedImage(folded?.metadata?.icon);

  // Aggregate unread across the community's channels, computed purely from the
  // local rumor cache (no extra relay fan-out — active=false shares the fold
  // query key). Mirrors the NIP-29 rail badge. Muted channels (or a muted
  // community) don't light the unread dot; unread mentions still badge.
  const channels = useChannels(community, false);
  const { byChannel, markRead: markC2Read } = useConcordUnread(community, channels);
  const { isConcordChannelMuted } = useMutes();
  const { communityLevel, setLevel: setNotifLevel } = useNotifLevels();

  const anyUnread = Object.keys(byChannel).some(
    (id) => !isConcordChannelMuted("c2", communityId, id),
  );
  const anyMention = Object.values(byChannel).some((u) => u.mention);
  const hasUnread = Object.keys(byChannel).length > 0;
  const markAllRead = useCallback(() => {
    for (const [channelId, unread] of Object.entries(byChannel)) {
      markC2Read(channelId, unread.latest);
    }
  }, [byChannel, markC2Read]);

  // Leave from the rail's right-click menu (best-effort Guestbook leave, then
  // tombstone it locally), then go home.
  const navigate = useNavigate();
  const { leave } = useCommunityManagement(community);
  const handleLeave = async () => {
    try {
      await leave();
      navigate("/");
    } catch (e) {
      toast({
        title: "Couldn't leave",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    }
  };

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
            onPressed?.();
            onNavigate?.();
          }}
          className={cn(
            "group relative flex items-center justify-center shrink-0 touch-none",
            dragging && "cursor-grabbing",
            reordering && "touch-none",
          )}
          {...(draggable ? dragAttrs(itemAnchor(concordKey(communityId)), dragParent) : {})}
        >
          {({ isActive: routeActive }) => {
            const isActive = routeActive || Boolean(pending);
            return (
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
                      "bg-muted text-success opacity-60 saturate-50",
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
            );
          }}
        </NavLink>
          </ContextMenuTrigger>
        </TooltipTrigger>
        <RailTooltipContent side="right" className="font-medium">
          {displayName}
          {excluded ? <span className="ml-1 font-normal text-muted-foreground">· no access</span> : null}
        </RailTooltipContent>
      </Tooltip>
      <ContextMenuContent>
        <ContextMenuItem className="gap-2" disabled={!hasUnread} onSelect={markAllRead}>
          <CheckCheck className="size-4" />
          Mark as read
        </ContextMenuItem>
        <NotifLevelMenu
          label="Community notifications"
          level={communityLevel(concordKey(communityId))}
          onChange={(lvl) => setNotifLevel(concordKey(communityId), lvl)}
        />
        <ContextMenuItem
          className="gap-2 text-destructive focus:text-destructive"
          onSelect={handleLeave}
        >
          <LogOut className="size-4" />
          {excluded ? "Leave (no access)" : "Leave community"}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
});

/**
 * A rail button for a direct-message conversation the user pinned here from
 * the DM list. Round rather than the communities' cut-corner crest, because
 * it's a person; otherwise it is an ordinary rail item — it drags, folders and
 * reorders like the rest, and clicking it opens the THREAD (see `dmRoute`).
 */
const DmButton = memo(function DmButton({
  pubkey,
  unreadCount,
  onNavigate,
  inCall,
  draggable,
  dragging,
  reordering,
  highlight,
  dragParent,
  onDragPointerDown,
  shouldSuppressClick,
  pending,
  onPressed,
}: {
  pubkey: string;
  unreadCount?: number;
  onNavigate?: () => void;
  /** Whether the active voice call is this DM. */
  inCall?: boolean;
} & RailDragProps) {
  const triggerRef = useRef<HTMLAnchorElement | null>(null);
  useDragPointerDown(triggerRef, draggable, onDragPointerDown);

  const { user } = useCurrentUser();
  const author = useAuthor(pubkey);
  const metadata = author.data?.metadata;
  // The conversation with yourself is Note to Self, here as in the DM list:
  // the viewer's own face on the rail would read as a message from them.
  const noteToSelf = pubkey === user?.pubkey;
  const name = noteToSelf ? NOTE_TO_SELF_NAME : getDisplayName(metadata, pubkey);
  const unread = useDmPeerUnread(pubkey);
  const displayedUnreadCount = unreadCount ?? (unread ? 1 : 0);
  const { dmLevel, setLevel: setNotifLevel } = useNotifLevels();
  const { removeFromRail } = useRailDms();

  // Idle-dim + brighten-on-hover, matched to the community buttons so a person
  // and a community sit in one rail rather than two visual systems.
  const dimClass = (isActive: boolean) =>
    cn(
      "transition-all duration-150 opacity-60 saturate-50",
      "group-hover:opacity-100 group-hover:saturate-100",
      (isActive || highlight) && "opacity-100 saturate-100",
      isActive && "is-active",
    );

  return (
    <ContextMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <ContextMenuTrigger asChild>
            <NavLink
              ref={triggerRef}
              to={dmRoute(pubkey)}
              aria-label={name}
              onClick={(e) => {
                if (shouldSuppressClick?.()) {
                  e.preventDefault();
                  return;
                }
                onPressed?.();
                onNavigate?.();
              }}
              className={cn(
                "group relative flex items-center justify-center shrink-0 touch-none",
                dragging && "cursor-grabbing",
                reordering && "touch-none",
              )}
              {...(draggable ? dragAttrs(itemAnchor(dmRailKey(pubkey)), dragParent) : {})}
            >
              {({ isActive: routeActive }) => {
                const isActive = routeActive || Boolean(pending);
                return (
                <DragSlot dragging={dragging}>
                  <>
                    {/* The same neon blade every rail entry gets. */}
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
                      {noteToSelf ? (
                        <NoteToSelfAvatar sizePx={48} className={cn("size-12", dimClass(isActive))} />
                      ) : (
                        <Avatar
                          shape={getAvatarShape(metadata)}
                          className={cn("size-12", dimClass(isActive))}
                        >
                          <AvatarImage src={metadata?.picture} alt={name} />
                          <AvatarFallback className="bg-primary/20 font-semibold text-primary">
                            {name.trim().charAt(0).toUpperCase() || "?"}
                          </AvatarFallback>
                        </Avatar>
                      )}
                      {/* Voice indicator: a headphones badge when this DM's call is live. */}
                      {inCall && (
                        <span className="absolute -bottom-1 -right-1 z-10 flex size-4 items-center justify-center rounded-full bg-success text-success-foreground ring-2 ring-background">
                          <Headphones className="size-2.5" />
                        </span>
                      )}
                      {/* Unread count (hidden while active — you're reading it). */}
                      {!isActive && displayedUnreadCount > 0 ? (
                        <span
                          className="absolute -top-1 -right-1 z-10 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold leading-none text-primary-foreground ring-2 ring-background"
                          aria-label={`${displayedUnreadCount} unread ${displayedUnreadCount === 1 ? "message" : "messages"}`}
                        >
                          {displayedUnreadCount > 99 ? "99+" : displayedUnreadCount}
                        </span>
                      ) : null}
                    </span>
                  </>
                </DragSlot>
                );
              }}
            </NavLink>
          </ContextMenuTrigger>
        </TooltipTrigger>
        <RailTooltipContent side="right" className="font-medium">
          {name}
        </RailTooltipContent>
      </Tooltip>
      <ContextMenuContent>
        <NotifLevelMenu
          label="Message notifications"
          level={dmLevel(pubkey)}
          onChange={(lvl) => setNotifLevel(dmScopeKey(pubkey), lvl)}
        />
        {/* Takes the icon off the rail and nothing else: the conversation, its
            history and its place in the DM list are untouched. */}
        <ContextMenuItem className="gap-2" onSelect={() => removeFromRail(pubkey)}>
          <PanelLeftDashed className="size-4" />
          Remove from rail
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
});

/**
 * One automatic recent-conversation avatar. Unlike a pinned DM it is not part
 * of `railLayout` and cannot be dragged: recency owns this three-item strip,
 * while manual pins keep their existing arranged/foldered behavior below it.
 */
const RecentDmButton = memo(function RecentDmButton({
  item,
  onNavigate,
  inCall,
  pending,
  onPressed,
}: {
  item: DmActivityItem;
  onNavigate?: () => void;
  inCall?: boolean;
  pending?: boolean;
  onPressed?: () => void;
}) {
  const { user } = useCurrentUser();
  const { name } = useDmConversationName(item.peers, user?.pubkey);
  const { dmLevel, setLevel: setNotifLevel } = useNotifLevels();

  return (
    <ContextMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <ContextMenuTrigger asChild>
            <NavLink
              to={item.route}
              data-recent-dm={item.key}
              aria-label={name}
              onClick={() => {
                onPressed?.();
                onNavigate?.();
              }}
              className="group relative flex items-center justify-center shrink-0"
            >
              {({ isActive: routeActive }) => {
                const isActive = routeActive || Boolean(pending);
                return (
                  <>
                    <span
                      className={cn(
                        "absolute -left-2 w-[3px] bg-primary transition-all",
                        isActive
                          ? "h-12 opacity-100"
                          : "h-2 opacity-0 group-hover:h-6 group-hover:opacity-60",
                      )}
                    />
                    <span className={cn(
                      "relative block size-12 transition-all duration-150",
                      isActive && "[filter:drop-shadow(0_0_3px_hsl(var(--primary)/0.6))]",
                    )}>
                      <DmAvatar
                        peers={item.peers}
                        selfPubkey={user?.pubkey}
                        sizePx={48}
                        className={cn(
                          "size-12 transition-all duration-150 opacity-60 saturate-50",
                          "group-hover:opacity-100 group-hover:saturate-100",
                          isActive && "opacity-100 saturate-100 is-active",
                        )}
                      />
                      {inCall && (
                        <span className="absolute -bottom-1 -right-1 z-10 flex size-4 items-center justify-center rounded-full bg-success text-success-foreground ring-2 ring-background">
                          <Headphones className="size-2.5" />
                        </span>
                      )}
                      {!isActive && item.unreadCount > 0 && (
                        <span
                          className="absolute -top-1 -right-1 z-10 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold leading-none text-primary-foreground ring-2 ring-background"
                          aria-label={`${item.unreadCount} unread ${item.unreadCount === 1 ? "message" : "messages"}`}
                        >
                          {item.unreadCount > 99 ? "99+" : item.unreadCount}
                        </span>
                      )}
                    </span>
                  </>
                );
              }}
            </NavLink>
          </ContextMenuTrigger>
        </TooltipTrigger>
        <RailTooltipContent side="right" className="font-medium">{name}</RailTooltipContent>
      </Tooltip>
      <ContextMenuContent>
        <NotifLevelMenu
          label="Message notifications"
          level={dmLevel(item.key)}
          onChange={(level) => setNotifLevel(dmScopeKey(item.key), level)}
        />
      </ContextMenuContent>
    </ContextMenu>
  );
});

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
                        "opacity-70 saturate-50 group-hover:opacity-100 group-hover:saturate-100",
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
 * communities in one user-arranged list with Discord-style folders —
 * plus DMs, add-community and settings actions.
 *
 * Drag interactions (Discord semantics):
 * - Mouse: press and move a few pixels to pick an entry up immediately.
 * - Touch: press and hold (~300ms), then drag (a short tap navigates).
 * - Drop in a gap to reorder; drop onto another community to create a folder;
 *   drop onto a folder to move it inside; drag out of a folder to remove it.
 *   Folders holding a single item dissolve automatically.
 */
/**
 * The side-by-side (desktop) layout — where the rail is a PERSISTENT left
 * column owned by {@link MainLayout} — versus the touch drill-down (<900px on a
 * touch device) where each page owns the rail inside its `SwipeReveal` underlay.
 * Mirrors `SwipeReveal`'s `swipeEnabled = isTouch && narrow`; this is its
 * negation, so the two agree on which layout is live at every width.
 */
function useSideBySideLayout(): boolean {
  const isTouch = useIsTouch();
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(max-width: 899px)").matches,
  );
  useEffect(() => {
    const mql = window.matchMedia("(max-width: 899px)");
    const onChange = () => setNarrow(mql.matches);
    mql.addEventListener("change", onChange);
    setNarrow(mql.matches);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return !(isTouch && narrow);
}

// ─── Persistent drill-down rail ──────────────────────────────────────────
//
// On the touch drill-down every page shows the rail inside its SwipeReveal
// underlay, so switching sections (DMs ↔ a community) used to unmount and
// rebuild the entire rail — its per-item hook fan-out AND the very button the
// user had just tapped — as part of the route transition. That rebuild is a
// large slice of the main-thread work that made the first tap after a section
// switch feel dead. The fix mirrors what `variant="shell"` did for desktop,
// except the rail's DOM has to LIVE inside each page's underlay (the chat
// pane slides over it and the parallax translates it), so a shell sibling
// won't do. Instead the drill-down rail is rendered ONCE — by MainLayout's
// shell ServerRail, through a portal into this detached container — and each
// page's plain `<ServerRail />` renders a slot that ADOPTS the container's
// DOM node on mount. Moving a DOM node between slots is cheap and invisible
// to React: the component tree, its hooks and their subscriptions survive
// every section switch.
let railPortalNode: HTMLDivElement | null = null;
function getRailPortalNode(): HTMLDivElement {
  if (!railPortalNode) {
    railPortalNode = document.createElement("div");
    // Both this container and the slot are `display: contents`, so the rail's
    // root element participates in the underlay's flex row exactly as if the
    // page had rendered it inline.
    railPortalNode.style.display = "contents";
  }
  return railPortalNode;
}

function RailSlot() {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const slot = ref.current;
    if (!slot) return;
    const node = getRailPortalNode();
    // appendChild MOVES the node if something still holds it; in the normal
    // route-switch commit the outgoing slot's cleanup has already run, so this
    // is an append of a detached node before paint — no railless frame.
    slot.appendChild(node);
    return () => {
      if (node.parentNode === slot) slot.removeChild(node);
    };
  }, []);
  return <div style={{ display: "contents" }} ref={ref} />;
}

export interface ServerRailProps {
  onNavigate?: () => void;
  /** When set, tapping a server fires this instead of navigating (drawer mode). */
  onServerSelect?: (url: string) => void;
  /** The currently-selected server in drawer mode. */
  selectedServer?: string;
  className?: string;
  /**
   * `shell` = the single persistent rail MainLayout owns: rendered in place on
   * the desktop side-by-side layout, and portaled into the shared drill-down
   * container (see `getRailPortalNode`) on touch. `page` (default) = what a
   * page renders inside its mobile drill-down underlay — a SLOT that adopts
   * the persistent rail's DOM (or nothing on desktop). Either way the rail
   * component itself survives navigation, so its whole per-item hook fan-out
   * isn't rebuilt on every switch and the tap target the user is clicking
   * stays mounted.
   */
  variant?: "shell" | "page";
}

export function ServerRail({ variant = "page", ...props }: ServerRailProps) {
  const sideBySide = useSideBySideLayout();
  const { user } = useCurrentUser();
  if (variant === "shell") {
    // Drill-down: host the ONE persistent rail; page slots adopt its DOM.
    // No `user` gate here — the drill-down rail belongs to pages that manage
    // their own logged-out state (it always rendered for them), and with no
    // slot mounted (e.g. a page that renders none) the container simply stays
    // detached.
    if (!sideBySide) return createPortal(<ServerRailInner {...props} />, getRailPortalNode());
    // The persistent shell rail is part of the logged-in app frame; a logged-out
    // visitor on one of the public in-shell pages (/discover, /invite/…) has no
    // communities and must not see the rail's +/Discover/Settings chrome.
    if (!user) return null;
    return <ServerRailInner {...props} />;
  }
  // page variant lives only in the drill-down.
  if (sideBySide) return null;
  // A page that customizes its rail (MeshPage's onNavigate, drawer mode) keeps
  // a private instance; the plain `<ServerRail />` everywhere else shares the
  // persistent one through a slot.
  if (props.onNavigate || props.onServerSelect) return <ServerRailInner {...props} />;
  return <RailSlot />;
}

function ServerRailInner({
  onNavigate,
  onServerSelect,
  selectedServer,
  className,
}: ServerRailProps) {
  const { config, updateConfig } = useAppContext();
  const navigate = useNavigate();
  const location = useLocation();
  const { activeCall } = useCall();
  const { user } = useCurrentUser();
  const { mesh } = useMeshTransport();
  const hasUnreadDMs = useHasUnreadDMs();
  const { items: dmActivity } = useDmActivity();
  // Received Concord invites (CORD-05 §6). The rail entry appears only while
  // some are pending — there's no history to browse once they're all
  // accepted/declined — and badges the count not yet seen in the inbox.
  const { items: inviteItems, unreadCount: inviteUnread } = useInviteInbox();
  const { mutateAsync: updateList } = useUpdateUserGroupList();
  const concord = useLiveCommunities();
  const [addOpen, setAddOpen] = useState(false);

  // Optimistic "this is where we're going" highlight. React Router v7 wraps
  // every navigation in startTransition, so on a slow section switch the
  // tapped entry wouldn't light until the whole destination page had rendered
  // — reading as a dead tap. Set synchronously on click (a high-priority
  // update that paints on the tap frame), cleared when the location actually
  // changes; the timeout covers a tap whose navigation never moves the
  // location (re-tapping the active entry).
  const [pendingNav, setPendingNav] = useState<string | null>(null);
  useEffect(() => {
    setPendingNav(null);
  }, [location]);
  useEffect(() => {
    if (pendingNav === null) return;
    const timer = window.setTimeout(() => setPendingNav(null), 3000);
    return () => window.clearTimeout(timer);
  }, [pendingNav]);
  // Cached per key so the memoized buttons keep their bailout (same reason as
  // dragPointerDownFor below).
  const pressedByKey = useRef(new Map<string, () => void>());
  const onPressedFor = (key: string) => {
    let fn = pressedByKey.current.get(key);
    if (!fn) {
      fn = () => setPendingNav(key);
      pressedByKey.current.set(key, fn);
    }
    return fn;
  };

  // The NIP-29 half of the rail: the servers in the user's kind 10009 list, so
  // the rail shows only servers the user actually added or joined.
  // Order/grouping is applied by the layout below.
  const servers = useNip29Servers();

  // The Notification Center is intentionally narrower than generic channel
  // unread: it collects mentions and invites. DMs have their own button and
  // transient unread queue below. These invisible probes reuse the same unread
  // queries every visible rail button already shares, then roll only the
  // mention bit into the account-level bell.
  const [mentionBySpace, setMentionBySpace] = useState<Record<string, boolean>>({});
  const reportMention = useCallback((key: string, mention: boolean) => {
    setMentionBySpace((current) => {
      if (current[key] === mention) return current;
      return { ...current, [key]: mention };
    });
  }, []);
  const hasUnreadNotifications =
    inviteUnread > 0 || Object.values(mentionBySpace).some(Boolean);

  // DMs the user put on the rail. Unlike every other kind these have no source
  // list to be live against — the arrangement IS the record — so they're read
  // back out of it, which also means they can never be "not live yet" and get
  // skipped at render the way a still-loading community can.
  const railDms = useMemo(
    () => railDmPubkeys(config.railLayout),
    [config.railLayout],
  );
  const dmActivityByKey = useMemo(
    () => new Map(dmActivity.map((item) => [item.key, item])),
    [dmActivity],
  );
  const recentDms = useMemo(() => {
    // The whole-DM opt-out removes the strip along with everything else: the
    // account is no longer listening for DMs, so a "recent unread" strip would
    // be stale by construction.
    if (config.dmsDisabled || !config.showRecentRailDms) return [];
    const manuallyArranged = new Set(railDms);
    return dmActivity
      .filter((item) => item.unreadCount > 0 && !manuallyArranged.has(item.key))
      .slice(0, MAX_RAIL_RECENT_DMS);
  }, [dmActivity, railDms, config.showRecentRailDms, config.dmsDisabled]);

  // Every live rail item (NIP-29 servers, Concord communities and pinned
  // DMs) in discovery order. The persisted layout arranges these into the
  // visible ordered list + folders.
  const items = useMemo<RailItem[]>(() => {
    const base: RailItem[] = [];
    base.push(...servers.map((url) => ({ kind: "server" as const, key: url, url })));
    if (user) {
      // With DMs off the account isn't listening for them, so even manually
      // pinned DM rail items drop — the master opt-out hides the whole surface.
      if (!config.dmsDisabled) {
        base.push(
          ...railDms.map((pubkey) => ({ kind: "dm" as const, key: dmRailKey(pubkey), pubkey })),
        );
      }
      for (const entry of concord) {
        base.push({
          kind: "concord",
          key: concordKey(entry.community_id),
          communityId: entry.community_id,
          name: entry.current.name,
        });
      }
    }
    return base;
  }, [servers, concord, railDms, user, config.dmsDisabled]);

  const liveByKey = useMemo(() => new Map(items.map((it) => [it.key, it])), [items]);

  // The working layout: the synced `railLayout` with newly-discovered items
  // appended. Keys the layout knows but that aren't live yet (still loading /
  // since removed) are KEPT in the data — they're only skipped at render — so
  // an early drag can't wipe another device's folders.
  const layout = useMemo(
    () => mergeLayout(config.railLayout, items.map((it) => it.key)),
    [config.railLayout, items],
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
          : item.kind === "dm"
            ? dmRoute(item.pubkey)
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
      updateConfig((current) => ({ ...current, railLayout: normalized }));

      // Also sync the relative order of user-added relays to the kind 10009
      // list (the cross-device source of truth for the added-server set).
      // Only relay URLs qualify — every other kind's key would arrive there as
      // a relay the user never added.
      const addedOrder = keys.filter(
        (k) => !k.startsWith("c2:") && !k.startsWith("dm:"),
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
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  const [dropPlan, setDropPlan] = useState<RailDropPlan | null>(null);
  const navRef = useRef<HTMLElement | null>(null);
  // Frozen slot geometry + rail frame, captured once at pickup from clean DOM.
  const slotsRef = useRef<RailSlot[]>([]);
  const navRectRef = useRef<{ left: number; width: number } | null>(null);
  const dropPlanRef = useRef<RailDropPlan | null>(null);

  const aim = useCallback((source: RailDragSource, x: number, y: number) => {
    const plan = planDrop(y, slotsRef.current, source);
    dropPlanRef.current = plan;
    setDragPos({ x, y });
    setDropPlan(plan);
  }, []);

  const railDrag = usePressDrag<RailDragSource>({
    containerRef: navRef,
    onPickup: (source, x, y) => {
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
      aim(source, x, y);
    },
    onAim: aim,
    onDrop: (source) => {
      const plan = dropPlanRef.current;
      dropPlanRef.current = null;
      setDragPos(null);
      setDropPlan(null);
      if (plan) persistLayout(applyDrop(layoutRef.current, source, plan.target));
    },
    onAbort: () => {
      dropPlanRef.current = null;
      setDragPos(null);
      setDropPlan(null);
    },
  });

  const { dragging: reordering, shouldSuppressClick } = railDrag;
  const dragSource = railDrag.source;
  const handleDragPointerDown = railDrag.begin;
  const draggable = items.length > 1;

  // Whether there's list content scrolled off below the current view. The
  // Settings footer's top divider only earns its keep as the seam over hidden
  // content — with a short list, or once scrolled to the bottom, it's just a
  // line under nothing. Measured, not guessed: item count, folder open/close
  // and rail/viewport height move the overflow threshold (watched via the nav's
  // own height and each child's, incl. folder expansion), and scrolling moves
  // the seam (watched via the scroll event).
  const [contentBelow, setContentBelow] = useState(false);
  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const measure = () =>
      setContentBelow(nav.scrollHeight - nav.scrollTop - nav.clientHeight > 1);
    measure();
    nav.addEventListener("scroll", measure, { passive: true });
    if (typeof ResizeObserver === "undefined") return () => nav.removeEventListener("scroll", measure);
    const ro = new ResizeObserver(measure);
    ro.observe(nav);
    for (const child of Array.from(nav.children)) ro.observe(child);
    return () => {
      nav.removeEventListener("scroll", measure);
      ro.disconnect();
    };
  }, [renderNodes, user, mesh.available, inviteItems.length, recentDms.length]);

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

  // Cached per item key: `begin` is render-stable and useDragPointerDown reads
  // through a ref, so the only effect a fresh closure per render would have is
  // to defeat the memoized rail buttons.
  const dragDownByKey = useRef(new Map<string, (e: PointerEvent) => void>());
  const dragPointerDownFor = (key: string) => {
    let fn = dragDownByKey.current.get(key);
    if (!fn) {
      fn = (e: PointerEvent) => handleDragPointerDown({ kind: "item", key })(e);
      dragDownByKey.current.set(key, fn);
    }
    return fn;
  };

  const renderItem = (item: RailItem, parentFolderId?: string) => {
    const common: RailDragProps = {
      draggable,
      dragging: dragSource?.kind === "item" && dragSource.key === item.key,
      reordering,
      highlight: dropPlan?.highlightAnchor === itemAnchor(item.key),
      dragParent: parentFolderId,
      onDragPointerDown: dragPointerDownFor(item.key),
      shouldSuppressClick,
      pending: pendingNav === item.key,
      onPressed: onPressedFor(item.key),
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
    if (item.kind === "dm") {
      return (
        <DmButton
          key={item.key}
          pubkey={item.pubkey}
          unreadCount={dmActivityByKey.get(item.pubkey)?.unreadCount}
          onNavigate={onNavigate}
          inCall={activeCall?.dmPeer === item.pubkey}
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
    <div
      className={cn(
        // Chrome plane — deepest part of the recessed frame. Owns the rail's
        // width and background. A flex column so the community list can scroll
        // on its own while the Settings footer below stays pinned and reachable
        // no matter how many communities push the list into overflow. The rail
        // reaches both screen edges on mobile: the scroll region takes the top
        // safe-area inset (status bar) and the footer takes the bottom inset.
        // Slimmer + tighter on the mobile drill-down (where it shares the width
        // with the channel/DM list) so it doesn't read as a squeezed desktop
        // rail; widens to the full desktop rail at the `sidebar:` breakpoint.
        "flex flex-col items-center w-[60px] sidebar:w-[72px] shrink-0 overflow-hidden bg-chrome-deep select-none",
        className,
      )}
    >
      <nav
        ref={railDrag.attachContainer}
        aria-label="Servers"
        // Suppress the browser's native HTML5 drag (images and <a>/NavLink are
        // draggable by default). Without this, a press-and-drag on a community
        // icon starts a native image/link drag that hijacks our custom
        // reorder gesture.
        onDragStart={(e) => e.preventDefault()}
        className={cn(
          // The scroll region: fills the space above the pinned footer and
          // scrolls internally. `min-h-0` lets it shrink below its content so
          // the flex parent can actually clip + scroll it. `overflow-x-clip`
          // is required: bare `overflow-y-auto` makes the browser compute
          // overflow-x to `auto` too, which — once a vertical scrollbar eats
          // into the narrow rail — produces an unwanted horizontal scrollbar.
          // Hide the scrollbar entirely (Discord-style icon rail): it still
          // scrolls by wheel/touch/drag. Touch/native already hide it globally
          // (see index.css); these cover desktop web.
          "flex flex-col items-center gap-4 sidebar:gap-5 w-full flex-1 min-h-0",
          "overflow-y-auto overflow-x-clip [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
          "pt-[calc(0.75rem+var(--safe-area-inset-top,env(safe-area-inset-top,0px)))]",
          "pb-2",
          // Lock scrolling while dragging so the rail doesn't fight the gesture.
          reordering && "overflow-hidden",
        )}
      >
        {user && servers.map((url) => (
          <ServerMentionProbe key={`mention:${url}`} url={url} onChange={reportMention} />
        ))}
        {user && concord.map((entry) => (
          <ConcordMentionProbe
            key={`mention:c2:${entry.community_id}`}
            communityId={entry.community_id}
            onChange={reportMention}
          />
        ))}

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
                onClick={() => {
                  onPressedFor("nav:mesh")();
                  onNavigate?.();
                }}
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
                    pendingNav === "nav:mesh" && "h-12 opacity-100",
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
                      pendingNav === "nav:mesh" && "opacity-100 saturate-100",
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

        {/* Account-level Notification Center: mentions across both community
            transports and pending Concord invites. DMs stay in their own rail
            queue immediately below. */}
        {user && (
          <Tooltip>
            <TooltipTrigger asChild>
              <NavLink
                to="/notifications"
                aria-label="Notifications"
                onClick={() => {
                  onPressedFor("nav:notifications")();
                  onNavigate?.();
                }}
                className="group relative flex items-center justify-center shrink-0"
              >
                <span
                  className={cn(
                    "absolute -left-2 w-[3px] bg-primary transition-all",
                    "h-2 opacity-0 group-hover:h-6 group-hover:opacity-60",
                    "group-aria-[current=page]:h-12 group-aria-[current=page]:opacity-100",
                    pendingNav === "nav:notifications" && "h-12 opacity-100",
                  )}
                />
                <span className={cn(
                  "relative block size-12 transition-all duration-150",
                  "group-aria-[current=page]:[filter:drop-shadow(0_0_3px_hsl(var(--primary)/0.6))]",
                )}>
                  <span className={cn(
                    "flex size-12 items-center justify-center clip-corner-lg bg-muted text-primary opacity-50 saturate-50 transition-all duration-150",
                    "group-hover:opacity-100 group-hover:saturate-100",
                    "group-aria-[current=page]:opacity-100 group-aria-[current=page]:saturate-100",
                    pendingNav === "nav:notifications" && "opacity-100 saturate-100",
                  )}>
                    <Bell className="size-5" />
                  </span>
                  {hasUnreadNotifications && (
                    <span
                      className="absolute -top-0.5 -right-0.5 z-10 size-3 rounded-full bg-primary ring-2 ring-background group-aria-[current=page]:hidden"
                      aria-label="Unread notifications"
                    />
                  )}
                </span>
              </NavLink>
            </TooltipTrigger>
            <RailTooltipContent side="right" className="font-medium">
              Notifications
            </RailTooltipContent>
          </Tooltip>
        )}

        {/* Direct messages — account-level, above the servers (Discord-style).
            Only shown when signed in (DMs require an account); hidden entirely
            when the account has opted out of DMs (config.dmsDisabled). */}
        {user && !config.dmsDisabled && (
          <Tooltip>
            <TooltipTrigger asChild>
              <NavLink
                to="/dm"
                aria-label="Direct messages"
                onClick={() => {
                  onPressedFor("nav:dm")();
                  onNavigate?.();
                }}
                className="group relative flex items-center justify-center shrink-0"
              >
                {/* Active marker: the same neon blade the community buttons use
                    (see `inner`), so DMs/Mesh signal the active route identically.
                    Driven by aria-current=page rather than an isActive prop; the
                    `pendingNav` classes are the optimistic tap highlight. */}
                <span
                  className={cn(
                    "absolute -left-2 w-[3px] bg-primary transition-all",
                    "h-2 opacity-0 group-hover:opacity-60 group-hover:h-6",
                    "group-aria-[current=page]:h-12 group-aria-[current=page]:opacity-100",
                    pendingNav === "nav:dm" && "h-12 opacity-100",
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
                      pendingNav === "nav:dm" && "opacity-100 saturate-100",
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

        {/* Received encrypted-community invites (CORD-05 §6). Shown only while
            some are pending; badges the count not yet seen in the inbox. */}
        {user && inviteItems.length > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <NavLink
                to="/invites"
                aria-label="Invites"
                onClick={() => {
                  onPressedFor("nav:invites")();
                  onNavigate?.();
                }}
                className="group relative flex items-center justify-center shrink-0"
              >
                <span
                  className={cn(
                    "absolute -left-2 w-[3px] bg-primary transition-all",
                    "h-2 opacity-0 group-hover:opacity-60 group-hover:h-6",
                    "group-aria-[current=page]:h-12 group-aria-[current=page]:opacity-100",
                    pendingNav === "nav:invites" && "h-12 opacity-100",
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
                      "bg-muted text-success opacity-60 saturate-50",
                      "group-hover:opacity-100 group-hover:saturate-100",
                      "group-aria-[current=page]:opacity-100 group-aria-[current=page]:saturate-100",
                      pendingNav === "nav:invites" && "opacity-100 saturate-100",
                    )}
                  >
                    <MailPlus className="size-5" />
                  </span>
                  {/* Unread invite count (hidden on the active invites view). */}
                  {inviteUnread > 0 && (
                    <span
                      className="absolute -top-1 -right-1 z-10 flex min-w-4 h-4 px-1 items-center justify-center rounded-full bg-primary text-primary-foreground text-[10px] font-bold leading-none ring-2 ring-background group-aria-[current=page]:hidden"
                      aria-label={`${inviteUnread} new invite${inviteUnread === 1 ? "" : "s"}`}
                    >
                      {inviteUnread}
                    </span>
                  )}
                </span>
              </NavLink>
            </TooltipTrigger>
            <RailTooltipContent side="right" className="font-medium">
              Invites
            </RailTooltipContent>
          </Tooltip>
        )}

        {/* Newest unread conversations, automatic and recency-ordered, capped
            at MAX_RAIL_RECENT_DMS and gated by the showRecentRailDms setting.
            Reading one advances its shared read stamp and removes it from this
            transient strip. Manually arranged 1:1 pins remain only at their
            saved rail/folder position below, where they carry the same count. */}
        {user && recentDms.map((item) => (
          <RecentDmButton
            key={`recent:${item.key}`}
            item={item}
            onNavigate={onNavigate}
            inCall={activeCall?.dmPeer === item.key}
            pending={pendingNav === `recent:${item.key}`}
            onPressed={onPressedFor(`recent:${item.key}`)}
          />
        ))}

        {/* Account activity above; arranged communities and manual pins below. */}
        {user && renderNodes.length > 0 && (
          <div
            className="h-px w-7 shrink-0 bg-chrome-divider"
            data-rail-account-separator
            aria-hidden
          />
        )}

        {/* One unified, user-arranged community list: NIP-29 servers and Concord
            communities intermixed, with Discord-style folders. */}
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
              onDragPointerDown={(e) => handleDragPointerDown({ kind: "folder", id: node.id })(e)}
              shouldSuppressClick={shouldSuppressClick}
            >
              {node.items.map((item) => renderItem(item, node.id))}
            </RailFolder>
          ),
        )}

        {/* Separates the community list from the add action below. */}
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

        {/* Discover — browse/search public communities, emoji packs and themes.
            Public (no account needed), so it sits outside the `user &&` gate. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <NavLink
              to="/discover"
              aria-label="Discover"
              onClick={() => {
                onPressedFor("nav:discover")();
                onNavigate?.();
              }}
              className="group relative flex items-center justify-center shrink-0"
            >
              <span
                className={cn(
                  "absolute -left-2 w-[3px] bg-primary transition-all",
                  "h-2 opacity-0 group-hover:opacity-60 group-hover:h-6",
                  "group-aria-[current=page]:h-12 group-aria-[current=page]:opacity-100",
                  pendingNav === "nav:discover" && "h-12 opacity-100",
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
                    pendingNav === "nav:discover" && "opacity-100 saturate-100",
                  )}
                >
                  <Compass className="size-5" />
                </span>
              </span>
            </NavLink>
          </TooltipTrigger>
          <RailTooltipContent side="right" className="font-medium">
            Discover
          </RailTooltipContent>
        </Tooltip>
      </nav>

      {/* Pinned footer: Settings stays visible regardless of how many
          communities push the list into overflow — it lives outside the scroll
          region above. The bottom safe-area padding lives here (not the scroll
          region) so the icon lines up with the ChannelSidebar account switcher,
          which sits inside pb-safe plus an extra 0.5rem. */}
      <div
        className={cn(
          "flex flex-col items-center shrink-0 w-full pt-3 sidebar:pt-4",
          contentBelow && "border-t border-chrome-divider",
          "pb-[calc(var(--safe-area-pad-bottom,0.75rem)+0.5rem)] sidebar:pb-[calc(var(--safe-area-pad-bottom-tight,0.25rem)+0.5rem)]",
        )}
      >
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
      </div>

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
    </div>
  );
}
