import { AtSign, Ban, Bot, Copy, Crown, IdCard, MessageSquareText, MoreVertical, Music, Shield, ShieldOff, Smile, UserCog, UserMinus, X } from "lucide-react";

import { useState } from "react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { BotPill } from "@/components/BotPill";
import { ProfilePreviewCard } from "@/components/chat/ProfilePreviewCard";
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
import { DisplayName } from "@/components/DisplayName";
import { useAuthor } from "@/hooks/useAuthor";
import { useScopedIdentity } from "@/hooks/useScopedDisplayName";
import { isStatusExpired, useUserStatus } from "@/hooks/useUserStatus";
import { requestMention } from "@/hooks/useMentionBus";
import { toast } from "@/hooks/useToast";
import { getAvatarShape } from "@/lib/avatarShape";
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

/**
 * The menu primitives shared by the ⋮ dropdown and the right-click context
 * menu — Radix's DropdownMenu and ContextMenu items have compatible props, so
 * the member actions are defined once and rendered through either family.
 */
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

/** A grantable role in the member-row "Roles" picker (Concord custom roles). */
export interface RolePickerOption {
  id: string;
  name: string;
  /** Cosmetic badge tint (low 24 bits an #rrggbb); 0 = theme default. */
  color: number;
  /** Set when the role is channel-scoped — rendered as a "# channel" hint. */
  channelName?: string;
  /** Whether the viewer outranks this role's position (may grant/revoke it). */
  assignable: boolean;
}

const roleTint = (color: number) => `#${(color & 0xffffff).toString(16).padStart(6, "0")}`;

interface MemberRowProps {
  pubkey: string;
  roles?: string[];
  /** Live presence dot (Buzz relays). Undefined = unknown (no dot). */
  presence?: "online" | "away";
  canModerate: boolean;
  /** Whether the viewer is an admin (required to grant the admin role). */
  viewerIsAdmin: boolean;
  /** The viewer's own pubkey, to suppress self-moderation. */
  currentUserPubkey?: string;
  onRemove?: (pubkey: string) => void;
  onSetRole?: (pubkey: string, roles: string[]) => void;
  /** Concord: cooperatively kick (honest clients drop them; they can rejoin). */
  onKick?: (pubkey: string) => void;
  /** Concord: ban + read-cut (rotate keys to lock them out). */
  onBan?: (pubkey: string) => void;
  /** Menu label for the ban action (a ban without a read-cut is just "Ban"). */
  banLabel?: (pubkey: string) => string;
  /** Concord: unban a currently-banned member. */
  onUnban?: (pubkey: string) => void;
  /** Concord: whether this member is currently banned. */
  isBanned?: boolean;
  /** Open the per-server nickname/label editor (shown only on the viewer's own row). */
  onEditProfile?: () => void;
  /** Start a direct message with this member (Buzz relays: kind 41010). */
  onMessage?: (pubkey: string) => void;
  /** Concord: every custom role, for the per-member "Roles" picker submenu. */
  roleCatalog?: RolePickerOption[];
  /** Concord: role ids this member currently holds. */
  customRoleIds?: string[];
  /** Concord: whether the viewer outranks this member (may edit their roles). */
  canEditRoles?: boolean;
  /** Concord: grant/revoke one custom role. */
  onToggleRole?: (pubkey: string, roleId: string, on: boolean) => void;
  /** True while a toggle for this member+role is still publishing. */
  isRoleToggling?: (pubkey: string, roleId: string) => boolean;
  /** A custom-role chip for members without a tier badge (name + tint). */
  customBadge?: { name: string; color: number };
}

