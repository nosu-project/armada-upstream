/**
 * Discover activity — cheap "last wrap" probes for public Concord listings.
 *
 * A Discover invite unlocks the bundle, so guestbook / control / any vended
 * private-channel stream addresses are derivable without joining. Kind-1059
 * wraps are NOT NIP-17-fuzzed (CORD-01): outer `created_at` is wall-clock, so
 * the newest wrap's timestamp is a real "last active" signal.
 *
 * Public chat streams need channel ids from the Control fold; public link
 * bundles deliberately omit those (CORD-05 — `channels` is private grants
 * only). Callers that already hold a fold can pass public channel ids via
 * {@link discoverStreamAuthors}'s `publicChannelIdHexes`.
 */

import {
  channelGroupKey,
  controlGroupKey,
  guestbookGroupKey,
  hex32,
} from "@/concord/lib/derive";
import type { InviteBundle } from "@/concord/lib/invite";
import { KIND_WRAP } from "@/concord/lib/kinds";
import { normalizeRelayUrl } from "@/lib/platform";

import type { NostrFilter } from "@nostrify/nostrify";

/** One community's probe target for a batched last-wrap REQ. */
export interface DiscoverActivityTarget {
  /** Invite link-signer — the Discover card's stable key. */
  linkSigner: string;
  /** Stream author pubkeys to probe (guestbook, control, channel streams). */
  authors: string[];
  /** Community home relays (where the wraps live). */
  relays: string[];
}

/**
 * Derive the stream author pubkeys a Discover listing can probe from its
 * invite bundle (plus optional public channel ids from a Control fold).
 */
export function discoverStreamAuthors(
  bundle: InviteBundle,
  opts?: { publicChannelIdHexes?: readonly string[] },
): string[] {
  const out = new Set<string>();
  let root: Uint8Array;
  let communityId: Uint8Array;
  try {
    root = hex32(bundle.community_root);
    communityId = hex32(bundle.community_id);
  } catch {
    return [];
  }
  const epoch = bundle.root_epoch;

  try {
    out.add(guestbookGroupKey(root, communityId, epoch).pk);
  } catch {
    // malformed inputs — skip
  }

  if (typeof bundle.control_pk === "string" && /^[0-9a-f]{64}$/i.test(bundle.control_pk)) {
    out.add(bundle.control_pk.toLowerCase());
  } else {
    try {
      // Legacy pre-split: the read key's pk is also the wrap address.
      out.add(controlGroupKey(root, communityId, epoch).pk);
    } catch {
      // skip
    }
  }

  for (const ch of Array.isArray(bundle.channels) ? bundle.channels : []) {
    try {
      out.add(channelGroupKey(hex32(ch.key), hex32(ch.id), ch.epoch).pk);
    } catch {
      // skip malformed channel entries
    }
  }

  for (const idHex of opts?.publicChannelIdHexes ?? []) {
    try {
      out.add(channelGroupKey(root, hex32(idHex), epoch).pk);
    } catch {
      // skip
    }
  }

  return [...out];
}

/** One `limit: 1` filter per target — relays return newest first. */
export function discoverActivityFilters(targets: DiscoverActivityTarget[]): NostrFilter[] {
  return targets
    .filter((t) => t.authors.length > 0)
    .map((t) => ({
      kinds: [KIND_WRAP],
      authors: t.authors,
      limit: 1,
    }));
}

/** De-duplicated, normalized relay URLs across every target. */
export function discoverActivityRelays(targets: DiscoverActivityTarget[]): string[] {
  const urls = new Set<string>();
  for (const t of targets) {
    for (const raw of t.relays) {
      const n = normalizeRelayUrl(raw);
      if (n) urls.add(n);
    }
  }
  return [...urls];
}

/**
 * Map wrap events back to link-signers by stream author. Authors are
 * community-unique derivations, so a pubkey collision across listings is not
 * expected; if it happened, both would share the same timestamp (harmless).
 */
export function activityByLinkSigner(
  targets: DiscoverActivityTarget[],
  events: ReadonlyArray<{ pubkey: string; created_at: number }>,
): Record<string, number> {
  const authorToSigners = new Map<string, string[]>();
  for (const t of targets) {
    for (const pk of t.authors) {
      const list = authorToSigners.get(pk);
      if (list) list.push(t.linkSigner);
      else authorToSigners.set(pk, [t.linkSigner]);
    }
  }
  const out: Record<string, number> = {};
  for (const ev of events) {
    const signers = authorToSigners.get(ev.pubkey);
    if (!signers) continue;
    for (const linkSigner of signers) {
      const prev = out[linkSigner] ?? 0;
      if (ev.created_at > prev) out[linkSigner] = ev.created_at;
    }
  }
  return out;
}
