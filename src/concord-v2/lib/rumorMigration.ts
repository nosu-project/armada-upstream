/**
 * Drain of the pre-ArmadaDB Concord V2 opened-event store into the
 * per-community ArmadaDB tenants that replaced it.
 *
 * The old store was ONE database (`armada-concord-rumors`) holding every
 * community's decrypted planes, queried by `#channel` / `#stream` tags. The new
 * layout is one tenant per community, so the migration's whole problem is
 * ATTRIBUTION: which community does a given stored row belong to?
 *
 * Nothing in the row answers that. A rumor carries its channel id and its
 * stream address, both of which are HKDF/SHA-256 outputs of community secrets
 * (CORD-01 §A) — one-way, so neither can be turned back into a community id.
 * The mapping only exists on the other side: derive a community's addresses
 * from its own key material and see which rows match.
 *
 * That key material is already on disk, decrypted, for exactly this account:
 *
 *   - the community list, cached under {@link communityListFoldKey} — every
 *     joined community's secrets, so `rehydrateCommunity` reconstitutes the
 *     full `CommunityV2` with no signer and no relay;
 *   - each community's control fold, cached under {@link controlFoldKey} —
 *     the channel definitions, so `channelsView` yields the chat channels.
 *
 * From those, {@link mirrorGroups} enumerates every non-chat plane address
 * (control, guestbook, dissolution, rekey) across all held epochs, and the
 * channels supply the chat channel ids plus their per-epoch stream addresses.
 * A row matching any of them is claimed by that community.
 *
 * Rows matching NOTHING are left behind and eventually deleted with the
 * database: they belong to a community this account has left (its secrets are
 * gone from the list, so the rows are undecryptable anyway) or to a channel
 * removed from the fold. Nothing readable is dropped.
 *
 * Copy-forward rather than drop-and-refetch, because a refetch is not
 * equivalent. The sync cursors live in a different database and would still
 * read "already ingested", so dropped history would not come back on its own —
 * and even after resetting them, only what the community's relays still retain
 * would return. A member's own device is frequently the last copy.
 */
import { NIndexedDB } from "@nostrify/indexeddb";

import { channelsView } from "@/concord-v2/lib/community";
import {
  communityListFoldKey,
  liveEntries,
  rehydrateCommunity,
  type PersistedCommunityList,
} from "@/concord-v2/lib/communityList";
import { controlFoldKey } from "@/concord-v2/lib/control";
import { mirrorGroups } from "@/concord-v2/lib/relayMirror";
import { communityTenant, LEGACY_RUMOR_DB_NAME } from "@/concord-v2/lib/rumorStore";
import { readFolded } from "@/lib/foldedCache";
import { getArmadaDB } from "@/lib/db/armadaDB";

import type { NostrFilter } from "@nostrify/nostrify";
import type { FoldedControl } from "@/concord-v2/lib/control";
import type { CommunityV2 } from "@/concord-v2/lib/types";

/** Per-viewer flag, so a second account still drains its own share. */
const doneKey = (self: string) => `c2rumors:migrated:${self}`;

/**
 * Rows copied per query. The legacy store has no cursor API, so each address
 * batch is one `limit`-bounded read; this is high enough that a normal
 * community drains in a couple of passes and low enough not to hold the whole
 * store in memory.
 */
const COPY_LIMIT = 5000;

/** Addresses per filter, keeping any single legacy query's index scan bounded. */
const ADDRESSES_PER_FILTER = 200;

/** In-flight drains by viewer, so concurrent callers share one pass. */
const drains = new Map<string, Promise<void>>();

/**
 * Copy `self`'s communities' rows out of the legacy store. Idempotent and
 * memoised: once the flag is set this costs a single KV read.
 */
export function migrateLegacyRumors(self: string): Promise<void> {
  let drain = drains.get(self);
  if (!drain) {
    drain = drainLegacyRumors(self).catch(() => {
      // Retry on the next call rather than leaving a rejected promise cached.
      drains.delete(self);
    });
    drains.set(self, drain);
  }
  return drain;
}

async function drainLegacyRumors(self: string): Promise<void> {
  const db = getArmadaDB();
  if (await db.kv.get<boolean>(doneKey(self))) return;
  if (typeof indexedDB === "undefined") return;

  const communities = await viewerCommunities(self);
  // No cached list is not the same as no communities: it may be a cold profile
  // whose list has never been read. Leave the flag unset so a later launch,
  // once the list is cached, still gets a pass.
  if (communities.length === 0) return;

  const legacy = new NIndexedDB(LEGACY_RUMOR_DB_NAME, { indexTags: legacyIndexTags });

  try {
    for (const community of communities) {
      await drainCommunity(legacy, community);
    }
  } finally {
    await legacy.close().catch(() => undefined);
  }

  await db.kv.set(doneKey(self), true);
}

