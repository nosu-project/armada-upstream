/**
 * Concord V2 Community List — CORD-02 §8.
 *
 * A member's memberships sync across devices (and clients) as one kind-13302
 * replaceable event, NIP-44-encrypted to self. Every Community they're in AND
 * every one they've left lives in the document — liveness is DERIVED, never
 * deletion, or merges would depend on gossip order.
 *
 * Per entry, two snapshots solve opposite problems: `seed` holds the EARLIEST
 * epoch ever held (the full-history backfill anchor, only ever moves backward
 * on merge) and `current` the LATEST (instant reconstruction on a fresh
 * device). Tombstones are permanent; the newest of `added_at`/`removed_at`
 * decides liveness, so a re-join legitimately resurrects while a backfill can
 * never re-add a tombstoned id.
 */

import { bytesToHex, hex32, verifyCommunityId } from "@/concord-v2/lib/derive";
import {
  MAX_LIST_MEMBERSHIPS,
  capRelays,
  type CommunityV2,
  type HeldRoot,
  type PrivateChannelKey,
} from "@/concord-v2/lib/types";

/**
 * Join material — the invite bundle's MEMBERSHIP subset (never the icon, never
 * the link fields). Snake_case wire shape; unknown fields are preserved
 * (round-trip discipline, CORD-02 §6). The `held_roots` field is an Armada
 * extension carrying retained prior root epochs so history spanning a
 * Refounding stays readable without a rekey-chain walk.
 */
export interface JoinMaterial {
  community_id: string;
  owner: string;
  owner_salt: string;
  community_root: string;
  root_epoch: number;
  /** The PRIVATE channels held (public ones derive from the root — CORD-03). */
  channels: Array<{ id: string; key: string; epoch: number; name: string }>;
  relays: string[];
  name: string;
  /** Armada extension: retained prior roots `[{epoch, key}]` (current excluded). */
  held_roots?: Array<{ epoch: number; key: string }>;
  /** Armada extension: the npub whose Refounding minted `root_epoch`. */
  refounder?: string;
  [k: string]: unknown;
}

export interface CommunityListEntry {
  community_id: string;
  /** Earliest epoch held — only ever moves BACKWARD on merge. */
  seed: JoinMaterial;
  /** Freshest snapshot — replaced on every Refounding or rename. */
  current: JoinMaterial;
  /** ms; tiebreaks against a tombstone. */
  added_at: number;
  [k: string]: unknown;
}

export interface CommunityTombstone {
  community_id: string;
  /** ms. Permanent — pruning would let a long-offline device resurrect a leave. */
  removed_at: number;
  [k: string]: unknown;
}

export interface CommunityList {
  entries: CommunityListEntry[];
  tombstones: CommunityTombstone[];
  [k: string]: unknown;
}

export const EMPTY_COMMUNITY_LIST: CommunityList = { entries: [], tombstones: [] };

// ── Canonical JSON (the total-order tiebreak) ────────────────────────────────

/** JSON with recursively-sorted object keys — a total order for equal-epoch merges. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

// ── Merge (deterministic, commutative, idempotent) ───────────────────────────

/** Higher epoch wins; tie → lexicographically lowest canonical bytes (CORD-02 §8). */
function freshest(a: JoinMaterial, b: JoinMaterial): JoinMaterial {
  if (a.root_epoch !== b.root_epoch) return a.root_epoch > b.root_epoch ? a : b;
  return canonicalJson(a) <= canonicalJson(b) ? a : b;
}

/** Lower epoch wins; tie → lowest canonical bytes. */
function earliest(a: JoinMaterial, b: JoinMaterial): JoinMaterial {
  if (a.root_epoch !== b.root_epoch) return a.root_epoch < b.root_epoch ? a : b;
  return canonicalJson(a) <= canonicalJson(b) ? a : b;
}

