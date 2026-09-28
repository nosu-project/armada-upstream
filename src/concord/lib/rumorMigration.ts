/**
 * Drain of the pre-ArmadaDB opened-event store (`armada-concord-rumors`, one DB
 * for all communities) into per-community ArmadaDB tenants.
 *
 * Attribution: channel ids and stream addresses are one-way (CORD-01 §A), so rows
 * are matched against addresses derived from each community's cached key
 * material ({@link communityListFoldKey}, {@link readControlFold},
 * {@link mirrorGroups}). Unmatched rows belong to left communities or removed
 * channels and are dropped with the DB. Copy-forward rather than refetch: cursors
 * would still say "ingested", and the device is often the last copy.
 *
 * Rows aren't copied verbatim: the injected `stream`/`wrap`/`sealkind`/`seal`
 * tags are stripped (seal → KV). Before stripping, `stream` proves which plane
 * the row arrived on, and the CURRENT {@link writeOpened} boundary is applied —
 * the old write path didn't enforce it, and planes are now read by kind
 * ({@link PLANE_RULES}). Rows failing it are left behind.
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

const doneKey = (self: string) => `c2rumors:migrated:${self}`;

/** Rows copied per query (no cursor API); bounded so the store isn't held in memory. */
const COPY_LIMIT = 5000;

/** Addresses per filter, keeping any single legacy query's index scan bounded. */
const ADDRESSES_PER_FILTER = 200;

const drains = new Map<string, Promise<void>>();

/**
 * Copy `self`'s communities' rows out of the legacy store; memoised, flag-gated.
 * REJECTS if the copy fails or can't yet be attempted: the startup gate deletes
 * the legacy DB once every drain resolves, and this may be the last copy.
 */
export function migrateLegacyRumors(self: string): Promise<void> {
  let drain = drains.get(self);
  if (!drain) {
    drain = drainLegacyRumors(self).catch((err: unknown) => {
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
  // `NIndexedDB` creates the database on first query; see `skipLegacyDrain`.
  if (await skipLegacyDrain(LEGACY_RUMOR_DB_NAME)) return;

  const communities = await viewerCommunities(self);
  const legacy = new NIndexedDB(LEGACY_RUMOR_DB_NAME, { indexTags: legacyIndexTags });

  try {
    // An EMPTY cached list means nothing is attributable; NO cached list is unknown.
    if (communities === undefined) {
      // Defer only if the legacy store has anything to lose.
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
 * The legacy store's write-time tag-index policy, reproduced exactly: `NIndexedDB`
 * indexes on write, so a wider policy would silently match nothing. Exported so
 * tests build legacy stores with the same policy.
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
 * Plane of each non-chat stream address, from the address families themselves.
 * {@link mirrorGroups} enumerates all; the exact families overlay it and the
 * remainder is rekey. Dissolution carries control editions (`vsk` 10), so control.
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
  // Control rumor → arrival address, recovered from `stream` before stripping (see `readControlSnapshot`).
  const snapshot: Array<{ streamPk: string; rumorId: string }> = [];

  // Both passes are index scans and disjoint (chat stream addresses aren't plane addresses).
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
 * A chat row, claimed by its (decode-time verified) channel binding. The kind is
 * still checked, as {@link writeRumors} does, so a plane-kind rumor can't be
 * served by {@link queryPlane}.
 */
function convertChat(row: NostrEvent, channelIds: string[]): NostrRumor | undefined {
  if (PLANE_KINDS.has(row.kind)) return undefined;
  const channel = injected(row, TAG_CHANNEL);
  if (!channel || !channelIds.includes(channel)) return undefined;
  return bareRumor(row);
}

/**
 * A non-chat row, claimed by its arrival address and admitted only under
 * {@link writeOpened}'s rules: kind in that plane, its seal form, no channel binding.
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

  // Only plaintext seals are kept; encrypted ones can't survive a re-wrap (their only use).
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
 * Copy one filter's matches, paging older with `until` until a page adds nothing.
 * Refused rows still count as seen so paging advances.
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
 * `self`'s communities, rehydrated from the cached list (no signer/network).
 * `undefined` = no cached list, which is NOT the same as an empty one.
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
