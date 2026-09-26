import { useNostr } from "@nostrify/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import { useControlFold } from "@/concord/hooks/useControlPlane";
import {
  KIND_COMMUNITY_ANNOUNCEMENT,
  announcementFromEvent,
  announcementsForLinks,
  buildAnnouncementDeletion,
  type DiscoveredInvite,
} from "@/concord/lib/inviteDiscovery";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { forgetDiscoverAnnouncements, useDiscoverRelays } from "@/hooks/useDiscover";
import { useNostrPublish } from "@/hooks/useNostrPublish";
import { queryExplicitRelaysWithStatus } from "@/lib/nip65";

import type { Community } from "@/concord/lib/types";
import type { NostrFilter } from "@nostrify/nostrify";

/**
 * Discover listings by LINK rather than by community. A kind-3314
 * announcement carries nothing but an invite URL, so the only thing that ties
 * it to a community is the link signer inside it — and a community's link
 * signers are exactly what its invite registry (vsk 8) and the creator's own
 * Invite List name. These helpers find the announcements carrying a given set
 * of links, and delete the viewer's own.
 */

/** How many announcements one read asks each relay for, per filter. */
const LISTING_READ_LIMIT = 500;
/** Announcement ids per deletion filter (`#e`), to keep each REQ a sane size. */
const DELETION_ID_CHUNK = 200;
/** Each read's own deadline — the deletions read never inherits what the listings read left. */
const READ_TIMEOUT_MS = 8000;

/** No Discover relay answered a read, so an empty result would be a guess. */
export class DiscoverUnansweredError extends Error {}

function readSignal(outer: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(READ_TIMEOUT_MS);
  return outer ? AbortSignal.any([outer, timeout]) : timeout;
}

/**
 * Every standing announcement on the Discover relays whose link is one of
 * `linkSigners`, newest first, deletions by each announcement's own author
 * honored.
 *
 * An announcement carries nothing but its URL — no tag names its link or its
 * community — so the only thing a relay can narrow a listing read by is its
 * AUTHOR. `authors` does that: the people who can hold these links (the
 * viewer's own listings, or a community's link creators), read deep rather
 * than as whatever of theirs survives in the network-wide newest page.
 * `includeRecent` adds that newest page back beside it, for listings shared by
 * someone outside `authors`; without `authors` it is the only read.
 *
 * Deletions are read in a SECOND round, by `#e` of exactly the announcements
 * found (and by their authors, since only an author's delete counts), so an
 * old delete of an old listing is never missed for being older than the
 * newest page of every Discover deletion.
 *
 * Each read has its own deadline, and each reports whether any relay answered
 * (EOSE) — a pool read turns an outage or an abort into an empty answer, which
 * here would mean "not listed". So:
 *
 * - The LISTINGS read throws {@link DiscoverUnansweredError} when no relay
 *   answered: "no listing" must never be concluded from silence.
 * - The DELETIONS read throws too under `strict` (the unlist path, which must
 *   not report a take-down it could not check). Otherwise the listings are
 *   returned as standing: for a display, over-reporting a listing that may
 *   already be deleted is the safe direction — hiding a live one would tell an
 *   owner their community is off Discover while it isn't — and the next
 *   refetch corrects it.
 */
export async function fetchLinkAnnouncements(
  nostr: Parameters<typeof queryExplicitRelaysWithStatus>[0],
  relays: string[],
  linkSigners: ReadonlySet<string>,
  opts?: { authors?: string[]; includeRecent?: boolean; signal?: AbortSignal; strict?: boolean },
): Promise<DiscoveredInvite[]> {
  if (relays.length === 0 || linkSigners.size === 0) return [];
  const authors = opts?.authors ? [...new Set(opts.authors)] : undefined;
  if (authors && authors.length === 0 && !opts?.includeRecent) return [];
  const listingFilters: NostrFilter[] = [];
  if (authors && authors.length > 0) {
    listingFilters.push({ kinds: [KIND_COMMUNITY_ANNOUNCEMENT], authors, limit: LISTING_READ_LIMIT });
  }
  if (!authors || opts?.includeRecent) {
    listingFilters.push({ kinds: [KIND_COMMUNITY_ANNOUNCEMENT], limit: LISTING_READ_LIMIT });
  }
  const listingRead = await queryExplicitRelaysWithStatus(nostr, relays, listingFilters, readSignal(opts?.signal));
  if (listingRead.answered.length === 0) throw new DiscoverUnansweredError("No Discover relay answered.");
  const listings = listingRead.events.filter(
    (e) => e.kind === KIND_COMMUNITY_ANNOUNCEMENT && linkSigners.has(announcementFromEvent(e)?.linkSigner ?? ""),
  );
  if (listings.length === 0) return [];

  const ids = [...new Set(listings.map((e) => e.id))];
  const listingAuthors = [...new Set(listings.map((e) => e.pubkey))];
  const deletionFilters: NostrFilter[] = [];
  for (let i = 0; i < ids.length; i += DELETION_ID_CHUNK) {
    deletionFilters.push({ kinds: [5], authors: listingAuthors, "#e": ids.slice(i, i + DELETION_ID_CHUNK) });
  }
  const deletionRead = await queryExplicitRelaysWithStatus(nostr, relays, deletionFilters, readSignal(opts?.signal));
  if (deletionRead.answered.length === 0 && opts?.strict) {
    throw new DiscoverUnansweredError("No Discover relay answered the deletions read.");
  }
  return announcementsForLinks([...listings, ...deletionRead.events], linkSigners);
}

