import { useNostr } from "@nostrify/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Check, Copy, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { DisplayName } from "@/components/DisplayName";
import { ProfilePreviewCard } from "@/components/chat/ProfilePreviewCard";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { readCachedBundle, resolveBundle } from "@/concord/hooks/useCommunityActions";
import { useCommunity, useCommunityEntry } from "@/concord/hooks/useCommunityList";
import { useControlFold } from "@/concord/hooks/useControlPlane";
import { useDecryptedImage } from "@/concord/hooks/useDecryptedImage";
import {
  inviteUrlToLocalRoute,
  type DiscoveredInvite,
} from "@/concord/lib/inviteDiscovery";
import { parseInviteLink } from "@/concord/lib/invite";
import { useAuthor } from "@/hooks/useAuthor";
import { toast } from "@/hooks/useToast";
import { getAvatarShape } from "@/lib/avatarShape";
import { writeClipboardText } from "@/lib/clipboard";
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
   * Reports the bundle's self-certified `community_id` and verified `owner`
   * once the bundle resolves, so the grid can fold two different links to the
   * SAME community into one card and rank listings by who owns them. The
   * announcement carries no community identity of its own — a tag would be an
   * unverifiable claim — so this resolution is the only place either fact
   * becomes knowable.
   */
  onResolved?: (linkSigner: string, communityId: string, owner: string) => void;
}

/** The card-shaped placeholder shown while a listing's bundle resolves. */
export function CommunityListingCardSkeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "flex flex-col w-full rounded-xl border border-border/60 bg-card overflow-hidden",
        className,
      )}
      aria-hidden
    >
      <Skeleton className="aspect-[3/1] w-full rounded-none" />
      <div className="px-3.5 py-3 flex flex-col flex-1 gap-2.5">
        <div className="flex items-center gap-2.5">
          <Skeleton className="size-10 shrink-0 rounded-lg" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        </div>
        <Skeleton className="h-3 w-1/2" />
        <Skeleton className="mt-auto h-9 w-full" />
      </div>
    </div>
  );
}

/**
 * A public Concord community discovered from an announcement, rendered as a
 * card: the resolved banner, icon and name (fetched from the invite bundle
 * using the link's own secret, so they track the community as it changes),
 * the person who shared it, and a Join button that routes to the invite
 * (which resolves + joins, prompting sign-in). Skeleton-shaped until the
 * bundle settles, so no placeholder name ever flashes.
 */