/** The legacy store's queryable multi-letter tags (see the old `rumorStore`). */
const QUERYABLE_TAGS = new Set(["channel", "stream", "e", "q", "p", "k"]);

/**
 * The legacy store's write-time tag-index policy, reproduced exactly.
 *
 * It has to match: `NIndexedDB` indexes on write, so the `#channel` / `#stream`
 * filters the drain issues can only match rows the OLD policy indexed. Opening
 * the database with a wider policy does not retroactively index anything —
 * it would just read back nothing and silently migrate an empty store.
 *
 * Exported so anything reconstructing a legacy store (the tests) is forced
 * through the same policy rather than the default single-letter one.
 */
export function legacyIndexTags(event: { tags: string[][] }): string[][] {
  return event.tags.filter(
    ([name, value]) =>
      typeof name === "string" &&
      typeof value === "string" &&
      value.length > 0 &&
      value.length < 200 &&
      name !== "seal" &&
      (name.length === 1 || QUERYABLE_TAGS.has(name)),
  );
}

/** Copy every row addressed to one community into its tenant. */
async function drainCommunity(legacy: NIndexedDB, community: CommunityV2): Promise<void> {
  const folded = await readFolded<FoldedControl>(controlFoldKey(community.idHex));
  const channels = channelsView(community, folded);

  const channelIds = channels.map((c) => c.idHex);
  const streamPks = [
    // Non-chat planes: control, guestbook, dissolution, rekey — every held epoch.
    ...mirrorGroups(community).map((g) => g.pk),
    // Chat, across every held epoch, plus the voice coordinates that ride the
    // same channel.
    ...channels.flatMap((c) => [
      ...c.streams.map((s) => s.group.pk),
      // The call room address, in case any voice-plane rumor was persisted.
      c.voice.room.pk,
    ]),
  ];

  const tenant = getArmadaDB().tenant(communityTenant(community.idHex));

  // `#channel` and `#stream` are both index-backed in the legacy store, so each
  // of these is an index scan rather than a table walk. A row can match both
  // (a chat rumor carries a channel binding AND a stream address); writing it
  // twice is harmless, the tenant keys by rumor id.
  for (const filter of tagFilters("#channel", channelIds)) {
    await copyMatching(legacy, tenant, filter);
  }
  for (const filter of tagFilters("#stream", streamPks)) {
    await copyMatching(legacy, tenant, filter);
  }
}

/** Chunked single-tag filters, so one query never names thousands of values. */
function tagFilters(tag: "#channel" | "#stream", values: string[]): NostrFilter[] {
  const unique = [...new Set(values.filter(Boolean))];
  const out: NostrFilter[] = [];
  for (let i = 0; i < unique.length; i += ADDRESSES_PER_FILTER) {
    out.push({ [tag]: unique.slice(i, i + ADDRESSES_PER_FILTER), limit: COPY_LIMIT } as NostrFilter);
  }
  return out;
}

/**
 * Copy one filter's matches, paging older with `until` until a page adds
 * nothing new. Rows are written to the tenant VERBATIM — same id, same tags,
 * same provenance — so the reconstructed `OpenedEvent`s are identical and no
 * seal has to be re-parsed or re-derived.
 */
async function copyMatching(
  legacy: NIndexedDB,
  tenant: { event(rumor: { id: string; sig?: string }): Promise<void> },
  filter: NostrFilter,
): Promise<void> {
  let until: number | undefined;
  const seen = new Set<string>();

  for (;;) {
    const page = await legacy.query([until === undefined ? filter : { ...filter, until }]);
    const fresh = page.filter((ev) => !seen.has(ev.id));
    if (fresh.length === 0) return;

    for (const event of fresh) {
      seen.add(event.id);
      // The legacy store round-trips a placeholder `sig: ""`; the tenant stores
      // rumors and has no such field.
      const { sig: _sig, ...rumor } = event;
      await tenant.event(rumor);
    }

    if (page.length < COPY_LIMIT) return;
    until = Math.min(...page.map((ev) => ev.created_at));
  }
}

/**
 * `self`'s joined communities, rehydrated from the locally cached list. No
 * signer and no network: the cached list is already decrypted.
 */
async function viewerCommunities(self: string): Promise<CommunityV2[]> {
  const persisted = await readFolded<PersistedCommunityList>(communityListFoldKey(self));
  if (!persisted?.list) return [];

  const out: CommunityV2[] = [];
  for (const entry of liveEntries(persisted.list)) {
    const community = rehydrateCommunity(entry);
    if (community) out.push(community);
  }
  return out;
}
