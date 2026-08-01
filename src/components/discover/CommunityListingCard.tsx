import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Check, ShieldCheck } from "lucide-react";
import { useMemo } from "react";
import { useNavigate } from "react-router-dom";

import { DisplayName } from "@/components/DisplayName";
import { ProfilePreviewCard } from "@/components/chat/ProfilePreviewCard";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { resolveBundle } from "@/concord-v2/hooks/useCommunityActions2";
import { useCommunityEntry2 } from "@/concord-v2/hooks/useCommunityList2";
import { useDecryptedImage2 } from "@/concord-v2/hooks/useDecryptedImage2";
import {
  inviteSourceBlurb,
  inviteUrlToLocalRoute,
  type DiscoveredInvite,
} from "@/concord-v2/lib/inviteDiscovery";
import { parseInviteLink } from "@/concord-v2/lib/invite";
import { useAuthor } from "@/hooks/useAuthor";
import { getAvatarShape } from "@/lib/avatarShape";
import { getDisplayName } from "@/lib/getDisplayName";
import { cn } from "@/lib/utils";

interface CommunityListingCardProps {
  invite: DiscoveredInvite;
  className?: string;
}

/**
 * A public Concord community discovered from a shared invite link, rendered as a
 * card: the resolved community name (fetched from the invite bundle using the
 * link's own secret), the person who shared it, their note blurb, and a Join
 * button that routes to the invite (which resolves + joins, prompting sign-in).
 */
export function CommunityListingCard({ invite, className }: CommunityListingCardProps) {
  const navigate = useNavigate();
  const { nostr } = useNostr();
  const parsed = useMemo(() => parseInviteLink(invite.inviteUrl), [invite.inviteUrl]);
  const author = useAuthor(invite.source.pubkey);
  const metadata = author.data?.metadata;
  const displayName = getDisplayName(metadata, invite.source.pubkey);
  const blurb = useMemo(() => inviteSourceBlurb(invite.source), [invite.source]);

  // Resolve the community name from its bundle (the link carries the secret, so
  // we can decrypt the preview). Best-effort: a revoked/unreachable link falls
  // back to a generic name rather than hiding the card.
  const { data: bundle } = useQuery({
    queryKey: ["discover", "invite-bundle", invite.linkSigner],
    enabled: !!parsed,
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: () => resolveBundle(nostr, parsed!, parsed!.bootstrapRelays),
  });

  const iconUrl = useDecryptedImage2(bundle?.icon);
  const bannerUrl = useDecryptedImage2(bundle?.banner);
  const name = bundle?.name?.trim() || invite.name || "Encrypted community";
  const initial = name.charAt(0).toUpperCase() || "·";
  const channelCount = Array.isArray(bundle?.channels) ? bundle!.channels.length : 0;

  const memberEntry = useCommunityEntry2(bundle?.community_id);
  const isMember = !!memberEntry;

  const onJoin = () => navigate(inviteUrlToLocalRoute(invite.inviteUrl));
  const onOpen = () => navigate(`/c/${encodeURIComponent(bundle!.community_id)}`);

  return (
    <div
      className={cn(
        "flex flex-col w-full rounded-xl border border-border/60 bg-card overflow-hidden",
        className,
      )}
    >
      {/* Banner (from the bundle preview, decrypted with the link's secret).
          Absent on older bundles or bannerless communities — the card simply
          starts at the header row. */}
      {bannerUrl && (
        <div className="h-24 w-full shrink-0 overflow-hidden">
          <img src={bannerUrl} alt="" className="size-full object-cover" />
        </div>
      )}
      <div className="px-3.5 py-3 flex flex-col flex-1 gap-2.5">
        {/* Header: icon + name */}
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted text-success">
            {iconUrl ? (
              <img src={iconUrl} alt="" className="size-full object-cover" />
            ) : (
              <span className="text-sm font-semibold">{initial}</span>
            )}
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-semibold truncate leading-tight">{name}</p>
            <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <ShieldCheck className="size-3 shrink-0" />
              Encrypted community
              {channelCount > 0 && ` · ${channelCount} channel${channelCount === 1 ? "" : "s"}`}
            </span>
          </div>
        </div>

        {blurb && <p className="text-sm text-muted-foreground line-clamp-3">{blurb}</p>}

        {/* Who shared it */}
        <ProfilePreviewCard pubkey={invite.source.pubkey}>
          <button
            type="button"
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground min-w-0"
          >
            <Avatar shape={getAvatarShape(metadata)} className="size-4 shrink-0">
              <AvatarImage src={metadata?.picture} alt={displayName} />
              <AvatarFallback className="bg-primary/20 text-primary text-[8px]">
                {displayName[0]?.toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <span className="truncate">
              shared by <DisplayName pubkey={invite.source.pubkey} name={displayName} />
            </span>
          </button>
        </ProfilePreviewCard>

        {isMember ? (
          <Button variant="secondary" className="mt-auto w-full clip-corner-lg" onClick={onOpen}>
            <Check className="size-4" />
            Joined — Open
          </Button>
        ) : (
          <Button className="mt-auto w-full clip-corner-lg" onClick={onJoin}>
            Join
            <ArrowRight className="size-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
