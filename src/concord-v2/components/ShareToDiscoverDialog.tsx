import { useQueryClient } from "@tanstack/react-query";
import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, AlertTriangle, Loader2, Megaphone } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ArmadaCrest, ArmadaCrestKeyframes } from "@/components/brand/ArmadaCrest";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, ChromeDialogContent } from "@/components/ui/dialog";
import { useControlFold2 } from "@/concord-v2/hooks/useControlPlane2";
import { useCommunity2, useLiveCommunities2 } from "@/concord-v2/hooks/useCommunityList2";
import { useDecryptedImage2 } from "@/concord-v2/hooks/useDecryptedImage2";
import { useInviteActions2 } from "@/concord-v2/hooks/useInvites2";
import {
  KIND_COMMUNITY_ANNOUNCEMENT,
  buildCommunityAnnouncement,
  extractInviteUrls,
} from "@/concord-v2/lib/inviteDiscovery";
import { parseInviteLink } from "@/concord-v2/lib/invite";
import { badgeOf } from "@/concord-v2/lib/roles";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useDiscoverRelays } from "@/hooks/useDiscover";
import { useNostrPublish } from "@/hooks/useNostrPublish";
import { toast } from "@/hooks/useToast";

import type { ImagePointer } from "@/concord-v2/lib/types";

/**
 * Share a community to Discover: publish a kind-33302 community announcement
 * carrying a live invite link (secret included), so the Discover page can list
 * it. Only communities the user OWNS or ADMINS are offered — the picker checks
 * each community's Control fold and hides the rest. Opened either from the
 * Discover page ("Add your community", with the picker) or from a community's
 * own menu (preselected via `communityId`).
 */
