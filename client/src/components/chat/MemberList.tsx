import { AtSign, Copy, Crown, MoreVertical, Shield, ShieldOff, UserMinus } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAuthor } from "@/hooks/useAuthor";
import { requestMention } from "@/hooks/useMentionBus";
import { toast } from "@/hooks/useToast";
import { getAvatarShape } from "@/lib/avatarShape";
import { getDisplayName } from "@/lib/getDisplayName";
import { tryNpubEncode } from "@/lib/safeNip19";
import { cn } from "@/lib/utils";

import type { Nip29Admin } from "@/lib/nip29";

const ROLE_ADMIN = "admin";
const ROLE_MODERATOR = "moderator";

interface MemberRowProps {
  pubkey: string;
  roles?: string[];
  canModerate: boolean;
  /** Whether the viewer is an admin (required to grant the admin role). */
  viewerIsAdmin: boolean;
  /** The viewer's own pubkey, to suppress self-moderation. */
  currentUserPubkey?: string;
  onRemove?: (pubkey: string) => void;
  onSetRole?: (pubkey: string, roles: string[]) => void;
}

function MemberRow({
  pubkey,
  roles,
  canModerate,
  viewerIsAdmin,
  currentUserPubkey,
  onRemove,
  onSetRole,
}: MemberRowProps) {
  const author = useAuthor(pubkey);
  const metadata = author.data?.metadata;
  const displayName = getDisplayName(metadata, pubkey);

  const roleSet = new Set((roles ?? []).map((r) => r.toLowerCase()));
  const isAdmin = roleSet.has(ROLE_ADMIN);
  const isModerator = roleSet.has(ROLE_MODERATOR);
  const isSelf = currentUserPubkey === pubkey;
  // Moderation acts on others only; everyone gets the basic items.
  const canActOnUser = canModerate && !isSelf;

  const copyNpub = () => {
    const npub = tryNpubEncode(pubkey);
    if (!npub) return;
    navigator.clipboard?.writeText(npub).then(
      () => toast({ title: "Copied npub" }),
      () => toast({ title: "Copy failed", variant: "destructive" }),
    );
  };

  return (
    <div className="gutter-tick group flex items-center gap-2.5 pl-3 pr-2 py-2 transition-colors hover:text-foreground">
      <Avatar shape={getAvatarShape(metadata)} className="size-8 shrink-0">
        <AvatarImage src={metadata?.picture} alt={displayName} />
        <AvatarFallback className="bg-primary/20 text-primary text-[10px]">
          {displayName[0]?.toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <span className="text-sm truncate flex-1">{displayName}</span>
      {roles && roles.length > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="secondary" className="gap-1 text-[10px] px-1.5">
              <Crown className="size-2.5" /> {roles[0]}
            </Badge>
          </TooltipTrigger>
          <TooltipContent>{roles.join(", ")}</TooltipContent>
        </Tooltip>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Manage ${displayName}`}
            className="size-6 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100 text-muted-foreground hover:text-foreground"
          >
            <MoreVertical className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64 p-2">
          <DropdownMenuItem className="gap-3 px-3 py-2.5" onClick={() => requestMention(pubkey)}>
            <AtSign className="size-4" />
            Mention
          </DropdownMenuItem>
          <DropdownMenuItem className="gap-3 px-3 py-2.5" onClick={copyNpub}>
            <Copy className="size-4" />
            Copy npub
          </DropdownMenuItem>

          {canActOnUser && (onSetRole || onRemove) && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="px-2 pb-1.5 text-[11px] uppercase tracking-wide text-muted-foreground/80">
                Moderation
              </DropdownMenuLabel>

              {onSetRole && viewerIsAdmin && !isAdmin && (
                <DropdownMenuItem
                  className="gap-3 px-3 py-2.5"
                  onClick={() => onSetRole(pubkey, [ROLE_ADMIN])}
                >
                  <Crown className="size-4" />
                  Make admin
                </DropdownMenuItem>
              )}
              {onSetRole && !isModerator && !isAdmin && (
                <DropdownMenuItem
                  className="gap-3 px-3 py-2.5"
                  onClick={() => onSetRole(pubkey, [ROLE_MODERATOR])}
                >
                  <Shield className="size-4" />
                  Make moderator
                </DropdownMenuItem>
              )}
              {onSetRole && isAdmin && (
                <DropdownMenuItem
                  className="gap-3 px-3 py-2.5"
                  onClick={() => onSetRole(pubkey, [ROLE_MODERATOR])}
                >
                  <Shield className="size-4" />
                  Demote to moderator
                </DropdownMenuItem>
              )}
              {onSetRole && (isAdmin || isModerator) && (
                <DropdownMenuItem
                  className="gap-3 px-3 py-2.5"
                  onClick={() => onSetRole(pubkey, [])}
                >
                  <ShieldOff className="size-4" />
                  Remove role
                </DropdownMenuItem>
              )}

              {onRemove && (
                <DropdownMenuItem
                  className="gap-3 px-3 py-2.5 text-destructive focus:text-destructive"
                  onClick={() => onRemove(pubkey)}
                >
                  <UserMinus className="size-4" />
                  Remove from channel
                </DropdownMenuItem>
              )}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
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
  className,
}: MemberListProps) {
  const adminMap = new Map(admins.map((a) => [a.pubkey, a.roles] as const));
  const regulars = members.filter((pubkey) => !adminMap.has(pubkey));

  return (
    <aside
      className={cn(
        // Floating roster: detached by a margin, cut-corner card, same recessed
        // chrome shade as the rail/console/header. No border.
        "hidden lg:flex flex-col w-56 shrink-0 overflow-y-auto",
        "my-2 mr-2 p-1.5 clip-corner-lg bg-black/30",
        className,
      )}
    >
      {admins.length > 0 && (
        <>
          <h3 className="px-2 py-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Admins · {admins.length}
          </h3>
          {admins.map((admin) => (
            <MemberRow
              key={admin.pubkey}
              pubkey={admin.pubkey}
              roles={admin.roles}
              canModerate={canModerate}
              viewerIsAdmin={viewerIsAdmin}
              currentUserPubkey={currentUserPubkey}
              onRemove={onRemove}
              onSetRole={onSetRole}
            />
          ))}
        </>
      )}

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
            canModerate={canModerate}
            viewerIsAdmin={viewerIsAdmin}
            currentUserPubkey={currentUserPubkey}
            onRemove={onRemove}
            onSetRole={onSetRole}
          />
        ))
      )}
    </aside>
  );
}
