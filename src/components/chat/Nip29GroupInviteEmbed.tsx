import { Hash } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useJoinGroup } from "@/hooks/useGroupMembership";
import { useLocalGroupMeta } from "@/hooks/useLocalGroupMeta";
import { useRelayInfo } from "@/hooks/useRelayInfo";
import { toast } from "@/hooks/useToast";
import { useUpdateUserGroupList, useUserGroupList } from "@/hooks/useUserGroupList";
import { nip29GroupPath, relayRejectionMessage, type GroupAddress } from "@/lib/nip29";
import { normalizeRelayUrl } from "@/lib/platform";
import { displayHost, sanitizeImageSrc } from "@/lib/sanitizeUrl";
import { cn } from "@/lib/utils";
import { FormattedMessage, t, useIntl } from "@/i18n";

interface Nip29GroupInviteEmbedProps {
  group: GroupAddress;
  className?: string;
}

/**
 * Join card for a NIP-29 group reference (kind-39000 naddr or `host'group`).
 * The group's metadata comes from the relay's local tenant only: a hidden
 * group's 39000 needs AUTH, which an unsolicited embed must not answer.
 */
export function Nip29GroupInviteEmbed({ group, className }: Nip29GroupInviteEmbedProps) {
  const intl = useIntl();
  const navigate = useNavigate();
  const { user } = useCurrentUser();
  const meta = useLocalGroupMeta(group.relay, group.groupId);
  const { data: relayInfo } = useRelayInfo(group.relay);
  const { data: groupList } = useUserGroupList();
  const { mutateAsync: updateList } = useUpdateUserGroupList();
  const join = useJoinGroup(group.relay, group.groupId);
  const [joined, setJoined] = useState(false);

  const inList = groupList?.groups.some(
    (g) => g.id === group.groupId && (normalizeRelayUrl(g.relay) ?? g.relay) === group.relay,
  ) ?? false;

  const path = nip29GroupPath(group);
  const host = displayHost(group.relay);
  const name = meta?.name || group.groupId;
  const iconUrl = sanitizeImageSrc(meta?.picture) ?? sanitizeImageSrc(relayInfo?.icon);

  const doJoin = async () => {
    if (!user) {
      toast({
        title: t({ id: "nip29GroupInviteEmbed.signInTitle", defaultMessage: "Sign in to join" }),
        description: t({ id: "nip29GroupInviteEmbed.signInDescription", defaultMessage: "Create an account or sign in to accept this invite." }),
      });
      return;
    }
    try {
      await join.mutateAsync({ code: group.inviteCode });
      // Joining is the explicit intent that puts the group in the 10009 list (the rail's source).
      updateList({ type: "add-group", ref: { id: group.groupId, relay: group.relay } }).catch(() => undefined);
      setJoined(true);
      toast({
        title: t({ id: "nip29GroupInviteEmbed.requestSentTitle", defaultMessage: "Join request sent" }),
        description: t({ id: "nip29GroupInviteEmbed.requestSentDescription", defaultMessage: "The relay will admit you automatically or after review." }),
      });
      navigate(path);
    } catch (e) {
      toast({ title: t({ id: "nip29GroupInviteEmbed.joinFailed", defaultMessage: "Couldn't join" }), description: relayRejectionMessage(e), variant: "destructive" });
    }
  };

  return (
    <div
      className={cn(
        "block max-w-sm w-full clip-hairline-lg [--edge:var(--border)/0.5] [--fill:var(--secondary)/0.3] [--fill-hover:var(--secondary)/0.3] overflow-hidden my-1.5",
        className,
      )}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="px-3.5 py-3 space-y-2.5">
        <p className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
          {group.inviteCode
            ? intl.formatMessage({ id: "nip29GroupInviteEmbed.invited", defaultMessage: "You've been invited to join a channel" })
            : intl.formatMessage({ id: "nip29GroupInviteEmbed.channel", defaultMessage: "Channel" })}
        </p>

        <div className="flex items-center gap-3 min-w-0">
          <Avatar className="size-11 clip-corner-lg shrink-0">
            {iconUrl && <AvatarImage src={iconUrl} alt={name} className="object-cover" />}
            <AvatarFallback className="clip-corner-lg bg-primary/20 text-primary font-semibold">
              {name.slice(0, 2).toUpperCase() || "??"}
            </AvatarFallback>
          </Avatar>

          <div className="min-w-0 flex-1">
            <p className="font-semibold truncate leading-tight">{name}</p>
            <div className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground min-w-0">
              <Hash className="size-3.5 shrink-0" />
              <span className="truncate">{relayInfo?.name || host}</span>
            </div>
          </div>
        </div>

        {inList || joined ? (
          <Button variant="secondary" className="w-full clip-corner-lg" onClick={() => navigate(path)}>
            <FormattedMessage id="nip29GroupInviteEmbed.open" defaultMessage="Open" />
          </Button>
        ) : (
          <Button className="w-full clip-corner-lg" onClick={doJoin} disabled={join.isPending}>
            {join.isPending
              ? intl.formatMessage({ id: "nip29GroupInviteEmbed.joining", defaultMessage: "Joining…" })
              : intl.formatMessage({ id: "nip29GroupInviteEmbed.join", defaultMessage: "Join" })}
          </Button>
        )}
      </div>
    </div>
  );
}