/**
 * The Discover listings carrying any of `linkSigners`: read deep for
 * `authors` (who can hold the links), plus the recent page for anyone else.
 * Empty signers answer empty without a read — a private community has no
 * links, so nothing can list it.
 */
export function useLinkAnnouncements(linkSigners: readonly string[], authors: readonly string[] = []) {
  const { nostr } = useNostr();
  const relays = useDiscoverRelays();
  const sorted = useMemo(() => [...new Set(linkSigners)].sort(), [linkSigners]);
  const sortedAuthors = useMemo(() => [...new Set(authors)].sort(), [authors]);

  return useQuery({
    queryKey: ["discover", "link-announcements", relays, sorted, sortedAuthors],
    enabled: relays.length > 0 && sorted.length > 0,
    staleTime: 30_000,
    queryFn: ({ signal }) =>
      fetchLinkAnnouncements(nostr, relays, new Set(sorted), {
        authors: sortedAuthors,
        includeRecent: true,
        signal,
      }),
  });
}

/**
 * This community's Discover listings: every standing announcement carrying one
 * of its live links. The links are the community's invite registry — every
 * creator's live link signers, the same set its Public flag is folded from —
 * plus `extraSigners` (the viewer's own links, which their Invite List knows
 * about before a registry edition lands). `creatorOf` names the member whose
 * link each listing carries: only they can revoke it.
 */
export function useCommunityDiscoverListings(
  community: Community | undefined,
  extraSigners: Iterable<string> = [],
) {
  const { data: folded } = useControlFold(community);
  const { user } = useCurrentUser();
  const extra = [...extraSigners].sort().join(",");
  const { signers, creatorOf, authors } = useMemo(() => {
    const creatorOf = new Map<string, string>();
    for (const [creator, linkSigners] of folded?.registriesByCreator ?? []) {
      for (const signer of linkSigners) creatorOf.set(signer, creator);
    }
    const signers = new Set(creatorOf.keys());
    for (const signer of extra ? extra.split(",") : []) signers.add(signer);
    // The link creators (and the viewer, whose extra links the registry may
    // not name yet) are who most plausibly announced them: read their
    // listings deep rather than only what the network-wide page still holds.
    const authors = new Set(creatorOf.values());
    if (user) authors.add(user.pubkey);
    return { signers: [...signers], creatorOf, authors: [...authors] };
  }, [folded, extra, user]);
  const query = useLinkAnnouncements(signers, authors);
  return { ...query, listings: query.data ?? [], creatorOf };
}

/**
 * Take the viewer's OWN Discover listings down (NIP-09). A deletion only
 * counts from an announcement's own author, so anything else passed in is
 * dropped rather than published as a delete that nobody would honor.
 *
 * `unlistLinks` is the by-link form: it re-reads every copy of those links the
 * viewer ever announced before deleting, because Discover keeps the NEWEST
 * announcement per link — delete only the copy on screen and an older one of
 * the same link takes its place. That read is strict: it throws unless a
 * Discover relay answered both rounds, so an offline take-down fails (and a
 * pending retirement stays recorded) instead of resolving 0.
 */
export function useUnlistAnnouncements() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const relays = useDiscoverRelays();
  const queryClient = useQueryClient();
  const { mutateAsync: publishEvent } = useNostrPublish();

  const unlist = useCallback(
    async (announcements: DiscoveredInvite[]): Promise<number> => {
      if (!user) throw new Error("Sign in to remove a listing.");
      const ids = [...new Set(announcements.filter((a) => a.source.pubkey === user.pubkey).map((a) => a.source.id))];
      if (ids.length === 0) return 0;
      await publishEvent(buildAnnouncementDeletion(ids));
      await forgetDiscoverAnnouncements(queryClient, ids);
      void queryClient.invalidateQueries({ queryKey: ["discover", "my-announcements"] });
      void queryClient.invalidateQueries({ queryKey: ["discover", "link-announcements"] });
      return ids.length;
    },
    [user, publishEvent, queryClient],
  );

  const unlistLinks = useCallback(
    async (linkSigners: Iterable<string>, alsoKnown: DiscoveredInvite[] = []): Promise<number> => {
      if (!user) throw new Error("Sign in to remove a listing.");
      const signers = new Set(linkSigners);
      const found = await fetchLinkAnnouncements(nostr, relays, signers, { authors: [user.pubkey], strict: true });
      return unlist([...found, ...alsoKnown]);
    },
    [nostr, relays, user, unlist],
  );

  const mutation = useMutation<number, Error, DiscoveredInvite[]>({ mutationFn: unlist });

  return {
    unlist: mutation.mutateAsync,
    isUnlisting: mutation.isPending,
    unlistLinks,
  };
}
