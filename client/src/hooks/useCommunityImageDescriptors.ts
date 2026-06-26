import { bytesToHex } from "@noble/hashes/utils.js";
import { useEffect, useMemo } from "react";

import type { Community, CommunityImage } from "@/lib/concord/types";
import type { FoldedMetadata } from "@/lib/concord/control";

/**
 * Synchronous, disk-backed last-known-good for a Concord community's icon/banner
 * DESCRIPTOR (the encrypted-blob ref: url/key/nonce/hash/ext — NOT the decrypted
 * image bytes, which live in Cache Storage).
 *
 * Why this exists: the authoritative icon descriptor comes from the folded
 * GroupRoot metadata (`useConcordMetadata`), which on reload is `undefined` for
 * the first paint(s) — the fold is deferred past paint and its persisted snapshot
 * is read asynchronously. The invite-bundle `Community.icon` is normally empty,
 * so `folded?.root?.icon ?? community?.icon` is `undefined` on first render and
 * the avatar collapses to its initials/shield fallback until the fold lands.
 *
 * Persisting just the small descriptor JSON to localStorage — and seeding it
 * SYNCHRONOUSLY on mount, mirroring `useRelayInfo`'s `initialData` — closes that
 * window: the descriptor is available on the first frame, so the decrypted-image
 * hook (which is itself seeded from a warm object-URL cache) can paint the icon
 * immediately on reload instead of flickering.
 */

const ICON_PREFIX = "armada:concord-icon:";
const BANNER_PREFIX = "armada:concord-banner:";

function read(prefix: string, communityId: string | undefined): CommunityImage | undefined {
  if (!communityId) return undefined;
  try {
    const raw = localStorage.getItem(prefix + communityId);
    return raw ? (JSON.parse(raw) as CommunityImage) : undefined;
  } catch {
    return undefined;
  }
}

function write(prefix: string, communityId: string, image: CommunityImage | undefined): void {
  try {
    const cur = localStorage.getItem(prefix + communityId);
    if (image) {
      const next = JSON.stringify(image);
      if (cur !== next) localStorage.setItem(prefix + communityId, next);
    } else if (cur !== null) {
      // The owner cleared the icon/banner — drop the stale seed.
      localStorage.removeItem(prefix + communityId);
    }
  } catch {
    // localStorage full / unavailable — non-fatal, we just lose the seed.
  }
}

/**
 * Resolve a community's icon + banner descriptors with a synchronous, disk-backed
 * fallback so they're present on the first frame after reload (no flicker).
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

  // Persist the authoritative descriptor as last-known-good once the fold lands.
  // We only write when the FOLD has resolved (`folded` defined), so a not-yet-
  // folded render can't clobber a good cached descriptor with the (usually empty)
  // invite-bundle value.
  useEffect(() => {
    if (!communityId || !folded) return;
    write(ICON_PREFIX, communityId, folded.root?.icon ?? community?.icon);
    write(BANNER_PREFIX, communityId, folded.root?.banner ?? community?.banner);
  }, [communityId, folded, community?.icon, community?.banner]);

  return useMemo(
    () => ({
      icon: liveIcon ?? read(ICON_PREFIX, communityId),
      banner: liveBanner ?? read(BANNER_PREFIX, communityId),
    }),
    // `liveIcon`/`liveBanner` identity drives recompute; read() is a cheap sync
    // localStorage hit used only as the fallback when the live value is absent.
    [communityId, liveIcon, liveBanner],
  );
}
