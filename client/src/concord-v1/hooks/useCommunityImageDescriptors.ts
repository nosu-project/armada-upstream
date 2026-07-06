import { bytesToHex } from "@noble/hashes/utils.js";
import { useEffect, useMemo, useState } from "react";

import type { Community, CommunityImage } from "@/concord-v1/lib/types";
import type { FoldedMetadata } from "@/concord-v1/lib/control";
import { readFolded, writeFolded } from "@/lib/foldedCache";

/**
 * Disk-backed last-known-good for a Concord community's icon/banner DESCRIPTOR
 * (the encrypted-blob ref: url/key/nonce/hash/ext — NOT the decrypted image
 * bytes, which live in Cache Storage).
 *
 * Why this exists: the authoritative icon descriptor comes from the folded
 * GroupRoot metadata (`useConcordMetadata`), which on reload is `undefined` for
 * the first paint(s) — the fold is deferred past paint and its persisted snapshot
 * is read asynchronously. The invite-bundle `Community.icon` is normally empty,
 * so `folded?.root?.icon ?? community?.icon` is `undefined` on first render and
 * the avatar collapses to its initials/shield fallback until the fold lands.
 *
 * Persisting the small descriptor JSON — and reading it back on mount — closes
 * that window: the descriptor is available once the async read lands (well
 * before the full fold), so the decrypted-image hook (itself seeded from a warm
 * object-URL cache) can paint the icon without waiting for the fold.
 *
 * The descriptors are stored in the shared Concord folded IndexedDB cache
 * (`foldedCache`) rather than localStorage: the count grows with the number of
 * communities, and unbounded caches belong in IndexedDB, not localStorage.
 */

const ICON_KEY = (communityId: string) => `concord-icon:${communityId}`;
const BANNER_KEY = (communityId: string) => `concord-banner:${communityId}`;

/**
 * Resolve a community's icon + banner descriptors with a disk-backed fallback so
 * they appear shortly after reload (no lasting flicker).
 *
 * Preference: the live folded GroupRoot metadata (authoritative, owner-controlled)
 * → the invite-bundle descriptor → the persisted last-known-good. Whenever the
 * authoritative descriptor resolves, it's written back so the next reload seeds
 * from it.
 */
export function useCommunityImageDescriptors(
  community: Community | undefined,
  folded: FoldedMetadata | undefined,
): { icon: CommunityImage | undefined; banner: CommunityImage | undefined } {
  const communityId = community ? bytesToHex(community.id) : undefined;

  // Authoritative (when the fold has landed), else invite bundle.
  const liveIcon = folded?.root?.icon ?? community?.icon;
  const liveBanner = folded?.root?.banner ?? community?.banner;

  // The persisted last-known-good, read asynchronously from IndexedDB on mount.
  const [cached, setCached] = useState<{ icon?: CommunityImage; banner?: CommunityImage }>({});
  useEffect(() => {
    let cancelled = false;
    if (!communityId) {
      setCached({});
      return;
    }
    void Promise.all([
      readFolded<CommunityImage>(ICON_KEY(communityId)),
      readFolded<CommunityImage>(BANNER_KEY(communityId)),
    ]).then(([icon, banner]) => {
      if (!cancelled) setCached({ icon, banner });
    });
    return () => {
      cancelled = true;
    };
  }, [communityId]);

  // Persist the authoritative descriptor as last-known-good once the fold lands.
  // We only write when the FOLD has resolved (`folded` defined), so a not-yet-
  // folded render can't clobber a good cached descriptor with the (usually empty)
  // invite-bundle value.
  useEffect(() => {
    if (!communityId || !folded) return;
    const icon = folded.root?.icon ?? community?.icon;
    const banner = folded.root?.banner ?? community?.banner;
    void writeFolded(ICON_KEY(communityId), icon ?? null);
    void writeFolded(BANNER_KEY(communityId), banner ?? null);
  }, [communityId, folded, community?.icon, community?.banner]);

  return useMemo(
    () => ({
      icon: liveIcon ?? cached.icon,
      banner: liveBanner ?? cached.banner,
    }),
    [liveIcon, liveBanner, cached],
  );
}
