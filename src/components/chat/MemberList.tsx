import { AtSign, Ban, Bot, Copy, Crown, Flag, IdCard, MessageSquareText, MoreVertical, Music, Search, Shield, ShieldOff, Smile, UserCheck, UserCog, UserMinus, UserPlus, UserX, X } from "lucide-react";

import { memo, useMemo, useRef, useState } from "react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { BotPill } from "@/components/BotPill";
import { DeferredRow } from "@/components/DeferredRow";
import { ProfilePreviewCard } from "@/components/chat/ProfilePreviewCard";
import { ReportDialog } from "@/components/ReportDialog";
import { StatusDialog } from "@/components/dialogs/StatusDialog";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmojifiedText } from "@/components/chat/CustomEmoji";
import { RolePickerItems, type RolePickerOption } from "@/components/chat/RolePickerItems";
import { DisplayName } from "@/components/DisplayName";
import { Input } from "@/components/ui/input";
import { useAuthor } from "@/hooks/useAuthor";
import { useChatScope } from "@/hooks/useChatScope";
import { useMutedPubkeys, useMuteToggle } from "@/hooks/useMuteList";
import { useMemberSearch } from "@/hooks/useMemberSearch";
import { useScopedIdentity } from "@/hooks/useScopedDisplayName";
import { isStatusExpired, useUserStatus } from "@/hooks/useUserStatus";
import { requestMention } from "@/hooks/useMentionBus";
import { toast } from "@/hooks/useToast";
import { getAvatarShape } from "@/lib/avatarShape";
import { reportDestination } from "@/lib/report";
import { tryNpubEncode } from "@/lib/safeNip19";
import { cn } from "@/lib/utils";
import { writeClipboardText } from "@/lib/clipboard";

import type { Nip29Admin } from "@/lib/nip29";
import type { ComponentType, ReactNode } from "react";

const ROLE_OWNER = "owner";
const ROLE_ADMIN = "admin";
const ROLE_MODERATOR = "moderator";
/** Buzz roles carried on the 39002 members event. */
const ROLE_BOT = "bot";
const ROLE_GUEST = "guest";

/** Menu primitives shared by the ⋮ dropdown and right-click menu (compatible Radix props). */
interface MenuParts {
  Item: ComponentType<{ className?: string; onSelect?: (e: Event) => void; children?: ReactNode }>;
  Separator: ComponentType<{ className?: string }>;
  Label: ComponentType<{ className?: string; children?: ReactNode }>;
  Sub: ComponentType<{ children?: ReactNode }>;
  SubTrigger: ComponentType<{ className?: string; children?: ReactNode }>;
  SubContent: ComponentType<{ className?: string; children?: ReactNode }>;
  CheckboxItem: ComponentType<{
    className?: string;
    checked?: boolean;
    disabled?: boolean;
    onCheckedChange?: (checked: boolean) => void;
    onSelect?: (e: Event) => void;
    children?: ReactNode;
  }>;
}

const roleTint = (color: number) => `#${(color & 0xffffff).toString(16).padStart(6, "0")}`;

const ROW_MIN_H = 48;
/** Below this many members the panel shows no search field. */
const SEARCH_MIN_MEMBERS = 10;
/**
 * Offscreen rows are viewport-gated at every roster size: each row's `useAuthor`
 * demands a profile, so ungated rows put a kind-0 REQ for the whole roster on
 * the wire alongside the room's first chat REQ. Searches render every row (the
 * matcher reads names a row populates once mounted).
 */

