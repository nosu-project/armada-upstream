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

/**
 * One `limit: 1` filter per target — relays return newest first.
 *
 * `until` is not decoration. A wrap's `created_at` is whatever its publisher
 * typed, and a Discover invite hands every link-holder the guestbook stream's
 * SECRET (its group key derives from the bundle's own `community_root`), so
 * any passer-by can post a wrap dated 2038 and pin the listing at "Active
 * now" forever. Bounding the REQ makes the relay skip past the forgery to the
 * newest wrap that is actually in the past — the same bound `planeSync`'s
 * pager applies, and for the same reason.
 */
export function discoverActivityFilters(
  targets: DiscoverActivityTarget[],
  now = nowSeconds(),
): NostrFilter[] {
  return targets
    .filter((t) => t.authors.length > 0)
    .map((t) => ({
      kinds: [KIND_WRAP],
      authors: t.authors,
      until: now,
      limit: 1,
    }));
}

/**
 * Relays commonly cap filters per REQ, and the cap is enforced by rejecting
 * the whole subscription — so an over-wide REQ costs EVERY listing in it its
 * timestamp, not just the ones past the limit.
 */
const MAX_FILTERS_PER_REQ = 20;

/** One REQ: a relay set and the filters to ask it for. */
export interface DiscoverActivityBatch {
  relays: string[];
  filters: NostrFilter[];
}

/**
 * Split targets into REQs grouped by RELAY SET, then chunked.
 *
 * Sending every community's filters to the union of every community's relays
 * would ask each relay about listings it hosts nothing for — N×M authors on
 * the wire to answer N questions, and it tells each operator the whole set of
 * communities this client is looking at. Grouping by relay set keeps a
 * listing's authors on the relays that listing actually names.
 */
export function discoverActivityBatches(
  targets: DiscoverActivityTarget[],
  now = nowSeconds(),
): DiscoverActivityBatch[] {
  const byRelaySet = new Map<string, { relays: string[]; targets: DiscoverActivityTarget[] }>();
  for (const t of targets) {
    if (t.authors.length === 0) continue;
    const relays = [
      ...new Set(t.relays.map(normalizeRelayUrl).filter((u): u is string => !!u)),
    ].sort();
    if (relays.length === 0) continue;
    const key = relays.join("\n");
    const bucket = byRelaySet.get(key);
    if (bucket) bucket.targets.push(t);
    else byRelaySet.set(key, { relays, targets: [t] });
  }

  const out: DiscoverActivityBatch[] = [];
  for (const { relays, targets: group } of byRelaySet.values()) {
    for (let i = 0; i < group.length; i += MAX_FILTERS_PER_REQ) {
      const slice = group.slice(i, i + MAX_FILTERS_PER_REQ);
      out.push({ relays, filters: discoverActivityFilters(slice, now) });
    }
  }
  return out;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Map wrap events back to link-signers by stream author. Authors are
 * community-unique derivations, so a pubkey collision across listings is not
 * expected; if it happened, both would share the same timestamp (harmless).
 */
export function activityByLinkSigner(
  targets: DiscoverActivityTarget[],
  events: ReadonlyArray<{ pubkey: string; created_at: number }>,
  now = nowSeconds(),
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
    // The filter's `until` asked the relay for this, but the answer is not the
    // filter: a relay is free to serve a future-dated wrap anyway, and one is
    // enough to freeze the card at "Active now" (shortTimeAgo reads a negative
    // age as "now"). Re-check rather than trust the REQ.
    if (ev.created_at > now) continue;
    const signers = authorToSigners.get(ev.pubkey);
    if (!signers) continue;
    for (const linkSigner of signers) {
      const prev = out[linkSigner] ?? 0;
      if (ev.created_at > prev) out[linkSigner] = ev.created_at;
    }
  }
  return out;
}