function mergeEntry(x: CommunityListEntry, y: CommunityListEntry): CommunityListEntry {
  return {
    ...x,
    ...y,
    community_id: x.community_id,
    current: freshest(x.current, y.current),
    seed: earliest(x.seed, y.seed),
    // The newest add wins liveness races against a tombstone, so keep the max.
    added_at: Math.max(x.added_at, y.added_at),
  };
}

/**
 * Deterministically merge two Community Lists. Entries and tombstones both
 * stay in the document; nothing is deleted (liveness is derived).
 */
export function mergeCommunityLists(a: CommunityList, b: CommunityList): CommunityList {
  const entries = new Map<string, CommunityListEntry>();
  for (const e of [...a.entries, ...b.entries]) {
    if (!e || typeof e.community_id !== "string") continue;
    const prev = entries.get(e.community_id);
    entries.set(e.community_id, prev ? mergeEntry(prev, e) : e);
  }
  const tombstones = new Map<string, CommunityTombstone>();
  for (const t of [...a.tombstones, ...b.tombstones]) {
    if (!t || typeof t.community_id !== "string") continue;
    const prev = tombstones.get(t.community_id);
    if (!prev || t.removed_at > prev.removed_at) tombstones.set(t.community_id, t);
  }
  return {
    ...a,
    ...b,
    entries: [...entries.values()].sort((x, y) => x.community_id.localeCompare(y.community_id)),
    tombstones: [...tombstones.values()].sort((x, y) => x.community_id.localeCompare(y.community_id)),
  };
}

/** Whether an entry is live: no tombstone, or the add is newer than the removal. */
export function isLive(list: CommunityList, communityId: string): boolean {
  const entry = list.entries.find((e) => e.community_id === communityId);
  if (!entry) return false;
  const tomb = list.tombstones.find((t) => t.community_id === communityId);
  return !tomb || entry.added_at > tomb.removed_at;
}

/** The live entries (memberships), derived. */
export function liveEntries(list: CommunityList): CommunityListEntry[] {
  return list.entries.filter((e) => isLive(list, e.community_id));
}

/** Add/refresh a membership. Pure. */
export function addToList(list: CommunityList, entry: CommunityListEntry): CommunityList {
  return mergeCommunityLists(list, { entries: [entry], tombstones: [] });
}

/** Tombstone a membership (leave/removed). Pure. */
export function removeFromList(list: CommunityList, communityId: string, removedAt: number): CommunityList {
  return mergeCommunityLists(list, { entries: [], tombstones: [{ community_id: communityId, removed_at: removedAt }] });
}

/**
 * Replace a membership's `current` snapshot in place (an authoritative local
 * refresh — e.g. a caught-up Refounding or rename). Bypasses the epoch-keyed
 * `freshest` so a same-epoch update can't silently lose the canonical-bytes
 * tiebreak. Pure.
 */
export function refreshCurrent(list: CommunityList, current: JoinMaterial): CommunityList {
  const idx = list.entries.findIndex((e) => e.community_id === current.community_id);
  if (idx === -1) return list;
  const entries = list.entries.map((e, i) => (i === idx ? { ...e, current } : e));
  return { ...list, entries };
}

/**
 * Enforce the membership cap: the count bounds the common case, the NIP-44
 * byte cap is the law — the caller must ALSO verify the serialized list fits
 * before publishing (CORD-02 §8).
 */
export function assertListBounds(list: CommunityList): void {
  if (liveEntries(list).length > MAX_LIST_MEMBERSHIPS) {
    throw new Error(`the Community List caps at ${MAX_LIST_MEMBERSHIPS} memberships`);
  }
}

// ── Join material ⇄ runtime community ───────────────────────────────────────

/**
 * Rehydrate a runtime {@link CommunityV2} from an entry. Verifies the
 * self-certifying owner commitment (a corrupted entry fails closed).
 *
 * `extraRelays` is unioned into the runtime relay set (community-first) — but
 * note that V2 plane traffic belongs ONLY on the community's own relays:
 * callers must NOT pass the deployment's app/platform relays here. A relay
 * that stores no Concord wraps answers every plane REQ instantly with an empty
 * EOSE, which can win the backfill's page race and starve the real relays
 * (issue #19).
 */
