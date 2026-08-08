/**
 * Drain of the pre-ArmadaDB Concord opened-event store into the
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
 *     full `Community` with no signer and no relay;
 *   - each community's control fold, cached and vetted by {@link readControlFold} —
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
 *
 * ## The row is not copied verbatim, and must not be
 *
 * The old store folded four values belonging to the WRAP into the stored
 * event's tags — `stream`, `wrap`, `sealkind` and the whole signed `seal` — and
 * stripped them again on read. The tenant holds the rumor exactly as its author
 * wrote it, so the drain strips them here instead: what is left is byte-identical
 * to the rumor the `id` already commits to. The seal moves to KV, where the
 * current store keeps it; `wrap` is read by nothing and is dropped.
 *
 * `stream` cannot simply be dropped, because it is what the old store told the
 * planes apart BY. Today a plane is read back by KIND ({@link PLANE_RULES}), and
 * that is only sound because {@link writeOpened} refuses, at ingest, a rumor
 * whose kind does not belong to the plane whose keys opened its wrap. The old
 * write path enforced no such thing — it filtered forged provenance and a stray
 * `channel` tag and nothing else — so a legacy store can hold a control-kind
 * rumor that arrived on the guestbook stream, which a verbatim copy would hand
 * to `queryPlane("control")` as an edition. So the drain applies the CURRENT
 * boundary to every row it copies, using the `stream` tag it is about to remove
 * as the proof of which plane the row actually arrived on. Rows that fail it are
 * left behind: they were never readable as that plane, and only the old store's
 * address-keyed reads kept them harmless.
 */
import { NIndexedDB } from "@nostrify/indexeddb";

import { channelsView } from "@/concord/lib/community";
import {
  communityListFoldKey,
  liveEntries,
  rehydrateCommunity,
  type PersistedCommunityList,
} from "@/concord/lib/communityList";
import { controlGroups, readControlFold } from "@/concord/lib/control";
import { dissolvedGroupKey } from "@/concord/lib/derive";
import { guestbookGroups } from "@/concord/lib/guestbook";
import { KIND_SEAL_PLAINTEXT, PLANE_KINDS, PLANE_RULES, type Plane } from "@/concord/lib/kinds";
import { mirrorGroups } from "@/concord/lib/relayMirror";
import {
  communityTenant,
  noteControlSnapshot,
  writeStoredSeal,
} from "@/concord/lib/rumorStore";
import { readFolded } from "@/lib/foldedCache";
import { getArmadaDB } from "@/lib/db/armadaDB";
import { MigrationDeferredError, skipLegacyDrain } from "@/lib/db/legacyDatabases";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";
import type { NostrRumor } from "@/lib/nostrRumor";
import type { Community } from "@/concord/lib/types";

/** The pre-ArmadaDB single-database store this drain reads. */
export const LEGACY_RUMOR_DB_NAME = "armada-concord-rumors";

/** The wrap-derived tags the old store injected, stripped from every copied row. */
const TAG_STREAM = "stream";
const TAG_SEAL = "seal";
const TAG_WRAP = "wrap";
const TAG_SEALKIND = "sealkind";
const TAG_CHANNEL = "channel";
const INJECTED = new Set([TAG_STREAM, TAG_SEAL, TAG_WRAP, TAG_SEALKIND]);

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

/**
 * Which plane each of a community's non-chat stream addresses belongs to.
 *
 * Built from the address families themselves rather than from anything stored,
 * so it says what the community's own keys prove. {@link mirrorGroups} is the
 * full enumeration (and the only one that walks the per-channel rekey epochs
 * under every held root); the two exact families are laid over it, leaving
 * every remaining address a rekey one — which is what mirrorGroups' remainder
 * is. The dissolution address carries control editions (a `vsk`-10 kind-3308),
 * so it is a control address for storage purposes.
 */
function planeByAddress(community: Community): Map<string, Plane> {
  const map = new Map<string, Plane>();
  for (const g of mirrorGroups(community)) map.set(g.pk, "rekey");
  for (const g of guestbookGroups(community)) map.set(g.pk, "guestbook");
  for (const g of controlGroups(community)) map.set(g.pk, "control");
  map.set(dissolvedGroupKey(community.id).pk, "control");
  return map;
}

/** Copy every row addressed to one community into its tenant. */
async function drainCommunity(legacy: NIndexedDB, community: Community): Promise<void> {
  const folded = await readControlFold(community.idHex);
  const channels = channelsView(community, folded);

  const channelIds = channels.map((c) => c.idHex);
  const planes = planeByAddress(community);

  const tenant = getArmadaDB().tenant(communityTenant(community.idHex));
  // Which control rumors arrived on which control address — the one envelope
  // fact that is genuinely not in the rumor, recovered from the `stream` tag
  // before it is stripped (see `readControlSnapshot`).
  const snapshot: Array<{ streamPk: string; rumorId: string }> = [];

  // `#channel` and `#stream` are both index-backed in the legacy store, so each
  // of these is an index scan rather than a table walk. The two passes are
  // disjoint: a chat rumor is claimed by its channel binding, and its stream
  // address is not a non-chat plane address, so it is skipped by the second.
  for (const filter of tagFilters("#channel", channelIds)) {
    await copyMatching(legacy, tenant, filter, (row) => convertChat(row, channelIds));
  }
  for (const filter of tagFilters("#stream", [...planes.keys()])) {
    await copyMatching(legacy, tenant, filter, (row) =>
      convertPlane(row, planes, community.idHex, snapshot),
    );
  }

  if (snapshot.length > 0) {
    await noteControlSnapshot(community.idHex, snapshot);
  }
}