export function CommunityListingCard({ invite, className, filter, onResolved }: CommunityListingCardProps) {
  const navigate = useNavigate();
  const { nostr } = useNostr();
  const parsed = useMemo(() => parseInviteLink(invite.inviteUrl), [invite.inviteUrl]);
  const [copied, setCopied] = useState(false);

  // Resolve the community from its bundle (the link carries the secret, so we
  // can decrypt the preview). The home-relay second hop runs in the
  // background — the card paints the bootstrap copy a full round trip sooner,
  // and a fresher copy (or a revocation) lands via the callback. Joining
  // re-resolves with full blocking semantics on the invite route.
  const queryClient = useQueryClient();
  const { data: bundle, isLoading: bundleLoading, isError: bundleError } = useQuery({
    queryKey: ["discover", "invite-bundle", invite.linkSigner],
    enabled: !!parsed,
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: () =>
      resolveBundle(nostr, parsed!, parsed!.bootstrapRelays, {
        onSecondHop: (result) => {
          const key = ["discover", "invite-bundle", invite.linkSigner];
          if (result.bundle) queryClient.setQueryData(key, result.bundle);
          // A revocation re-runs the resolve, which now trips over the
          // tombstoned floor and errors the query — hiding the card.
          else if (result.revoked) void queryClient.invalidateQueries({ queryKey: key });
        },
      }),
  });

  // Instant warm paint: the persisted newest-copy floor from an earlier
  // resolve renders the card in milliseconds while the live resolve above
  // refreshes it. Seeded STALE (`updatedAt: 0`) so the network fetch still
  // runs — a seeded card is never how a revocation goes unnoticed — and never
  // over a result the network already delivered. A tombstoned/expired floor
  // reads as null, so a known-dead link stays skeleton-then-hidden as before.
  useEffect(() => {
    if (!parsed) return;
    let cancelled = false;
    void (async () => {
      const cached = await readCachedBundle(parsed);
      if (cancelled || !cached) return;
      const key = ["discover", "invite-bundle", invite.linkSigner];
      if (queryClient.getQueryData(key) !== undefined) return;
      queryClient.setQueryData(key, cached, { updatedAt: 0 });
    })();
    return () => {
      cancelled = true;
    };
  }, [parsed, invite.linkSigner, queryClient]);

  // Attribute the community to its OWNER — the bundle's `owner` is verified
  // (the self-certifying community_id must reproduce from it), unlike the
  // announcement's author, who is merely whoever shared it. Fall back to the
  // sharer only when the bundle can't resolve at all.
  const attributedPubkey = bundle?.owner ?? invite.source.pubkey;
  const attributionLabel = bundle?.owner ? "owned by" : "shared by";
  const author = useAuthor(attributedPubkey);
  const metadata = author.data?.metadata;
  const displayName = getDisplayName(metadata, attributedPubkey);

  const memberEntry = useCommunityEntry(bundle?.community_id);
  const isMember = !!memberEntry;

  // A member holds the community's keys, so the AUTHORITATIVE metadata (the
  // control fold — the same name/icon/banner the community page and sidebar
  // render) is available locally. Prefer it over the bundle's preview, which
  // is only as fresh as the link creator's last re-post: for a member, the
  // card then shows the current images no matter what any relay vends. A
  // non-member has no keys and keeps the bundle preview.
  const memberCommunity = useCommunity(memberEntry?.community_id);
  const { data: folded } = useControlFold(memberCommunity);

  const icon = folded?.metadata?.icon ?? bundle?.icon;
  const banner = folded?.metadata?.banner ?? bundle?.banner;
  const iconUrl = useDecryptedImage(icon);
  const bannerUrl = useDecryptedImage(banner);
  const name =
    folded?.metadata?.name?.trim() || bundle?.name?.trim() || "Encrypted community";
  // Like name/icon: a member's authoritative fold wins; a non-member sees the
  // bundle's capped preview copy.
  const description = folded?.metadata?.description?.trim() || bundle?.description?.trim() || "";
  const initial = name.charAt(0).toUpperCase() || "·";
  const channelCount = Array.isArray(bundle?.channels) ? bundle!.channels.length : 0;

  useEffect(() => {
    if (bundle?.community_id) onResolved?.(invite.linkSigner, bundle.community_id, bundle.owner);
  }, [bundle?.community_id, bundle?.owner, invite.linkSigner, onResolved]);

  const onJoin = () => navigate(inviteUrlToLocalRoute(invite.inviteUrl));
  const onOpen = () => navigate(`/c/${encodeURIComponent(bundle!.community_id)}`);
  const onCopy = async () => {
    try {
      await writeClipboardText(invite.inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast({ title: "Copy failed", variant: "destructive" });
    }
  };

  // No real name to show until the bundle settles — hold the card's shape
  // instead of flashing the "Encrypted community" fallback.
  if (bundleLoading) return <CommunityListingCardSkeleton className={className} />;

  // A link that doesn't resolve (revoked, expired, dead relays) is not a
  // joinable community — hide it rather than list a junk placeholder card.
  // This is also what makes revoking a shared link an effective un-listing.
  if (bundleError || !parsed || !bundle) return null;

  const needle = filter?.trim().toLowerCase();
  if (needle && !name.toLowerCase().includes(needle)) return null;

  return (
    <div
      className={cn(
        "flex flex-col w-full rounded-xl border border-border/60 bg-card overflow-hidden",
        className,
      )}
    >
      {/* Banner (from the bundle preview, decrypted with the link's secret),
          at the community sidebar's desktop ratio (240×80 → 3:1). A
          bannerless community still gets the strip: the icon blown up as a
          blurred backdrop, or a faint oversized initial — so the grid keeps
          one rhythm instead of mixing two card heights. For a member the
          strip doubles as an "open" affordance. */}
      {(() => {
        const bannerContent = bannerUrl ? (
          <img src={bannerUrl} alt="" className="size-full object-cover" />
        ) : (
          <>
            {iconUrl ? (
              <img
                src={iconUrl}
                alt=""
                aria-hidden
                className="size-full scale-125 object-cover opacity-50 blur-2xl"
              />
            ) : (
              <span
                aria-hidden
                className="flex size-full items-center justify-center text-7xl font-bold uppercase text-foreground/10"
              >
                {initial}
              </span>
            )}
            {/* The placeholder carries the name as words, like the sidebar's
                title-over-banner treatment. */}
            <span className="absolute inset-0 flex items-center justify-center px-4">
              <span className="min-w-0 truncate text-lg font-bold text-foreground/90 drop-shadow-sm">
                {name}
              </span>
            </span>
          </>
        );
        return isMember ? (
          <button
            type="button"
            onClick={onOpen}
            aria-label={`Open ${name}`}
            className="relative aspect-[3/1] w-full shrink-0 overflow-hidden bg-secondary"
          >
            {bannerContent}
          </button>
        ) : (
          <div className="relative aspect-[3/1] w-full shrink-0 overflow-hidden bg-secondary">
            {bannerContent}
          </div>
        );
      })()}
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
            {isMember ? (
              <button
                type="button"
                onClick={onOpen}
                className="block max-w-full truncate text-left font-semibold leading-tight hover:underline"
              >
                {name}
              </button>
            ) : (
              <p className="font-semibold truncate leading-tight">{name}</p>
            )}
            <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <ShieldCheck className="size-3 shrink-0" />
              Encrypted community
              {channelCount > 0 && ` · ${channelCount} channel${channelCount === 1 ? "" : "s"}`}
            </span>
          </div>
        </div>

        {description && (
          <p className="text-xs text-muted-foreground line-clamp-2 break-words">{description}</p>
        )}

        {/* Whose community it is */}
        <ProfilePreviewCard pubkey={attributedPubkey}>
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
              {attributionLabel} <DisplayName pubkey={attributedPubkey} name={displayName} />
            </span>
          </button>
        </ProfilePreviewCard>

        <div className="mt-auto flex gap-2">
          {isMember ? (
            <Button variant="secondary" className="min-w-0 flex-1 clip-corner-lg" onClick={onOpen}>
              <Check className="size-4" />
              Joined — Open
            </Button>
          ) : (
            <Button className="min-w-0 flex-1 clip-corner-lg" onClick={onJoin}>
              Join
              <ArrowRight className="size-4" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="shrink-0 clip-corner-lg"
            aria-label="Copy invite link"
            onClick={onCopy}
          >
            {copied ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
          </Button>
        </div>
      </div>
    </div>
  );
}
