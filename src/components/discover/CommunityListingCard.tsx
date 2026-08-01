import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Check, ShieldCheck } from "lucide-react";
import { useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";

import { DisplayName } from "@/components/DisplayName";
import { ProfilePreviewCard } from "@/components/chat/ProfilePreviewCard";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { resolveBundle } from "@/concord-v2/hooks/useCommunityActions2";
import { useCommunityEntry2 } from "@/concord-v2/hooks/useCommunityList2";
import { useDecryptedImage2 } from "@/concord-v2/hooks/useDecryptedImage2";
import {
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
  /**
   * A search needle to match against the RESOLVED community name — the
   * announcement itself carries no metadata, so filtering can only happen
   * here, after the bundle decrypts. A non-matching card renders nothing.
   */
  filter?: string;
  /**
   * Reports the bundle's self-certified `community_id` once it resolves, so
   * the grid can fold two different links to the SAME community into one
   * card. The announcement carries no community identity of its own — a tag
   * would be an unverifiable claim — so this resolution is the only place a
   * duplicate becomes knowable.
   */
  onResolved?: (linkSigner: string, communityId: string) => void;
}

/**
 * A public Concord community discovered from an announcement, rendered as a
 * card: the resolved banner, icon and name (fetched from the invite bundle
 * using the link's own secret, so they track the community as it changes),
 * the person who shared it, and a Join button that routes to the invite
 * (which resolves + joins, prompting sign-in).
 */
export function CommunityListingCard({ invite, className, filter, onResolved }: CommunityListingCardProps) {
  const navigate = useNavigate();
  const { nostr } = useNostr();
  const parsed = useMemo(() => parseInviteLink(invite.inviteUrl), [invite.inviteUrl]);
  const author = useAuthor(invite.source.pubkey);
  const metadata = author.data?.metadata;
  const displayName = getDisplayName(metadata, invite.source.pubkey);

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
  const name = bundle?.name?.trim() || "Encrypted community";
  const initial = name.charAt(0).toUpperCase() || "·";
  const channelCount = Array.isArray(bundle?.channels) ? bundle!.channels.length : 0;

  const memberEntry = useCommunityEntry2(bundle?.community_id);
  const isMember = !!memberEntry;

  useEffect(() => {
    if (bundle?.community_id) onResolved?.(invite.linkSigner, bundle.community_id);
  }, [bundle?.community_id, invite.linkSigner, onResolved]);

  const onJoin = () => navigate(inviteUrlToLocalRoute(invite.inviteUrl));
  const onOpen = () => navigate(`/c/${encodeURIComponent(bundle!.community_id)}`);

  const needle = filter?.trim().toLowerCase();
  if (needle && !name.toLowerCase().includes(needle)) return null;

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
