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
import { MigrationDeferredError, skipLegacyDrain } from "@/lib/db/legacyDatabases";

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
 *
 * REJECTS when the copy fails OR when it cannot yet be attempted. The startup
 * gate deletes the legacy database once every drain has resolved for every
 * account, and this is the drain guarding the least replaceable data in the
 * app — a member's own device is frequently the last copy of a community's
 * history. Resolving without having copied would be indistinguishable from
 * having copied, and the gate would delete it.
 */
export function migrateLegacyRumors(self: string): Promise<void> {
  let drain = drains.get(self);
  if (!drain) {
    drain = drainLegacyRumors(self).catch((err: unknown) => {
      // Retry on the next call rather than leaving a rejected promise cached.
      drains.delete(self);
      throw err;
    });
    drains.set(self, drain);
  }
  return drain;
}

async function drainLegacyRumors(self: string): Promise<void> {
  const db = getArmadaDB();
  if (await db.kv.get<boolean>(doneKey(self))) return;
  if (typeof indexedDB === "undefined") return;
  // `NIndexedDB` CREATES the database on its first query, which would leave a
  // device that never had one with the very database the startup gate scans
  // for. See `skipLegacyDrain`.
  if (await skipLegacyDrain(LEGACY_RUMOR_DB_NAME)) return;

  const communities = await viewerCommunities(self);
  const legacy = new NIndexedDB(LEGACY_RUMOR_DB_NAME, { indexTags: legacyIndexTags });

  try {
    // A cached list that is EMPTY is an answer: this account has no live
    // communities, so no row in the store is attributable to it (and any row
    // that is there belongs to a community it left, whose secrets are gone —
    // undecryptable either way). NO cached list is not an answer: the profile
    // may simply never have read it this install.
    if (communities === undefined) {
      // Deferring costs a second gate appearance next launch, once a Concord
      // read has cached the list. Not deferring costs the history itself, so
      // the check is worth one query: defer only if there is anything to lose.
      const any = await legacy.query([{ limit: 1 }]);
      if (any.length > 0) {
        throw new MigrationDeferredError(`no cached community list for ${self.slice(0, 8)}`);
      }
    } else {
      for (const community of communities) {
        await drainCommunity(legacy, community);
      }
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
 *
 * `undefined` when there is no cached list at all, which the caller must not
 * confuse with an empty one — the first says nothing about what the account
 * owns, the second says it owns nothing.
 */
async function viewerCommunities(self: string): Promise<CommunityV2[] | undefined> {
  const persisted = await readFolded<PersistedCommunityList>(communityListFoldKey(self));
  if (!persisted?.list) return undefined;

  const out: CommunityV2[] = [];
  for (const entry of liveEntries(persisted.list)) {
    const community = rehydrateCommunity(entry);
    if (community) out.push(community);
  }
  return out;
}
