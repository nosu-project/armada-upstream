import { useNostr } from "@nostrify/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Check, Copy, Loader2, MoreHorizontal, ShieldCheck, Skull, Trash2 } from "lucide-react";
import { Fragment, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { DisplayName } from "@/components/DisplayName";
import { ProfilePreviewCard } from "@/components/chat/ProfilePreviewCard";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { readCachedBundle, resolveBundle } from "@/concord/hooks/useCommunityActions";
import { useCommunity, useCommunityEntry } from "@/concord/hooks/useCommunityList";
import { probeCommunityDissolved, useControlFold } from "@/concord/hooks/useControlPlane";
import { useUnlistAnnouncements } from "@/concord/hooks/useDiscoverListings";
import { useDecryptedImage } from "@/concord/hooks/useDecryptedImage";
import {
  discoverStreamAuthors,
  type DiscoverActivityTarget,
} from "@/concord/lib/discoverActivity";
import {
  enqueueDiscoverControlPeek,
  peekDiscoverControl,
  readCachedControlPeek,
} from "@/concord/lib/discoverControlPeek";
import {
  inviteUrlToLocalRoute,
  type DiscoveredInvite,
} from "@/concord/lib/inviteDiscovery";
import { parseInviteLink } from "@/concord/lib/invite";
import { useAuthor } from "@/hooks/useAuthor";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { toast } from "@/hooks/useToast";
import { getAvatarShape } from "@/lib/avatarShape";
import { writeClipboardText } from "@/lib/clipboard";
import { shortTimeAgo } from "@/lib/formatTime";
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
  /**
   * Reports the stream-author probe target for the batched Discover last-active
   * REQ (guestbook / control / vended private channels, plus public channels
   * when this viewer is a member and holds the Control fold), or `null` to
   * withdraw it when this card stops being listed.
   */
  onActivityTarget?: (linkSigner: string, target: DiscoverActivityTarget | null) => void;
  /** Newest kind-1059 wrap `created_at` (unix seconds) from the batched probe. */
  lastActiveAt?: number;
}

/**
 * What "Active" actually measures, for the reader who reasonably assumes it
 * means chat. The probe is the newest wrap across the stream addresses this
 * invite can derive — which is every channel for a member, but for a listing
 * is the guestbook and Control planes plus whatever channels the bundle vends
 * or the Control peek turned up. So it is community activity, not message
 * activity, and a community whose channels are all private still registers.
 */