function MemberRow({
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
  // Hide a music status whose NIP-40 expiration has passed (track ended).
  const musicStatus = isStatusExpired(rawMusicStatus) ? undefined : rawMusicStatus;
  const [statusOpen, setStatusOpen] = useState(false);

  const roleSet = new Set((roles ?? []).map((r) => r.toLowerCase()));
  const isOwner = roleSet.has(ROLE_OWNER);
  // The owner holds every permission implicitly, so treat them as an admin for
  // moderation gating (e.g. don't offer "Make admin" on the owner) even if the
  // explicit "admin" role string isn't present.
  const isAdmin = isOwner || roleSet.has(ROLE_ADMIN);
  const isModerator = roleSet.has(ROLE_MODERATOR);
  const isSelf = currentUserPubkey === pubkey;
  // Moderation acts on others only; the owner is never a valid target (they're
  // supreme and unremovable — mirrors canActOnMember in the roster engine).
  const canActOnUser = canModerate && !isSelf && !isOwner;

  const copyNpub = () => {
    const npub = tryNpubEncode(pubkey);
    if (!npub) return;
    writeClipboardText(npub).then(
      () => toast({ title: "Copied npub" }),
      () => toast({ title: "Copy failed", variant: "destructive" }),
    );
  };

  const showRolePicker = Boolean(onToggleRole && canEditRoles && roleCatalog && roleCatalog.length > 0);

  // Shared between the ⋮ dropdown and the right-click context menu.
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
          <Label className="px-2 pb-1.5 text-[11px] uppercase tracking-wide text-muted-foreground/80">
            {/* The picker can stand alone on the viewer's own row (an owner
                self-assigning a cosmetic role) — no moderation implied. */}
            {canActOnUser ? "Moderation" : "Roles"}
          </Label>

          {showRolePicker && (
            <Sub>
              <SubTrigger className="gap-3 px-3 py-2.5">
                <UserCog className="size-4" />
                Roles
              </SubTrigger>
              <SubContent className="w-56 max-h-72 overflow-y-auto p-1.5">
                {roleCatalog!.map((role) => (
                  <CheckboxItem
                    key={role.id}
                    className="py-2"
                    checked={customRoleIds?.includes(role.id) ?? false}
                    // A Grant replaces the member's whole role list, so a
                    // second click before the first lands would publish from a
                    // stale set and re-trigger any gated-channel rotation.
                    disabled={!role.assignable || Boolean(isRoleToggling?.(pubkey, role.id))}
                    onCheckedChange={(on) => onToggleRole!(pubkey, role.id, on)}
                    // Keep the menu open so several roles can be toggled in one visit.
                    onSelect={(e) => e.preventDefault()}
                  >
                    <span className="min-w-0 flex-1 truncate text-sm" style={role.color ? { color: roleTint(role.color) } : undefined}>
                      {role.name}
                    </span>
                    {role.channelName && (
                      <span className="ml-2 shrink-0 text-[11px] text-muted-foreground truncate max-w-24"># {role.channelName}</span>
                    )}
                  </CheckboxItem>
                ))}
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
            <AvatarImage src={metadata?.picture} alt={displayName} />
            <AvatarFallback className="bg-primary/20 text-primary text-[10px]">
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
          className="shrink-0 inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-500"
        >
          <Crown className="size-3" aria-hidden />
          Owner
        </span>
      ) : isAdmin ? (
        <span
          title="Admin"
          className="shrink-0 inline-flex items-center gap-1 rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary"
        >
          <Shield className="size-3" aria-hidden />
          Admin
        </span>
      ) : isModerator ? (
        <span
          title="Moderator"
          className="shrink-0 inline-flex items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
        >
          <Shield className="size-3" aria-hidden />
          Mod
        </span>
      ) : customBadge ? (
        <span
          title={customBadge.name}
          className={cn(
            "shrink-0 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium max-w-24",
            !customBadge.color && "bg-muted text-muted-foreground",
          )}
          style={customBadge.color ? { color: roleTint(customBadge.color), backgroundColor: `${roleTint(customBadge.color)}26` } : undefined}
        >
          <span className="truncate">{customBadge.name}</span>
        </span>
      ) : roleSet.has(ROLE_BOT) ? (
        <span
          title="Agent"
          className="shrink-0 inline-flex items-center gap-1 rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary"
        >
          <Bot className="size-3" aria-hidden />
          Agent
        </span>
      ) : roleSet.has(ROLE_GUEST) ? (
        <span
          title="Guest"
          className="shrink-0 inline-flex items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
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
    </>
  );
}

interface MemberListProps {
  admins: Nip29Admin[];
  members: string[];
  canModerate: boolean;
  /** Whether the viewer is an admin (required to grant the admin role). */
  viewerIsAdmin?: boolean;
  /** The viewer's own pubkey, to suppress self-moderation. */
  currentUserPubkey?: string;
  onRemove?: (pubkey: string) => void;
  onSetRole?: (pubkey: string, roles: string[]) => void;
  /** Concord moderation (additive; NIP-29 leaves these unset). */
  onKick?: (pubkey: string) => void;
  onBan?: (pubkey: string) => void;
  banLabel?: (pubkey: string) => string;
  onUnban?: (pubkey: string) => void;
  /** Concord: the set of currently-banned pubkeys (hex). */
  bannedPubkeys?: Set<string>;
  /** Per-member role labels (Buzz: member/guest/bot) for badge rendering. */
  memberRoles?: Record<string, string>;
  /** Live presence (Buzz: ephemeral kind-20001 heartbeats). */
  presence?: Record<string, "online" | "away">;
  /** Close the panel (mobile overlay close button). */
  onClose?: () => void;
  /** Open the per-server nickname/label editor for the current user. */
  onEditProfile?: () => void;
  /** Start a direct message with a member (Buzz relays: kind 41010). */
  onMessage?: (pubkey: string) => void;
  /** Concord: every custom role, position-ordered, for the "Roles" picker. */
  roleCatalog?: RolePickerOption[];
  /** Concord: pubkey → the custom role ids that member holds. */
  memberRoleIds?: Record<string, string[]>;
  /** Concord: whether the viewer outranks a member (may edit their roles). */
  canEditMemberRoles?: (pubkey: string) => boolean;
  /** Concord: grant/revoke one custom role on one member. */
  onToggleRole?: (pubkey: string, roleId: string, on: boolean) => void;
  /** True while a toggle for this member+role is still publishing. */
  isRoleToggling?: (pubkey: string, roleId: string) => boolean;
  /**
   * Hoisted role sections, in display order: each renders as its own named
   * group above Admins, and its members are pulled out of the Admins/Members
   * groups below (a member appears exactly once).
   */
  roleSections?: Array<{ id: string; name: string; color: number; members: string[] }>;
  /** Override the default desktop panel chrome (e.g. for the mobile drawer). */
  className?: string;
}

/** Right-hand member panel: admins (with roles) first, then regular members. */
export function MemberList({
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
  className,
}: MemberListProps) {
  const adminMap = new Map(admins.map((a) => [a.pubkey, a.roles] as const));
  // Members already shown under a hoisted role section render nowhere else.
  const sectioned = new Set((roleSections ?? []).flatMap((s) => s.members));
  // The chip for a member with no tier badge: their first (highest-position)
  // server-scope custom role. Tier badges out-prioritize it in MemberRow.
  const customBadgeOf = (pubkey: string): { name: string; color: number } | undefined => {
    const held = memberRoleIds?.[pubkey];
    if (!held?.length || !roleCatalog) return undefined;
    return roleCatalog.find((r) => !r.channelName && held.includes(r.id));
  };
  // NIP-29 relays don't guarantee a stable order for the `p` tags in the
  // members/admins events, so each 30s refetch could otherwise reshuffle the
  // roster. Sort the owner first, then by pubkey for a stable order.
  const isOwnerRole = (a: Nip29Admin) => a.roles.some((r) => r.toLowerCase() === "owner");
  const sortedAdmins = [...admins].sort((a, b) => {
    const ao = isOwnerRole(a) ? 0 : 1;
    const bo = isOwnerRole(b) ? 0 : 1;
    return ao - bo || a.pubkey.localeCompare(b.pubkey);
  });
  const visibleAdmins = sortedAdmins.filter((a) => !sectioned.has(a.pubkey));
  const regulars = members
    .filter((pubkey) => !adminMap.has(pubkey) && !sectioned.has(pubkey))
    .sort((a, b) => a.localeCompare(b));

  return (
    <aside
      className={cn(
        // Floating roster: detached by a margin, cut-corner card, same recessed
        // chrome shade as the rail/console/header. No border. Matches the thread
        // panel: full-screen card overlay on mobile, in-flow card on desktop.
        "flex flex-col flex-1 min-w-0 overflow-y-auto",
        "m-2 sidebar:my-3 sidebar:mr-2 sidebar:ml-0 p-1.5 clip-corner-lg bg-chrome",
        className,
      )}
    >
      {/* Mobile close affordance (desktop hides via the header toggle). */}
      {onClose && (
        <div className="flex items-center justify-between px-2 py-1 shrink-0 sidebar:hidden">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Members</h3>
          <Button variant="ghost" size="icon" aria-label="Close members" className="size-6 touch:size-10" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>
      )}
      {visibleAdmins.length > 0 && (
        <>
          <h3 className="px-2 py-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Admins · {visibleAdmins.length}
          </h3>
          {visibleAdmins.map((admin) => (
            <MemberRow
              key={admin.pubkey}
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
          ))}
        </>
      )}

      {(roleSections ?? []).map((section) => (
        <div key={section.id}>
          <h3
            className="px-2 py-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground"
            style={section.color ? { color: roleTint(section.color) } : undefined}
          >
            {section.name} · {section.members.length}
          </h3>
          {section.members.map((pubkey) => (
            <MemberRow
              key={pubkey}
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
          ))}
        </div>
      ))}

      <h3 className="px-2 py-1 mt-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Members · {regulars.length}
      </h3>
      {regulars.length === 0 ? (
        <p className="px-2 py-2 text-xs text-muted-foreground">
          No visible members. The relay may hide the member list.
        </p>
      ) : (
        regulars.map((pubkey) => (
          <MemberRow
            key={pubkey}
            pubkey={pubkey}
            roles={memberRoles?.[pubkey] ? [memberRoles[pubkey]] : undefined}
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
        ))
      )}
    </aside>
  );
}