interface MemberRowProps {
  pubkey: string;
  roles?: string[];
  /** Live presence dot (Buzz relays). Undefined = unknown (no dot). */
  presence?: "online" | "away";
  canModerate: boolean;
  viewerIsAdmin: boolean;
  currentUserPubkey?: string;
  onRemove?: (pubkey: string) => void;
  onSetRole?: (pubkey: string, roles: string[]) => void;
  /** Concord: cooperative kick (honest clients drop them; they can rejoin). */
  onKick?: (pubkey: string) => void;
  /** Concord: ban + read-cut (rotate keys to lock them out). */
  onBan?: (pubkey: string) => void;
  /** A ban without a read-cut is just "Ban". */
  banLabel?: (pubkey: string) => string;
  onUnban?: (pubkey: string) => void;
  isBanned?: boolean;
  /** Per-server nickname/label editor (viewer's own row only). */
  onEditProfile?: () => void;
  /** Buzz relays: kind 41010. */
  onMessage?: (pubkey: string) => void;
  roleCatalog?: RolePickerOption[];
  customRoleIds?: string[];
  /** Viewer outranks this member (may edit their roles). */
  canEditRoles?: boolean;
  onToggleRole?: (pubkey: string, roleId: string, on: boolean) => void;
  isRoleToggling?: (pubkey: string, roleId: string) => boolean;
  /** Custom-role chip for members without a tier badge. */
  customBadge?: { name: string; color: number };
}