const ACTIVITY_HINT =
  "Newest activity on the streams this invite can see — channel messages, join requests and admin changes.";

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
export function CommunityListingCard({
  invite,
  className,
  filter,
  onResolved,
  onActivityTarget,
  lastActiveAt,
}: CommunityListingCardProps) {
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

  // A dissolved community is not a listing. Its links keep resolving — the
  // grave touches no link coordinate — so the bundle alone would list it
  // forever. The dissolved address derives from the community_id, so a
  // non-member can check it too; the probes batch per relay across the grid.
  const { data: dissolvedAtMs, isPending: dissolvedPending } = useQuery({
    queryKey: ["discover", "dissolved", bundle?.community_id],
    enabled: !!bundle?.community_id && !!bundle.owner,
    staleTime: 10 * 60_000,
    retry: false,
    queryFn: async () =>
      (await probeCommunityDissolved(nostr, {
        communityId: bundle!.community_id,
        owner: bundle!.owner,
        relays: Array.isArray(bundle!.relays) ? bundle!.relays : [],
      })) ?? null,
  });
  const dissolved = dissolvedAtMs != null;
  // Held as a skeleton until the check answers, so a dissolved community's
  // card never paints and then vanishes. The probe answers within a short
  // budget (and at once for a grave already known), so this is bounded.
  const dissolvedChecking = !!bundle?.community_id && !!bundle.owner && dissolvedPending;

  // The listing's own author may take it down. Only theirs: a NIP-09 delete
  // counts from an event's author alone, so nobody else is offered one.
  const { user } = useCurrentUser();
  const isAuthor = !!user && user.pubkey === invite.source.pubkey;
  const { unlistLinks } = useUnlistAnnouncements();
  const [removing, setRemoving] = useState(false);

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

  // A Control peek is a whole plane read plus its decrypt, and the queue below
  // runs them one at a time — so a card that has never been scrolled to must
  // not hold a card that has. Latched: scrolling away mid-peek doesn't cancel
  // it, and scrolling back doesn't ask again.
  const [cardEl, setCardEl] = useState<HTMLDivElement | null>(null);
  const onScreen = useSeenOnScreen(cardEl);

  // Background Control peek for non-members: channel count + public channel
  // ids for last-active. Serialized globally so the grid does one community
  // at a time; members already hold the fold and skip this.
  const controlPeekKey = ["discover", "control-peek", bundle?.community_id] as const;
  const { data: controlPeek } = useQuery({
    queryKey: controlPeekKey,
    enabled: !!bundle && !isMember && !!bundle.community_id && onScreen,
    staleTime: 10 * 60_000,
    retry: false,
    queryFn: ({ signal }) =>
      enqueueDiscoverControlPeek(() => peekDiscoverControl(nostr, bundle!, signal)),
  });

  // Same warm-seed pattern as invite bundles / the Discover directory: last
  // session's peek paints channel count immediately; seeded STALE so the
  // live peek above still refreshes.
  useEffect(() => {
    if (!bundle?.community_id || isMember || !onScreen) return;
    let cancelled = false;
    void (async () => {
      const cached = await readCachedControlPeek(bundle.community_id);
      if (cancelled || !cached) return;
      if (queryClient.getQueryData(controlPeekKey) !== undefined) return;
      queryClient.setQueryData(controlPeekKey, cached, { updatedAt: 0 });
    })();
    return () => {
      cancelled = true;
    };
    // controlPeekKey's community_id is what matters; the array identity is stable per id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bundle?.community_id, isMember, onScreen, queryClient]);

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
  // The fold is authoritative, the peek is the non-member's version of it, and
  // the bundle's vended channels are the floor both fall back to — a member
  // waiting on their fold showed a count before this probe existed and must
  // not now count down to zero while it loads.
  const bundleChannelCount = Array.isArray(bundle?.channels) ? bundle.channels.length : 0;
  const channelCount = folded
    ? [...folded.channels.values()].filter((c) => !c.deleted).length
    : (controlPeek?.channelCount ?? bundleChannelCount);
  const stats: Array<{ key: string; text: string; hint?: string }> = [];
  if (channelCount > 0) {
    stats.push({ key: "channels", text: `${channelCount} channel${channelCount === 1 ? "" : "s"}` });
  }
  if (lastActiveAt != null && lastActiveAt > 0) {
    stats.push({ key: "active", text: `Active ${shortTimeAgo(lastActiveAt)}`, hint: ACTIVITY_HINT });
  }
  const publicChannelIdHexes = useMemo(() => {
    if (folded) {
      return [...folded.channels.values()]
        .filter((c) => !c.deleted && !c.isPrivate)
        .map((c) => c.channelIdHex)
        .sort();
    }
    return controlPeek?.publicChannelIdHexes;
  }, [folded, controlPeek?.publicChannelIdHexes]);

  useEffect(() => {
    if (bundle?.community_id) onResolved?.(invite.linkSigner, bundle.community_id, bundle.owner);
  }, [bundle?.community_id, bundle?.owner, invite.linkSigner, onResolved]);

  // Whether this card is actually in the grid. A listing that resolved and
  // then lost the search, or whose link never resolved at all, renders nothing
  // below — and must stop being probed too, or the REQ keeps asking about
  // communities no one is looking at for as long as the tab is open.
  const needle = filter?.trim().toLowerCase();
  const listed =
    !bundleLoading
    && !bundleError
    && !!parsed
    && !!bundle
    && !dissolvedChecking
    && !dissolved
    && (!needle || name.toLowerCase().includes(needle));
  // A dissolved community stays visible to the one person who can clean the
  // listing up — its author — as a husk with nothing but the remove action.
  const husk =
    dissolved
    && isAuthor
    && !bundleLoading
    && !bundleError
    && !!bundle
    && (!needle || name.toLowerCase().includes(needle));

  // Probe target for the tab-level batched last-active REQ. Public chat
  // stream authors land once the fold (member) or Control peek (listing)
  // knows channel ids. The cleanup withdraws it: on unmount that is the prune,
  // and on a dep change it is batched with the re-report in the same commit.
  useEffect(() => {
    if (!onActivityTarget) return;
    if (!listed || !bundle) {
      onActivityTarget(invite.linkSigner, null);
      return;
    }
    onActivityTarget(invite.linkSigner, {
      linkSigner: invite.linkSigner,
      authors: discoverStreamAuthors(bundle, { publicChannelIdHexes }),
      relays: Array.isArray(bundle.relays) ? bundle.relays : [],
    });
    return () => onActivityTarget(invite.linkSigner, null);
  }, [listed, bundle, publicChannelIdHexes, invite.linkSigner, onActivityTarget]);

  const onJoin = () => navigate(inviteUrlToLocalRoute(invite.inviteUrl));
  const onOpen = () => navigate(`/c/${encodeURIComponent(bundle!.community_id)}`);
  const onRemove = async () => {
    setRemoving(true);
    try {
      // Every copy of this link the viewer announced, not just this one:
      // Discover keeps the newest per link, so an older copy would take its place.
      await unlistLinks([invite.linkSigner], [invite]);
      toast({ title: "Removed from Discover", description: `${name} is no longer listed by you.` });
    } catch (e) {
      toast({
        title: "Couldn't remove the listing",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    } finally {
      setRemoving(false);
    }
  };
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
  if (bundleLoading || dissolvedChecking) return <CommunityListingCardSkeleton className={className} />;

  // A link that doesn't resolve (revoked, expired, dead relays) is not a
  // joinable community — hide it rather than list a junk placeholder card.
  // This is also what makes revoking a shared link an effective un-listing.
  // `listed` folds in the search miss; `bundle` is re-tested for the narrowing.
  if ((!listed && !husk) || !bundle) return null;

  return (
    <div
      ref={setCardEl}
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
            {/* The shield alone carries "encrypted"; the stats append as their
                background peeks land, without reshaping the row. */}
            <p className="text-[11px] leading-snug text-muted-foreground">
              <ShieldCheck className="mr-1 inline size-3 align-[-0.125em]" />
              {stats.map((stat, i) => (
                <Fragment key={stat.key}>
                  {i > 0 ? " · " : null}
                  <span title={stat.hint}>{stat.text}</span>
                </Fragment>
              ))}
            </p>
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
          {husk ? (
            <Button variant="secondary" className="min-w-0 flex-1 clip-corner-lg" disabled>
              <Skull className="size-4" />
              Dissolved
            </Button>
          ) : isMember ? (
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
          {/* A dissolved community's link leads nowhere worth sharing. */}
          {!husk && (
            <Button
              variant="ghost"
              size="icon"
              className="shrink-0 clip-corner-lg"
              aria-label="Copy invite link"
              onClick={onCopy}
            >
              {copied ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
            </Button>
          )}
          {isAuthor && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="shrink-0 clip-corner-lg"
                  aria-label="Listing options"
                  disabled={removing}
                >
                  {removing ? <Loader2 className="size-4 animate-spin" /> : <MoreHorizontal className="size-4" />}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onSelect={() => void onRemove()}
                >
                  <Trash2 className="mr-2 size-4" />
                  Remove from Discover
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Latches true the first time `el` comes within a screenful of the viewport.
 *
 * Deliberately one-way, like {@link DeferredRow}'s mount gate: the point is to
 * stop a grid of listings from all paying for an off-screen probe at once, not
 * to un-do work when the reader scrolls past. Without an observer at all
 * (jsdom, an old WebView) it reports true, so the gate can only ever delay
 * work, never remove it.
 */
function useSeenOnScreen(el: Element | null): boolean {
  const [seen, setSeen] = useState(false);

  useEffect(() => {
    if (seen) return;
    if (typeof IntersectionObserver === "undefined") {
      setSeen(true);
      return;
    }
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          io.disconnect();
        }
      },
      // A screenful of lead time, so the peek is usually done by the time the
      // card is actually looked at.
      { rootMargin: "300px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [el, seen]);

  return seen;
}
