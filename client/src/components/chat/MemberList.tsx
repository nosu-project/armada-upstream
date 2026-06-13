import { Crown, ShieldX } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAuthor } from "@/hooks/useAuthor";
import { getAvatarShape } from "@/lib/avatarShape";
import { getDisplayName } from "@/lib/getDisplayName";
import { cn } from "@/lib/utils";

import type { Nip29Admin } from "@/lib/nip29";

interface MemberRowProps {
  pubkey: string;
  roles?: string[];
  canModerate: boolean;
  onRemove?: (pubkey: string) => void;
}

function MemberRow({ pubkey, roles, canModerate, onRemove }: MemberRowProps) {
  const author = useAuthor(pubkey);
  const metadata = author.data?.metadata;
  const displayName = getDisplayName(metadata, pubkey);

  return (
    <div className="group flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-accent transition-colors">
      <Avatar shape={getAvatarShape(metadata)} className="size-7 shrink-0">
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
      {canModerate && onRemove && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Remove ${displayName}`}
              className="size-6 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive"
              onClick={() => onRemove(pubkey)}
            >
              <ShieldX className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Remove from channel</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

interface MemberListProps {
  admins: Nip29Admin[];
  members: string[];
  canModerate: boolean;
  onRemove?: (pubkey: string) => void;
  /** Override the default desktop panel chrome (e.g. for the mobile drawer). */
  className?: string;
}

/** Right-hand member panel: admins (with roles) first, then regular members. */
export function MemberList({ admins, members, canModerate, onRemove, className }: MemberListProps) {
  const adminPubkeys = new Set(admins.map((a) => a.pubkey));
  const regulars = members.filter((pubkey) => !adminPubkeys.has(pubkey));

  return (
    <aside className={cn("w-56 shrink-0 border-l bg-card/50 overflow-y-auto p-2 hidden lg:block", className)}>
      {admins.length > 0 && (
        <>
          <h3 className="px-2 py-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Admins — {admins.length}
          </h3>
          {admins.map((admin) => (
            <MemberRow
              key={admin.pubkey}
              pubkey={admin.pubkey}
              roles={admin.roles}
              canModerate={false}
            />
          ))}
        </>
      )}

      <h3 className="px-2 py-1 mt-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Members — {regulars.length}
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
            onRemove={onRemove}
          />
        ))
      )}
    </aside>
  );
}