/** The rumor a legacy row was built from: its own tags, none of the injected ones. */
function bareRumor(row: NostrEvent): NostrRumor {
  return {
    id: row.id,
    kind: row.kind,
    content: row.content,
    tags: row.tags.filter((t) => !INJECTED.has(t[0])),
    created_at: row.created_at,
    pubkey: row.pubkey,
  };
}

/** A legacy row's injected value, or undefined. */
function injected(row: NostrEvent, name: string): string | undefined {
  return row.tags.find((t) => t[0] === name)?.[1];
}

/**
 * A chat row, claimed by its channel binding.
 *
 * The binding was proved at decode time (`checkChannelBinding`), and the
 * channel id came out of this community's own control fold, so the row is this
 * community's. The kind is still checked: a rumor of a non-chat plane's kind
 * carrying a `channel` tag would be indexed here and then served by
 * {@link queryPlane} as that plane's — the same refusal {@link writeRumors}
 * applies to every chat rumor on the live path.
 */
function convertChat(row: NostrEvent, channelIds: string[]): NostrRumor | undefined {
  if (PLANE_KINDS.has(row.kind)) return undefined;
  const channel = injected(row, TAG_CHANNEL);
  if (!channel || !channelIds.includes(channel)) return undefined;
  return bareRumor(row);
}

/**
 * A non-chat row, claimed by the address it arrived on, and admitted only if it
 * satisfies the plane boundary this build reads by.
 *
 * The three refusals are {@link writeOpened}'s, applied to data written before
 * anything applied them: the kind must belong to the plane whose keys opened
 * the wrap, under that plane's seal form, carrying no channel binding.
 */
function convertPlane(
  row: NostrEvent,
  planes: Map<string, Plane>,
  communityIdHex: string,
  snapshot: Array<{ streamPk: string; rumorId: string }>,
): NostrRumor | undefined {
  const streamPk = injected(row, TAG_STREAM);
  const plane = streamPk ? planes.get(streamPk) : undefined;
  if (!streamPk || !plane) return undefined;

  const rule = PLANE_RULES[plane];
  if (!rule.kinds.includes(row.kind)) return undefined;
  if (Number(injected(row, TAG_SEALKIND) ?? "0") !== rule.sealKind) return undefined;
  if (row.tags.some((t) => t[0] === TAG_CHANNEL)) return undefined;

  if (plane === "control") snapshot.push({ streamPk, rumorId: row.id });

  // Only plaintext seals are kept — an encrypted one is bound to the old
  // stream's conversation key and could never survive a re-wrap, which is the
  // only thing a stored seal is for.
  if (rule.sealKind === KIND_SEAL_PLAINTEXT) {
    const seal = parseSeal(injected(row, TAG_SEAL));
    if (seal) void writeStoredSeal(communityIdHex, row.id, seal).catch(() => undefined);
  }

  return bareRumor(row);
}

/** The signed seal a legacy row carried, if it carried a usable one. */
function parseSeal(raw: string | undefined): NostrEvent | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return undefined;
    const seal = parsed as NostrEvent;
    return typeof seal.id === "string" && typeof seal.sig === "string" ? seal : undefined;
  } catch {
    return undefined;
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
 * nothing new.
 *
 * `convert` turns a legacy row into the rumor to store, or refuses it (see the
 * boundary note at the top). Refused rows still count as seen, so a page of
 * them pages past rather than looping.
 */
async function copyMatching(
  legacy: NIndexedDB,
  tenant: { event(rumor: NostrRumor): Promise<void> },
  filter: NostrFilter,
  convert: (row: NostrEvent) => NostrRumor | undefined,
): Promise<void> {
  let until: number | undefined;
  const seen = new Set<string>();

  for (;;) {
    const page = await legacy.query([until === undefined ? filter : { ...filter, until }]);
    const fresh = page.filter((ev) => !seen.has(ev.id));
    if (fresh.length === 0) return;

    for (const event of fresh) {
      seen.add(event.id);
      const rumor = convert(event);
      if (rumor) await tenant.event(rumor);
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
async function viewerCommunities(self: string): Promise<Community[] | undefined> {
  const persisted = await readFolded<PersistedCommunityList>(communityListFoldKey(self));
  if (!persisted?.list) return undefined;

  const out: Community[] = [];
  for (const entry of liveEntries(persisted.list)) {
    const community = rehydrateCommunity(entry);
    if (community) out.push(community);
  }
  return out;
}