export function ShareToDiscoverDialog({
  open,
  onOpenChange,
  communityId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Preselect this community and skip the picker (the community-page entry). */
  communityId?: string;
}) {
  const [selectedId, setSelectedId] = useState<string | undefined>(communityId);

  // Re-open starts fresh: back to the preselect (or the picker).
  useEffect(() => {
    if (open) setSelectedId(communityId);
  }, [open, communityId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <ChromeDialogContent title="Share to Discover">
        <div className="flex flex-col items-center gap-6">
          <div className="flex flex-col items-center gap-3 text-center">
            <ArmadaCrest size={72} />
            <div className="space-y-1">
              <h2 className="chrome-dialog-title font-mono font-bold lowercase tracking-tight text-foreground">
                share to discover
              </h2>
              <p className="text-sm text-muted-foreground">
                List a community publicly so anyone browsing Discover can find and join it.
              </p>
            </div>
          </div>
          {selectedId ? (
            <ShareForm idHex={selectedId} onDone={() => onOpenChange(false)} />
          ) : (
            <CommunityPicker onSelect={setSelectedId} />
          )}
        </div>
        <ArmadaCrestKeyframes />
      </ChromeDialogContent>
    </Dialog>
  );
}

/** Whether this member may list the community: its owner, or an admin. */
function useCanShare(idHex: string | undefined) {
  const { user } = useCurrentUser();
  const community = useCommunity2(idHex);
  const fold = useControlFold2(community);
  const folded = fold.data;
  const eligible = Boolean(
    user &&
      folded &&
      (user.pubkey === folded.ownerHex || badgeOf(folded.roster, user.pubkey) === "admin"),
  );
  return { community, folded, eligible, isLoading: fold.isLoading };
}

function OptionIcon({
  icon,
  name,
  className = "size-8",
}: {
  icon: ImagePointer | undefined;
  name: string | undefined;
  className?: string;
}) {
  const url = useDecryptedImage2(icon);
  if (url) return <img src={url} alt="" className={`${className} shrink-0 rounded object-cover`} />;
  return (
    <span
      className={`${className} flex shrink-0 items-center justify-center rounded bg-muted text-sm font-semibold uppercase text-muted-foreground`}
    >
      {name?.trim()?.[0] ?? "#"}
    </span>
  );
}

/**
 * One pickable community. Renders nothing until its Control fold proves the
 * viewer owns or admins it — the ineligible majority silently disappears —
 * and reports its verdict up so the picker can tell "still checking" from
 * "nothing to offer".
 */
function CommunityOption({
  idHex,
  onSelect,
  onEligibility,
}: {
  idHex: string;
  onSelect: (idHex: string) => void;
  onEligibility: (idHex: string, eligible: boolean) => void;
}) {
  const { community, folded, eligible, isLoading } = useCanShare(idHex);

  useEffect(() => {
    if (isLoading) return;
    onEligibility(idHex, eligible);
  }, [isLoading, eligible, idHex, onEligibility]);

  if (!eligible) return null;
  const name = folded?.metadata?.name ?? community?.name ?? "…";
  return (
    <button
      type="button"
      onClick={() => onSelect(idHex)}
      className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors clip-corner-lg hover:bg-foreground/10"
    >
      <OptionIcon icon={folded?.metadata?.icon} name={name} />
      <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
    </button>
  );
}

function CommunityPicker({ onSelect }: { onSelect: (idHex: string) => void }) {
  const entries = useLiveCommunities2();
  const [eligibility, setEligibility] = useState<Record<string, boolean>>({});
  const report = useCallback(
    (idHex: string, eligible: boolean) =>
      setEligibility((prev) => (prev[idHex] === eligible ? prev : { ...prev, [idHex]: eligible })),
    [],
  );

  const allChecked = entries.every((e) => e.community_id in eligibility);
  const noneEligible =
    entries.length === 0 || (allChecked && entries.every((e) => !eligibility[e.community_id]));

  return (
    <div className="w-full space-y-2">
      <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        <Megaphone className="size-3.5" />
        Pick a community you own or admin
      </div>
      <div className="max-h-64 space-y-0.5 overflow-y-auto p-1 clip-corner-lg bg-secondary">
        {entries.map((e) => (
          <CommunityOption
            key={e.community_id}
            idHex={e.community_id}
            onSelect={onSelect}
            onEligibility={report}
          />
        ))}
        {!allChecked && (
          <div className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Checking your communities…
          </div>
        )}
        {noneEligible && allChecked && (
          <p className="px-3 py-2 text-sm text-muted-foreground">
            None of your communities can be shared: only a community's owner or an admin can list
            it here.
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * MY current Discover listings of this community: kind-3314 announcements I
 * authored whose invite link is one of MY links for it. These are what
 * "Unpublish" can delete — a NIP-09 delete only works on one's own events, so
 * another sharer's listing is theirs to remove.
 */
function useMyAnnouncements(idHex: string, myLinkSigners: string[]) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const relays = useDiscoverRelays();
  const signers = useMemo(() => new Set(myLinkSigners), [myLinkSigners]);

  return useQuery({
    queryKey: ["discover", "my-announcements", user?.pubkey, idHex, [...signers].sort()],
    enabled: Boolean(user) && relays.length > 0,
    staleTime: 30_000,
    queryFn: async ({ signal }) => {
      const events = await nostr.group(relays).query(
        [{ kinds: [KIND_COMMUNITY_ANNOUNCEMENT], authors: [user!.pubkey], limit: 100 }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) },
      );
      return events.filter((e) => {
        const [url] = extractInviteUrls(e.content);
        const signer = url ? parseInviteLink(url)?.linkSigner : undefined;
        return !!signer && signers.has(signer);
      });
    },
  });
}

function ShareForm({ idHex, onDone }: { idHex: string; onDone: () => void }) {
  const { community, folded, eligible, isLoading } = useCanShare(idHex);
  const { createLink, myLinks, isPublic, refreshMyLinks, linksLoading } = useInviteActions2(community);
  const { mutateAsync: publishEvent } = useNostrPublish();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const name = folded?.metadata?.name ?? community?.name ?? "this community";

  // Reuse a live link of mine rather than minting one per share: repeat
  // shares of one link fold to one listing, and one public link is one
  // revocation away from un-listing.
  const now = Math.floor(Date.now() / 1000);
  const reusable = myLinks.find((e) => !e.expires_at || e.expires_at > now);
  const willMint = !reusable;

  const myLinkSigners = useMemo(
    () =>
      myLinks
        .map((e) => parseInviteLink(e.url)?.linkSigner)
        .filter((s): s is string => !!s),
    [myLinks],
  );
  const myAnnouncements = useMyAnnouncements(idHex, myLinkSigners);
  const listed = (myAnnouncements.data?.length ?? 0) > 0;

  const handleUnpublish = async () => {
    setError(null);
    const targets = myAnnouncements.data ?? [];
    if (targets.length === 0) return;
    setBusy(true);
    try {
      // NIP-09: ask relays to drop MY announcement events. The Discover feed
      // also honors these client-side for relays that keep them.
      await publishEvent({
        kind: 5,
        content: "",
        tags: [...targets.map((e) => ["e", e.id]), ["k", String(KIND_COMMUNITY_ANNOUNCEMENT)]],
      });
      queryClient.invalidateQueries({ queryKey: ["discover", "community-announcements"] });
      queryClient.invalidateQueries({ queryKey: ["discover", "my-announcements"] });
      toast({
        title: "Unpublished from Discover",
        description: `${name} is no longer listed by you.`,
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't unpublish the listing.");
    } finally {
      setBusy(false);
    }
  };

  // Whether this share is the step that makes the community public: it has no
  // live invite link yet, so sharing mints its first one.
  const makesPublic = willMint && !isPublic;

  const handleShare = async () => {
    setError(null);
    if (!community || !eligible) return;
    setBusy(true);
    try {
      let url: string;
      if (reusable) {
        url = reusable.url;
        // The listing shows whatever this link's bundle vends, and a link
        // minted before the community's current name/icon/banner keeps
        // serving the old preview — re-post the CURRENT bundle at its
        // coordinate so the card renders today's community.
        await refreshMyLinks().catch(() => undefined);
      } else {
        url = await createLink({});
      }
      // The announcement is just the link. Name, icon and banner — and even
      // which community it is — are resolved live from the link's bundle by
      // every viewer, so the listing tracks the community as it changes.
      const announcement = buildCommunityAnnouncement({ inviteUrl: url });
      if (!announcement) throw new Error("Couldn't build the listing.");
      await publishEvent(announcement);
      // Drop cached listing previews so the sharer's own Discover tab picks
      // up the just-refreshed bundle instead of a stale decrypt.
      queryClient.invalidateQueries({ queryKey: ["discover", "invite-bundle"] });
      toast({
        title: "Shared to Discover",
        description: `${name} is now publicly listed.`,
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't share the community.");
    } finally {
      setBusy(false);
    }
  };

  // A first listing publishes the link's secret, and possibly mints the
  // community's first link too, so it routes through an in-app confirm.
  // Updating an existing listing just re-posts what is already public.
  const handleShareClick = () => {
    if (!listed) {
      setConfirmOpen(true);
      return;
    }
    void handleShare();
  };

  if (!eligible) {
    return isLoading ? (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Checking permissions…
      </div>
    ) : (
      <Alert>
        <AlertDescription>
          Only this community's owner or an admin can share it to Discover.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="w-full space-y-3">
      {/* Which community am I about to make public? Show it, don't tell it. */}
      <div className="flex items-center gap-3 px-3 py-2.5 clip-corner-lg bg-secondary">
        <OptionIcon icon={folded?.metadata?.icon} name={name} className="size-10" />
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium leading-tight">{name}</p>
          <p className="text-xs text-muted-foreground">
            {listed ? "is listed publicly on Discover" : "will be listed publicly on Discover"}
          </p>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        Its name and images come from the community itself, so the listing stays current as they
        change.
      </p>
      {/* The consequence is shown up front, before the click, when this share
          would mint the community's first invite link. */}
      {!listed && makesPublic && (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertTitle>Invite links make communities public</AlertTitle>
          <AlertDescription>
            Anyone who gets the link can read every message sent up to this point in the
            community's public channels.
          </AlertDescription>
        </Alert>
      )}
      {!listed && (
        <Alert>
          <AlertDescription>
            Sharing publishes an invite link from your account, including its secret, so anyone
            can find and join.
          </AlertDescription>
        </Alert>
      )}
      <Button
        type="button"
        onClick={handleShareClick}
        // Also parked while the Invite List loads: `reusable` is blind until
        // then, and sharing early would mint a needless duplicate link.
        disabled={busy || linksLoading || myAnnouncements.isLoading}
        variant={listed ? "secondary" : "default"}
        className="w-full clip-corner-lg"
      >
        {busy ? (
          <>
            <Loader2 className="mr-2 size-4 animate-spin" /> Working…
          </>
        ) : listed ? (
          "Update listing"
        ) : (
          "Share publicly"
        )}
      </Button>
      {listed && (
        <Button
          type="button"
          variant="ghost"
          onClick={handleUnpublish}
          disabled={busy}
          className="w-full clip-corner-lg text-destructive hover:text-destructive"
        >
          Unpublish from Discover
        </Button>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {makesPublic
                ? "Are you sure you want to make this community\u00A0public?"
                : "Share this community to Discover?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              The listing publishes the invite link, including its secret, from your account, so
              anyone can find and join.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleShare()}>
              {makesPublic ? "Make Room Public and Share" : "Share Publicly"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