const MemberRow = memo(function MemberRow({
  pubkey,
  roles,
  presence,
  canModerate,
  viewerIsAdmin,
  currentUserPubkey,
  onRemove,
  onSetRole,
  onKick,
  onBan,
  banLabel,
  onUnban,
  isBanned,
  onEditProfile,
  onMessage,
  roleCatalog,
  customRoleIds,
  canEditRoles,
  onToggleRole,
  isRoleToggling,
  customBadge,
}: MemberRowProps) {
  const author = useAuthor(pubkey);
  const metadata = author.data?.metadata;
  const { displayName, color } = useScopedIdentity(pubkey, metadata);
  const status = useUserStatus(pubkey).data?.status;
  const rawMusicStatus = useUserStatus(pubkey, "music").data?.status;
  // NIP-40 expiration passed: the track ended.
  const musicStatus = isStatusExpired(rawMusicStatus) ? undefined : rawMusicStatus;
  const [statusOpen, setStatusOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  // A legacy Concord epoch (no staff-only address) offers no report.
  const chatScope = useChatScope();
  const reportTo = reportDestination(chatScope);

  const roleSet = new Set((roles ?? []).map((r) => r.toLowerCase()));
  const isOwner = roleSet.has(ROLE_OWNER);
  // The owner holds every permission implicitly, even without the "admin" role string.
  const isAdmin = isOwner || roleSet.has(ROLE_ADMIN);
  const isModerator = roleSet.has(ROLE_MODERATOR);
  const isSelf = currentUserPubkey === pubkey;
  // The owner is never a valid target (mirrors canActOnMember in the roster engine).
  const canActOnUser = canModerate && !isSelf && !isOwner;
  const canReport = Boolean(reportTo && currentUserPubkey && !isSelf);
  // Writes to the user's own list, so available everywhere.
  const mute = useMuteToggle(pubkey);

  const copyNpub = () => {
    const npub = tryNpubEncode(pubkey);
    if (!npub) return;
    writeClipboardText(npub).then(
      () => toast({ title: "Copied npub" }),
      () => toast({ title: "Copy failed", variant: "destructive" }),
    );
  };

  const showRolePicker = Boolean(onToggleRole && canEditRoles && roleCatalog && roleCatalog.length > 0);

  const renderMenuItems = ({ Item, Separator, Label, Sub, SubTrigger, SubContent, CheckboxItem }: MenuParts) => (
    <>
      <Item className="gap-3 px-3 py-2.5" onSelect={() => requestMention(pubkey)}>
        <AtSign className="size-4" />
        Mention
      </Item>
      {onMessage && !isSelf && (
        <Item className="gap-3 px-3 py-2.5" onSelect={() => onMessage(pubkey)}>
          <MessageSquareText className="size-4" />
          Message
        </Item>
      )}
      <Item className="gap-3 px-3 py-2.5" onSelect={copyNpub}>
        <Copy className="size-4" />
        Copy npub
      </Item>

      {isSelf && (
        <Item className="gap-3 px-3 py-2.5" onSelect={() => setStatusOpen(true)}>
          <Smile className="size-4" />
          Set status
        </Item>
      )}

      {isSelf && onEditProfile && (
        <Item className="gap-3 px-3 py-2.5" onSelect={onEditProfile}>
          <IdCard className="size-4" />
          Server identity
        </Item>
      )}

      {((canActOnUser && (onSetRole || onRemove || onKick || onBan || onUnban)) || showRolePicker) && (
        <>
          <Separator />
          <Label className="px-2 pb-1.5 text-2xs uppercase tracking-wide text-muted-foreground/80">
            {/* Can stand alone on the viewer's own row (owner self-assigning a cosmetic role). */}
            {canActOnUser ? "Moderation" : "Roles"}
          </Label>

          {showRolePicker && (
            <Sub>
              <SubTrigger className="gap-3 px-3 py-2.5">
                <UserCog className="size-4" />
                Roles
              </SubTrigger>
              <SubContent className="w-56 max-h-72 overflow-y-auto p-1.5">
                <RolePickerItems
                  CheckboxItem={CheckboxItem}
                  pubkey={pubkey}
                  catalog={roleCatalog!}
                  heldRoleIds={customRoleIds}
                  isToggling={isRoleToggling}
                  onToggle={onToggleRole!}
                />
              </SubContent>
            </Sub>
          )}

          {canActOnUser && onSetRole && viewerIsAdmin && !isAdmin && (
            <Item
              className="gap-3 px-3 py-2.5"
              onSelect={() => onSetRole(pubkey, [ROLE_ADMIN])}
            >
              <Crown className="size-4" />
              Make admin
            </Item>
          )}
          {canActOnUser && onSetRole && !isModerator && !isAdmin && (
            <Item
              className="gap-3 px-3 py-2.5"
              onSelect={() => onSetRole(pubkey, [ROLE_MODERATOR])}
            >
              <Shield className="size-4" />
              Make moderator
            </Item>
          )}
          {canActOnUser && onSetRole && isAdmin && (
            <Item
              className="gap-3 px-3 py-2.5"
              onSelect={() => onSetRole(pubkey, [ROLE_MODERATOR])}
            >
              <Shield className="size-4" />
              Demote to moderator
            </Item>
          )}
          {canActOnUser && onSetRole && (isAdmin || isModerator) && (
            <Item
              className="gap-3 px-3 py-2.5"
              onSelect={() => onSetRole(pubkey, [])}
            >
              <ShieldOff className="size-4" />
              Remove role
            </Item>
          )}

          {canActOnUser && onRemove && (
            <Item
              className="gap-3 px-3 py-2.5 text-destructive focus:text-destructive"
              onSelect={() => onRemove(pubkey)}
            >
              <UserMinus className="size-4" />
              Remove from channel
            </Item>
          )}

          {canActOnUser && onKick && (
            <Item className="gap-3 px-3 py-2.5" onSelect={() => onKick(pubkey)}>
              <UserMinus className="size-4" />
              Kick (can rejoin)
            </Item>
          )}
          {canActOnUser && onBan && !isBanned && (
            <Item
              className="gap-3 px-3 py-2.5 text-destructive focus:text-destructive"
              onSelect={() => onBan(pubkey)}
            >
              <Ban className="size-4" />
              {banLabel?.(pubkey) ?? "Ban & lock out"}
            </Item>
          )}
          {canActOnUser && onUnban && isBanned && (
            <Item className="gap-3 px-3 py-2.5" onSelect={() => onUnban(pubkey)}>
              <ShieldOff className="size-4" />
              Unban
            </Item>
          )}
        </>
      )}

      {(mute.canMute || canReport) && <Separator />}
      {mute.canMute && (
        <Item
          className={cn(
            "gap-3 px-3 py-2.5",
            !mute.muted && "text-destructive focus:text-destructive",
          )}
          onSelect={() => void mute.toggle()}
        >
          {mute.muted ? <UserCheck className="size-4" /> : <UserX className="size-4" />}
          {mute.label}
        </Item>
      )}
      {canReport && (
        <Item
          className="gap-3 px-3 py-2.5 text-destructive focus:text-destructive"
          onSelect={() => setReportOpen(true)}
        >
          <Flag className="size-4" />
          Report
        </Item>
      )}
    </>
  );

  return (
    <>
    <ContextMenu>
    <ContextMenuTrigger className="block">
    <div className="gutter-tick group flex items-center gap-2.5 pl-3 pr-2 py-2 clip-corner-lg transition-colors hover:bg-accent/50 hover:text-foreground">
      <ProfilePreviewCard pubkey={pubkey}>
        <button type="button" className="relative shrink-0 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <Avatar shape={getAvatarShape(metadata)} className="size-8 cursor-pointer transition-opacity hover:opacity-90">
            <AvatarImage src={metadata?.picture} imeta={author.data?.imeta?.picture} alt={displayName} />
            <AvatarFallback className="bg-primary/20 text-primary text-3xs">
              {displayName[0]?.toUpperCase()}
            </AvatarFallback>
          </Avatar>
          {presence && (
            <span
              aria-label={presence === "online" ? "Online" : "Away"}
              className={cn(
                "absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full ring-2 ring-[hsl(var(--chrome))]",
                presence === "online" ? "bg-success" : "bg-amber-500",
              )}
            />
          )}
        </button>
      </ProfilePreviewCard>
      <ProfilePreviewCard pubkey={pubkey}>
        <button
          type="button"
          className="min-w-0 flex-1 text-left focus:outline-none"
        >
          <span className="block text-sm truncate" style={color ? { color } : undefined}>
            <DisplayName pubkey={pubkey} name={displayName} />
          </span>
          {status?.content && (
            <span
              className="block text-xs text-muted-foreground truncate"
              title={status.content}
            >
              <EmojifiedText tags={status.event.tags}>{status.content}</EmojifiedText>
            </span>
          )}
          {musicStatus?.content && (
            <span
              className="flex items-center gap-1 text-xs text-muted-foreground truncate"
              title={musicStatus.content}
            >
              <Music className="size-3 shrink-0" />
              <span className="truncate">
                <EmojifiedText tags={musicStatus.event.tags}>{musicStatus.content}</EmojifiedText>
              </span>
            </span>
          )}
        </button>
      </ProfilePreviewCard>
      {isOwner ? (
        <span
          title="Owner"
          className="shrink-0 inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-3xs font-medium text-amber-500"
        >
          <Crown className="size-3" aria-hidden />
          Owner
        </span>
      ) : isAdmin ? (
        <span
          title="Admin"
          className="shrink-0 inline-flex items-center gap-1 rounded-full bg-primary/15 px-1.5 py-0.5 text-3xs font-medium text-primary"
        >
          <Shield className="size-3" aria-hidden />
          Admin
        </span>
      ) : isModerator ? (
        <span
          title="Moderator"
          className="shrink-0 inline-flex items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-3xs font-medium text-muted-foreground"
        >
          <Shield className="size-3" aria-hidden />
          Mod
        </span>
      ) : customBadge ? (
        <span
          title={customBadge.name}
          className={cn(
            "shrink-0 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-3xs font-medium max-w-24",
            !customBadge.color && "bg-muted text-muted-foreground",
          )}
          style={customBadge.color ? { color: roleTint(customBadge.color), backgroundColor: `${roleTint(customBadge.color)}26` } : undefined}
        >
          <span className="truncate">{customBadge.name}</span>
        </span>
      ) : roleSet.has(ROLE_BOT) ? (
        <span
          title="Agent"
          className="shrink-0 inline-flex items-center gap-1 rounded-full bg-primary/15 px-1.5 py-0.5 text-3xs font-medium text-primary"
        >
          <Bot className="size-3" aria-hidden />
          Agent
        </span>
      ) : roleSet.has(ROLE_GUEST) ? (
        <span
          title="Guest"
          className="shrink-0 inline-flex items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-3xs font-medium text-muted-foreground"
        >
          Guest
        </span>
      ) : null}
      <BotPill metadata={metadata} />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Manage ${displayName}`}
            className="size-6 touch:size-10 opacity-0 group-hover:opacity-100 touch:opacity-100 data-[state=open]:opacity-100 text-muted-foreground hover:text-foreground"
          >
            <MoreVertical className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64 p-2">
          {renderMenuItems({
            Item: DropdownMenuItem,
            Separator: DropdownMenuSeparator,
            Label: DropdownMenuLabel,
            Sub: DropdownMenuSub,
            SubTrigger: DropdownMenuSubTrigger,
            SubContent: DropdownMenuSubContent,
            CheckboxItem: DropdownMenuCheckboxItem,
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
    </ContextMenuTrigger>
    <ContextMenuContent className="w-64 p-2">
      {renderMenuItems({
        Item: ContextMenuItem,
        Separator: ContextMenuSeparator,
        Label: ContextMenuLabel,
        Sub: ContextMenuSub,
        SubTrigger: ContextMenuSubTrigger,
        SubContent: ContextMenuSubContent,
        CheckboxItem: ContextMenuCheckboxItem,
      })}
    </ContextMenuContent>
    </ContextMenu>
    {isSelf && <StatusDialog open={statusOpen} onOpenChange={setStatusOpen} />}
    {reportOpen && reportTo && (
      <ReportDialog
        open={reportOpen}
        onOpenChange={setReportOpen}
        destination={reportTo}
        target={{ pubkey }}
      />
    )}
    </>
  );
});

interface MemberListProps {
  admins: Nip29Admin[];
  members: string[];
  canModerate: boolean;
  viewerIsAdmin?: boolean;
  currentUserPubkey?: string;
  onRemove?: (pubkey: string) => void;
  onSetRole?: (pubkey: string, roles: string[]) => void;
  /** Concord moderation (additive; NIP-29 leaves these unset). */
  onKick?: (pubkey: string) => void;
  onBan?: (pubkey: string) => void;
  banLabel?: (pubkey: string) => string;
  onUnban?: (pubkey: string) => void;
  bannedPubkeys?: Set<string>;
  /** Per-member role labels (Buzz: member/guest/bot). */
  memberRoles?: Record<string, string>;
  /** Live presence (Buzz: ephemeral kind-20001 heartbeats). */
  presence?: Record<string, "online" | "away">;
  onClose?: () => void;
  onEditProfile?: () => void;
  /** Buzz relays: kind 41010. */
  onMessage?: (pubkey: string) => void;
  roleCatalog?: RolePickerOption[];
  memberRoleIds?: Record<string, string[]>;
  canEditMemberRoles?: (pubkey: string) => boolean;
  onToggleRole?: (pubkey: string, roleId: string, on: boolean) => void;
  isRoleToggling?: (pubkey: string, roleId: string) => boolean;
  /** Hoisted role sections above Admins; their members appear only there. */
  roleSections?: Array<{ id: string; name: string; color: number; members: string[] }>;
  /** Concord: add-members for the active private channel; set only when the viewer may grant access. */
  onAddMembers?: () => void;
  className?: string;
}

/**
 * Right-hand member panel. Memoized: the page re-renders on every store write
 * and a roster render walks a row per member.
 */
export const MemberList = memo(function MemberList({
  admins,
  members,
  canModerate,
  viewerIsAdmin = false,
  currentUserPubkey,
  onRemove,
  onSetRole,
  onKick,
  onBan,
  banLabel,
  onUnban,
  bannedPubkeys,
  memberRoles,
  presence,
  onClose,
  onEditProfile,
  onMessage,
  roleCatalog,
  memberRoleIds,
  canEditMemberRoles,
  onToggleRole,
  isRoleToggling,
  roleSections,
  onAddMembers,
  className,
}: MemberListProps) {
  const { mutedPubkeys } = useMutedPubkeys();
  const [query, setQuery] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  const adminMap = new Map(admins.map((a) => [a.pubkey, a.roles] as const));
  // Stable arrays so memoized rows get stable `roles` identities.
  const buzzRoles = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const [pubkey, role] of Object.entries(memberRoles ?? {})) m.set(pubkey, [role]);
    return m;
  }, [memberRoles]);
  const sectioned = new Set((roleSections ?? []).flatMap((s) => s.members));
  // First (highest-position) server-scope custom role; tier badges win in MemberRow.
  const customBadgeOf = (pubkey: string): { name: string; color: number } | undefined => {
    const held = memberRoleIds?.[pubkey];
    if (!held?.length || !roleCatalog) return undefined;
    return roleCatalog.find((r) => r.channelName === undefined && held.includes(r.id));
  };
  // NIP-29 `p` tag order isn't stable across refetches; sort owner first, then pubkey.
  const isOwnerRole = (a: Nip29Admin) => a.roles.some((r) => r.toLowerCase() === "owner");
  // Muted people leave the roster entirely, filtered at the source so counts and
  // empty states agree.
  const sortedAdmins = [...admins]
    .filter((a) => !mutedPubkeys.has(a.pubkey))
    .sort((a, b) => {
      const ao = isOwnerRole(a) ? 0 : 1;
      const bo = isOwnerRole(b) ? 0 : 1;
      return ao - bo || a.pubkey.localeCompare(b.pubkey);
    });
  const allRegulars = members
    .filter((pubkey) => !adminMap.has(pubkey) && !mutedPubkeys.has(pubkey))
    .sort((a, b) => a.localeCompare(b));

  const roster = useMemo(
    () => [...sortedAdmins.map((a) => a.pubkey), ...allRegulars],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sortedAdmins.map((a) => a.pubkey).join(","), allRegulars.join(",")],
  );
  const matched = useMemberSearch(roster, query);
  const searching = matched !== null;
  const virtualize = !searching;

  const visibleAdmins = sortedAdmins.filter(
    (a) => !sectioned.has(a.pubkey) && (!matched || matched.has(a.pubkey)),
  );
  const regulars = allRegulars.filter(
    (pubkey) => !sectioned.has(pubkey) && (!matched || matched.has(pubkey)),
  );
  const visibleSections = (roleSections ?? []).map((section) => ({
    ...section,
    members: section.members.filter(
      (pubkey) => !mutedPubkeys.has(pubkey) && (!matched || matched.has(pubkey)),
    ),
  }));
  const noMatches =
    searching &&
    visibleAdmins.length === 0 &&
    regulars.length === 0 &&
    visibleSections.every((section) => section.members.length === 0);

  const firstSection = visibleSections.find((s) => !searching || s.members.length > 0);
  // A list short enough to read at a glance needs no search; kept while a query is live.
  const showSearch = roster.length >= SEARCH_MIN_MEMBERS || query !== "";

  return (
    <aside
      className={cn(
        "flex flex-col flex-1 min-w-0 overflow-hidden",
        "m-2 sidebar:my-3 sidebar:mr-2 sidebar:ml-0 p-1.5 clip-corner-lg bg-chrome",
        className,
      )}
    >
      {onClose && (
        <div className="flex items-center justify-between px-2 py-1 shrink-0 sidebar:hidden">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Members</h3>
          <Button variant="ghost" size="icon" aria-label="Close members" className="size-6 touch:size-10" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>
      )}
      {onAddMembers && (
        <button
          type="button"
          onClick={onAddMembers}
          className="flex w-full shrink-0 items-center gap-2.5 pl-3 pr-2 py-2 mb-1 clip-corner-lg text-left text-sm text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
            <UserPlus className="size-4" aria-hidden />
          </span>
          Add members
        </button>
      )}

      {showSearch && (
        <div className="flex shrink-0 items-center gap-1.5 px-2 pb-1.5 pt-1">
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <Input
            // Not type="search": WebKit/Blink add their own cancel button.
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && query) {
                event.stopPropagation();
                setQuery("");
              }
            }}
            placeholder="Search members"
            aria-label="Search members"
            className="h-8 flex-1 border-0 bg-transparent px-1 text-sm shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
          />
          {query && (
            <Button
              variant="ghost"
              size="icon"
              aria-label="Clear search"
              className="size-8 touch:size-10 shrink-0 text-muted-foreground hover:text-foreground"
              onClick={() => setQuery("")}
            >
              <X className="size-4" />
            </Button>
          )}
        </div>
      )}

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto">
      {noMatches && (
        <p className="px-2 py-3 text-xs text-muted-foreground">
          No members match “{query.trim()}”.
        </p>
      )}
      {visibleAdmins.length > 0 && (
        <>
          <div className="flex items-center gap-1 px-2 py-1">
            <h3 className="flex-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Admins · {visibleAdmins.length}
            </h3>
          </div>
          {visibleAdmins.map((admin) => (
            <DeferredRow key={admin.pubkey} active={virtualize} minHeight={ROW_MIN_H} rootRef={scrollRef}>
            <MemberRow
              pubkey={admin.pubkey}
              roles={admin.roles}
              presence={presence?.[admin.pubkey]}
              canModerate={canModerate}
              viewerIsAdmin={viewerIsAdmin}
              currentUserPubkey={currentUserPubkey}
              onRemove={onRemove}
              onSetRole={onSetRole}
              onKick={onKick}
              onBan={onBan}
              banLabel={banLabel}
              onUnban={onUnban}
              isBanned={bannedPubkeys?.has(admin.pubkey)}
              onEditProfile={onEditProfile}
              onMessage={onMessage}
              roleCatalog={roleCatalog}
              customRoleIds={memberRoleIds?.[admin.pubkey]}
              canEditRoles={canEditMemberRoles?.(admin.pubkey)}
              onToggleRole={onToggleRole}
              isRoleToggling={isRoleToggling}
              customBadge={customBadgeOf(admin.pubkey)}
            />
            </DeferredRow>
          ))}
        </>
      )}

      {visibleSections.map((section) =>
        !searching || section.members.length > 0 ? (
          <div key={section.id}>
            <div className="flex items-center gap-1 px-2 py-1">
              <h3
                className="flex-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground"
                style={section.color ? { color: roleTint(section.color) } : undefined}
              >
                {section.name} · {section.members.length}
              </h3>
            </div>
            {section.members.map((pubkey) => (
              <DeferredRow key={pubkey} active={virtualize} minHeight={ROW_MIN_H} rootRef={scrollRef}>
              <MemberRow
                pubkey={pubkey}
                roles={adminMap.get(pubkey)}
                presence={presence?.[pubkey]}
                canModerate={canModerate}
                viewerIsAdmin={viewerIsAdmin}
                currentUserPubkey={currentUserPubkey}
                onRemove={onRemove}
                onSetRole={onSetRole}
                onKick={onKick}
                onBan={onBan}
                banLabel={banLabel}
                onUnban={onUnban}
                isBanned={bannedPubkeys?.has(pubkey)}
                onEditProfile={onEditProfile}
                onMessage={onMessage}
                roleCatalog={roleCatalog}
                customRoleIds={memberRoleIds?.[pubkey]}
                canEditRoles={canEditMemberRoles?.(pubkey)}
                onToggleRole={onToggleRole}
                isRoleToggling={isRoleToggling}
              />
              </DeferredRow>
            ))}
          </div>
        ) : null,
      )}

      {(!searching || regulars.length > 0) && (
        <div className={cn("flex items-center gap-1 px-2 py-1", (visibleAdmins.length > 0 || firstSection) && "mt-2")}>
          <h3 className="flex-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Members · {regulars.length}
          </h3>
        </div>
      )}
      {regulars.length === 0 ? (
        !searching && (
          <p className="px-2 py-2 text-xs text-muted-foreground">
            No visible members. The relay may hide the member list.
          </p>
        )
      ) : (
        regulars.map((pubkey) => (
          <DeferredRow key={pubkey} active={virtualize} minHeight={ROW_MIN_H} rootRef={scrollRef}>
          <MemberRow
            pubkey={pubkey}
            roles={buzzRoles.get(pubkey)}
            presence={presence?.[pubkey]}
            canModerate={canModerate}
            viewerIsAdmin={viewerIsAdmin}
            currentUserPubkey={currentUserPubkey}
            onRemove={onRemove}
            onSetRole={onSetRole}
            onKick={onKick}
            onBan={onBan}
            banLabel={banLabel}
            onUnban={onUnban}
            isBanned={bannedPubkeys?.has(pubkey)}
            onEditProfile={onEditProfile}
            onMessage={onMessage}
            roleCatalog={roleCatalog}
            customRoleIds={memberRoleIds?.[pubkey]}
            canEditRoles={canEditMemberRoles?.(pubkey)}
            onToggleRole={onToggleRole}
            isRoleToggling={isRoleToggling}
            customBadge={customBadgeOf(pubkey)}
          />
          </DeferredRow>
        ))
      )}
      </div>
    </aside>
  );
});
