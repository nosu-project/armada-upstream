import { Braces, Check, Copy, Globe, Link as LinkIcon, Loader2, Lock, Megaphone, TriangleAlert } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useControlFold } from "@/concord/hooks/useControlPlane";
import { useCommunityDiscoverListings, useUnlistAnnouncements } from "@/concord/hooks/useDiscoverListings";
import { useInviteActions, useMyLinkEpochs } from "@/concord/hooks/useInvites";
import type { DiscoveredInvite } from "@/concord/lib/inviteDiscovery";
import { parseInviteLink, type InviteListEntry } from "@/concord/lib/invite";
import type { Community } from "@/concord/lib/types";
import { DisplayName } from "@/components/DisplayName";
import { JsonBlock } from "@/components/JsonBlock";
import { useAuthor } from "@/hooks/useAuthor";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { toast } from "@/hooks/useToast";
import { writeClipboardText } from "@/lib/clipboard";

/**
 * Invite-link admin panel (CORD-05): Public/Private status (registry, vsk 8),
 * Discover listings, my links (only the creator holds a link's secrets, so
 * only mine show URLs), and the community registry (who minted how many).
 */
export function InvitesView({ community }: { community: Community }) {
  const { data: folded } = useControlFold(community);
  const {
    myLinks,
    revokeLink,
    isRevoking,
    revokeAllMyLinks,
    isRevokingAll,
    revokeAllWouldPrivatize,
    isPublic,
    revokeWouldPrivatize,
  } = useInviteActions(community);
  const { user } = useCurrentUser();
  const { data: linkEpochs } = useMyLinkEpochs(community);
  const [copied, setCopied] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [revokeAllOpen, setRevokeAllOpen] = useState(false);
  // Live links always carry the CURRENT keys (re-posted on rekey, CORD-05 §2).
  const [inspecting, setInspecting] = useState<InviteListEntry | null>(null);
  const epoch = Number(community.rootEpoch);

  const myLinkSigners = useMemo(() => {
    const set = new Set<string>();
    for (const e of myLinks) {
      const parsed = parseInviteLink(e.url);
      if (parsed) set.add(parsed.linkSigner);
    }
    return set;
  }, [myLinks]);

  // My registry coordinates whose secret this account lacks (lost 13303); only "Revoke all" delists them.
  const orphanCount = useMemo(() => {
    const mine = user ? folded?.registriesByCreator.get(user.pubkey) ?? [] : [];
    return mine.filter((s) => !myLinkSigners.has(s)).length;
  }, [folded, user, myLinkSigners]);

  // creatorHex → live link count; the community-wide source of truth.
  const registry = useMemo(() => {
    const out: Array<{ creator: string; count: number; signers: string[] }> = [];
    if (folded) {
      for (const [creator, signers] of folded.registriesByCreator) {
        if (signers.length > 0) out.push({ creator, count: signers.length, signers });
      }
      out.sort((a, b) => b.count - a.count);
    }
    return out;
  }, [folded]);

  const handleCopy = async (url: string) => {
    try {
      await writeClipboardText(url);
      setCopied(url);
      setTimeout(() => setCopied((c) => (c === url ? null : c)), 1500);
    } catch {
      toast({ title: "Copy failed", variant: "destructive" });
    }
  };

  const handleRevoke = async (url: string) => {
    const privatizes = revokeWouldPrivatize(url);
    if (
      privatizes &&
      !confirm(
        "This is the last live invite link. Revoking it makes the community private: new members can then only be added by direct invite, and banning a member will rotate the community keys.",
      )
    ) {
      return;
    }
    setRevoking(url);
    try {
      await revokeLink({ url });
      toast({
        title: "Invite link revoked",
        description: privatizes
          ? "It can no longer be used to join. This community is now private."
          : "It can no longer be used to join.",
      });
    } catch (e) {
      toast({
        title: "Couldn't revoke the link",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    } finally {
      setRevoking(null);
    }
  };

  const { listings, creatorOf, isLoading: listingsLoading } = useCommunityDiscoverListings(community, myLinkSigners);

  const handleRevokeAll = async () => {
    setRevokeAllOpen(false);
    try {
      const { revoked, delisted, failed } = await revokeAllMyLinks();
      const parts: string[] = [];
      if (revoked > 0) parts.push(`${revoked} revoked`);
      if (delisted > revoked) parts.push(`${delisted - revoked} delisted from the registry`);
      if (failed > 0) parts.push(`${failed} failed. Try revoking ${failed === 1 ? "it" : "them"} individually`);
      toast({
        title: failed > 0 ? "Some invite links couldn't be revoked" : "Invite links revoked",
        description: parts.join(", ") + ".",
        variant: failed > 0 ? "destructive" : undefined,
      });
    } catch (e) {
      toast({
        title: "Couldn't revoke your links",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    }
  };

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6 px-3 py-4">
      <div className="flex items-center gap-2">
        <LinkIcon className="size-5 text-primary" />
        <h2 className="text-lg font-semibold">Invite links</h2>
      </div>

      <section
        className={`flex items-start gap-3 rounded-md px-3 py-3 text-sm ${
          isPublic ? "bg-primary/10" : "bg-foreground/5"
        }`}
      >
        {isPublic ? (
          <Globe className="mt-0.5 size-5 shrink-0 text-primary" />
        ) : (
          <Lock className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0">
          <p className="font-medium">{isPublic ? "This community is public" : "This community is private"}</p>
          <p className="text-muted-foreground">
            {isPublic
              ? "One or more live invite links let anyone with the link join. Revoke every live link to make it private again."
              : "There are no live public invite links. People join only by direct invite."}
          </p>
          {isPublic && listings.length > 0 && (
            <p className="mt-1 flex items-center gap-1.5 font-medium text-primary">
              <Megaphone className="size-3.5 shrink-0" />
              Listed on Discover, so anyone browsing can find and join it.
            </p>
          )}
        </div>
      </section>

      <DiscoverListingsSection
        listings={listings}
        loading={listingsLoading}
        creatorOf={creatorOf}
        myLinks={myLinks}
        myLinkSigners={myLinkSigners}
        revoking={revoking}
        onRevoke={handleRevoke}
      />

      <section className="space-y-2">
        <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Your live links
        </h3>
        {myLinks.length === 0 && orphanCount === 0 && (
          <p className="text-sm text-muted-foreground">
            You haven't created any invite links for this community.
          </p>
        )}
        {myLinks.length > 0 && (
          <ul className="space-y-1.5">
            {myLinks.map((e) => {
              // Undefined while loading or unfetchable: treat as up to date.
              const servedEpoch = linkEpochs?.[e.token];
              const behind = servedEpoch !== undefined && servedEpoch < epoch;
              return (
              <li key={e.token} className="space-y-1 rounded-md bg-foreground/5 px-3 py-2">
                <div className="flex items-center gap-2">
                  <Input
                    readOnly
                    value={e.url}
                    className="min-w-0 font-mono text-3xs"
                    onFocus={(ev) => ev.currentTarget.select()}
                  />
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    className="shrink-0"
                    aria-label="View link details"
                    onClick={() => setInspecting(e)}
                  >
                    <Braces className="size-3.5" />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    className="shrink-0"
                    aria-label="Copy link"
                    onClick={() => handleCopy(e.url)}
                  >
                    {copied === e.url ? (
                      <Check className="size-3.5 text-success" />
                    ) : (
                      <Copy className="size-3.5" />
                    )}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="shrink-0 text-destructive hover:text-destructive"
                    disabled={isRevoking && revoking === e.url}
                    onClick={() => handleRevoke(e.url)}
                  >
                    {revoking === e.url ? <Loader2 className="size-3.5 animate-spin" /> : "Revoke"}
                  </Button>
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-2xs text-muted-foreground">
                  <span
                    className="tabular-nums"
                    title="The community epoch this link's keys belong to. It advances each time the community rekeys."
                  >
                    Epoch {servedEpoch ?? epoch}
                  </span>
                  {e.label && <span>Label: {e.label}</span>}
                  <span>Created {new Date(e.created_at * 1000).toLocaleDateString()}</span>
                  {e.expires_at ? (
                    <span className={e.expires_at * 1000 < Date.now() ? "text-destructive" : undefined}>
                      {e.expires_at * 1000 < Date.now() ? "Expired " : "Expires "}
                      {new Date(e.expires_at * 1000).toLocaleDateString()}
                    </span>
                  ) : (
                    <span>Never expires</span>
                  )}
                </div>
                {behind && (
                  <div className="flex items-start gap-1.5 rounded bg-warning/10 px-2 py-1.5 text-2xs text-warning">
                    <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                    <span>
                      This link is on epoch {servedEpoch}, but the community has since moved to epoch{" "}
                      {epoch}. Someone joining now could land on the old keys. It refreshes
                      automatically when you reopen this community from a device that holds it;
                      if it lingers, revoke and mint a fresh link.
                    </span>
                  </div>
                )}
              </li>
              );
            })}
          </ul>
        )}
        {orphanCount > 0 && (
          <div className="flex items-start gap-1.5 rounded-md bg-warning/10 px-3 py-2 text-xs text-warning">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            <span>
              The community registry lists {orphanCount} more invite link
              {orphanCount === 1 ? "" : "s"} of yours whose signing secret{" "}
              {orphanCount === 1 ? "isn't" : "aren't"} on this account (created elsewhere, or the
              synced record was lost), so {orphanCount === 1 ? "it" : "they"} can't be revoked one
              by one. "Revoke all" removes {orphanCount === 1 ? "it" : "them"} from the registry.
            </span>
          </div>
        )}
        {(myLinks.length > 0 || orphanCount > 0) && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="text-destructive hover:text-destructive"
            disabled={isRevokingAll}
            onClick={() => setRevokeAllOpen(true)}
          >
            {isRevokingAll ? (
              <>
                <Loader2 className="size-3.5 animate-spin" /> Revoking…
              </>
            ) : (
              `Revoke all my invite links (${myLinks.length + orphanCount})`
            )}
          </Button>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          All invite links in this community
        </h3>
        <p className="text-xs text-muted-foreground">
          Every member who has live invite links, and how many. Only a link's creator can see
          its URL. This list shows who invited and how many links they hold.
        </p>
        {registry.length === 0 ? (
          <p className="text-sm text-muted-foreground">No live invite links.</p>
        ) : (
          <ul className="space-y-1.5">
            {registry.map((r) => (
              <RegistryRow
                key={r.creator}
                creator={r.creator}
                count={r.count}
                community={community}
                mine={r.signers.some((s) => myLinkSigners.has(s))}
              />
            ))}
          </ul>
        )}
      </section>

      <LinkDetailsDialog
        entry={inspecting}
        servedEpoch={inspecting ? linkEpochs?.[inspecting.token] : undefined}
        currentEpoch={epoch}
        onClose={() => setInspecting(null)}
      />

      <AlertDialog open={revokeAllOpen} onOpenChange={setRevokeAllOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Revoke all {myLinks.length + orphanCount} of your invite links?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Links whose secrets this device holds stop working immediately.
            </AlertDialogDescription>
            {orphanCount > 0 && (
              <AlertDialogDescription>
                {orphanCount} of them {orphanCount === 1 ? "has" : "have"} no signing secret on
                this account, so {orphanCount === 1 ? "it" : "they"} can only be delisted: anyone
                who already has the URL may still join until the community next rotates its keys.
              </AlertDialogDescription>
            )}
            {revokeAllWouldPrivatize() && (
              <AlertDialogDescription>
                These are the last live invite links, so this makes the community private: new
                members can then only be added by direct invite, and banning a member will rotate
                the community keys.
              </AlertDialogDescription>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => void handleRevokeAll()}
            >
              Revoke all
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** Read-only link details with `token` and `signer_sk` REDACTED (they'd let anyone impersonate the link). */
function LinkDetailsDialog({
  entry,
  servedEpoch,
  currentEpoch,
  onClose,
}: {
  entry: InviteListEntry | null;
  servedEpoch: number | undefined;
  currentEpoch: number;
  onClose: () => void;
}) {
  const json = useMemo(() => {
    if (!entry) return "";
    const { token: _token, signer_sk: _sk, ...safe } = entry;
    return JSON.stringify(
      {
        ...safe,
        token: "<redacted>",
        signer_sk: "<redacted>",
        served_epoch: servedEpoch ?? currentEpoch,
        current_epoch: currentEpoch,
      },
      null,
      2,
    );
  }, [entry, servedEpoch, currentEpoch]);

  return (
    <Dialog open={entry !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Invite link details</DialogTitle>
          <DialogDescription>
            The stored record for this link. Secrets are redacted.
          </DialogDescription>
        </DialogHeader>
        <JsonBlock json={json} />
      </DialogContent>
    </Dialog>
  );
}

function RegistryRow({
  creator,
  count,
  community,
  mine,
}: {
  creator: string;
  count: number;
  community: Community;
  mine: boolean;
}) {
  const author = useAuthor(creator);
  const name = useScopedDisplayName(creator, author.data?.metadata);
  const isOwner = creator === community.owner;
  return (
    <li className="flex items-center gap-2.5 rounded-md bg-foreground/5 px-3 py-2 text-sm">
      <Avatar className="size-6 shrink-0">
        <AvatarImage src={author.data?.metadata?.picture} imeta={author.data?.imeta?.picture} alt={name} />
        <AvatarFallback className="bg-primary/20 text-3xs text-primary">
          {name[0]?.toUpperCase() ?? "?"}
        </AvatarFallback>
      </Avatar>
      <span className="min-w-0 flex-1 truncate font-medium">
        <DisplayName pubkey={creator} name={name} />
      </span>
      {isOwner && (
        <Badge variant="secondary" className="px-1.5 py-0 text-3xs">
          Owner
        </Badge>
      )}
      {mine && (
        <Badge variant="outline" className="px-1.5 py-0 text-3xs">
          You
        </Badge>
      )}
      <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
        {count} live link{count === 1 ? "" : "s"}
      </span>
    </li>
  );
}

/**
 * Discover listings of this community's links. Deleting is the AUTHOR's
 * (NIP-09); revoking the link is the CREATOR's and takes down every listing of it.
 */
function DiscoverListingsSection({
  listings,
  loading,
  creatorOf,
  myLinks,
  myLinkSigners,
  revoking,
  onRevoke,
}: {
  listings: DiscoveredInvite[];
  loading: boolean;
  creatorOf: ReadonlyMap<string, string>;
  myLinks: InviteListEntry[];
  myLinkSigners: ReadonlySet<string>;
  revoking: string | null;
  onRevoke: (url: string) => void;
}) {
  const { user } = useCurrentUser();
  const { unlist } = useUnlistAnnouncements();
  const [unlisting, setUnlisting] = useState<string | null>(null);

  // One row per (author, link); deleting must delete every copy.
  const rows = useMemo(() => {
    const byKey = new Map<string, DiscoveredInvite[]>();
    for (const listing of listings) {
      const key = `${listing.source.pubkey}:${listing.linkSigner}`;
      byKey.set(key, [...(byKey.get(key) ?? []), listing]);
    }
    return [...byKey.entries()].map(([key, copies]) => ({ key, copies, newest: copies[0] }));
  }, [listings]);

  const myUrlFor = (linkSigner: string) =>
    myLinks.find((e) => parseInviteLink(e.url)?.linkSigner === linkSigner)?.url;

  const handleUnlist = async (key: string, copies: DiscoveredInvite[]) => {
    setUnlisting(key);
    try {
      await unlist(copies);
      toast({ title: "Removed from Discover" });
    } catch (e) {
      toast({
        title: "Couldn't remove the listing",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    } finally {
      setUnlisting(null);
    }
  };

  return (
    <section className="space-y-2">
      <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        Discover listings
      </h3>
      {loading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> Checking Discover…
        </p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">This community isn't listed on Discover.</p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            Public posts of this community's invite links. Anyone browsing Discover can use them to
            join.
          </p>
          <ul className="space-y-1.5">
            {rows.map(({ key, copies, newest }) => {
              const mine = !!user && newest.source.pubkey === user.pubkey;
              const myUrl = myLinkSigners.has(newest.linkSigner) ? myUrlFor(newest.linkSigner) : undefined;
              return (
                <ListingRow
                  key={key}
                  author={newest.source.pubkey}
                  linkCreator={creatorOf.get(newest.linkSigner)}
                  postedAt={newest.source.created_at}
                  action={
                    mine ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="shrink-0 text-destructive hover:text-destructive"
                        disabled={unlisting === key}
                        onClick={() => void handleUnlist(key, copies)}
                      >
                        {unlisting === key ? <Loader2 className="size-3.5 animate-spin" /> : "Remove"}
                      </Button>
                    ) : myUrl ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="shrink-0 text-destructive hover:text-destructive"
                        disabled={revoking === myUrl}
                        title="The listing carries your link: revoking it takes the listing down."
                        onClick={() => onRevoke(myUrl)}
                      >
                        {revoking === myUrl ? <Loader2 className="size-3.5 animate-spin" /> : "Revoke link"}
                      </Button>
                    ) : null
                  }
                />
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

function ListingRow({
  author,
  linkCreator,
  postedAt,
  action,
}: {
  author: string;
  linkCreator: string | undefined;
  postedAt: number;
  action: ReactNode;
}) {
  const profile = useAuthor(author);
  const name = useScopedDisplayName(author, profile.data?.metadata);
  const creatorProfile = useAuthor(linkCreator && linkCreator !== author ? linkCreator : undefined);
  const creatorName = useScopedDisplayName(linkCreator, creatorProfile.data?.metadata);
  return (
    <li className="flex items-center gap-2.5 rounded-md bg-foreground/5 px-3 py-2 text-sm">
      <Avatar className="size-6 shrink-0">
        <AvatarImage src={profile.data?.metadata?.picture} imeta={profile.data?.imeta?.picture} alt={name} />
        <AvatarFallback className="bg-primary/20 text-3xs text-primary">
          {name[0]?.toUpperCase() ?? "?"}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">
          <DisplayName pubkey={author} name={name} />
        </p>
        <p className="truncate text-2xs text-muted-foreground">
          Posted {new Date(postedAt * 1000).toLocaleDateString()}
          {linkCreator && linkCreator !== author && (
            <>
              {" · "}link by <DisplayName pubkey={linkCreator} name={creatorName} />
            </>
          )}
        </p>
      </div>
      {action}
    </li>
  );
}