export function rehydrateCommunity(entry: CommunityListEntry, extraRelays: string[] = []): CommunityV2 | undefined {
  const jm = entry.current;
  try {
    if (!verifyCommunityId(jm.community_id, jm.owner, jm.owner_salt)) return undefined;
    const id = hex32(jm.community_id);
    const root = hex32(jm.community_root);
    const rootEpoch = BigInt(jm.root_epoch);

    const heldRoots: HeldRoot[] = [{ epoch: rootEpoch, key: root }];
    for (const hr of jm.held_roots ?? []) {
      try {
        const epoch = BigInt(hr.epoch);
        if (epoch === rootEpoch) continue;
        heldRoots.push({ epoch, key: hex32(hr.key) });
      } catch {
        // skip malformed retained roots
      }
    }
    // Also anchor the seed's root when it's an epoch we don't otherwise hold.
    if (entry.seed && entry.seed.community_root && entry.seed.root_epoch !== jm.root_epoch) {
      try {
        const seedEpoch = BigInt(entry.seed.root_epoch);
        if (!heldRoots.some((r) => r.epoch === seedEpoch)) {
          heldRoots.push({ epoch: seedEpoch, key: hex32(entry.seed.community_root) });
        }
      } catch {
        // skip malformed seed
      }
    }
    heldRoots.sort((a, b) => (a.epoch > b.epoch ? -1 : a.epoch < b.epoch ? 1 : 0));

    const privateChannels: PrivateChannelKey[] = [];
    for (const ch of Array.isArray(jm.channels) ? jm.channels : []) {
      try {
        privateChannels.push({
          id: hex32(ch.id),
          key: hex32(ch.key),
          epoch: BigInt(ch.epoch),
          name: typeof ch.name === "string" ? ch.name : "",
        });
      } catch {
        // skip malformed channel entries
      }
    }

    return {
      id,
      idHex: jm.community_id.toLowerCase(),
      owner: jm.owner.toLowerCase(),
      ownerSalt: hex32(jm.owner_salt),
      root,
      rootEpoch,
      heldRoots,
      privateChannels,
      relays: capRelays([...(Array.isArray(jm.relays) ? jm.relays : []), ...extraRelays]),
      name: typeof jm.name === "string" ? jm.name : "",
      refounder: typeof jm.refounder === "string" && /^[0-9a-f]{64}$/i.test(jm.refounder) ? jm.refounder.toLowerCase() : undefined,
    };
  } catch {
    return undefined;
  }
}

/** Snapshot a runtime community back into join material (for `current`). */
export function toJoinMaterial(c: CommunityV2, opts?: { relays?: string[]; prior?: JoinMaterial }): JoinMaterial {
  const heldRoots = c.heldRoots
    .filter((r) => r.epoch !== c.rootEpoch)
    .map((r) => ({ epoch: Number(r.epoch), key: bytesToHex(r.key) }));
  return {
    // Round-trip unknown fields from the prior snapshot (CORD-02 §6/§8).
    ...(opts?.prior ?? {}),
    community_id: c.idHex,
    owner: c.owner,
    owner_salt: bytesToHex(c.ownerSalt),
    community_root: bytesToHex(c.root),
    root_epoch: Number(c.rootEpoch),
    channels: c.privateChannels.map((ch) => ({
      id: bytesToHex(ch.id),
      key: bytesToHex(ch.key),
      epoch: Number(ch.epoch),
      name: ch.name,
    })),
    relays: opts?.relays ?? (opts?.prior?.relays as string[] | undefined) ?? [],
    name: c.name,
    ...(heldRoots.length > 0 ? { held_roots: heldRoots } : {}),
    ...(c.refounder ? { refounder: c.refounder } : {}),
  };
}
