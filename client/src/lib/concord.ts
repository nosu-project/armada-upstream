/**
 * Concord chats — end-to-end-encrypted communities that live alongside, but
 * are deliberately separate from, Armada's relay-trusted NIP-29 servers.
 *
 * The two are apples and oranges:
 *
 *   - A **NIP-29 server** is a relay you connect to. The relay hosts channels,
 *     signs the roster, admits members, and reads every message in plaintext.
 *     "Adding" one is entering a relay URL (see the Add wizard).
 *   - A **Concord chat** is a serverless E2E community with no host. Membership
 *     is key possession; authority is a signed roster every client verifies;
 *     relays only ever store opaque sealed blobs. "Starting" one mints keys;
 *     "joining" one opens a sealed invite the relay can't read.
 *
 * This module is Concord-only. The wire protocol (sealed envelopes, signed
 * roster, epoch rekey, invites) is a large body of cryptography being ported
 * from Vector's `vector-core/community` Rust crate; everything that touches it
 * is stubbed behind {@link ConcordProtocol}. The community model and invite-link
 * parsing around it are real so the protocol can land behind them unchanged.
 *
 * Protocol reference: Vector `crates/vector-core/src/community/` and
 * `docs/concord/README.md`.
 */

import { normalizeRelayUrl } from "@/lib/platform";

// ── Concord community model ─────────────────────────────────────────────────

/**
 * A Concord community as the client knows it. Its identity is a 32-byte
 * community id (hex), not a relay-scoped `d` tag, and it has no host relay that
 * owns it — Concord gathers on several interchangeable relays at once.
 */
export interface ConcordCommunity {
  /** Community id (32-byte hex). The stable, relay-independent identity. */
  communityId: string;
  name: string;
  about?: string;
  /** Relays this community gathers on. Interchangeable; several at once. */
  relays: string[];
}

/** Concord invite links carry their secret in the URL fragment. */
export const CONCORD_INVITE_PATH = "/invite";

// ── Cross-device membership list ────────────────────────────────────────────
//
// Unlike NIP-29 servers (whose membership is re-derivable from the relay and
// tracked in the kind-10009 directory), a Concord community has NO host that
// remembers you joined — and the list entry holds the *keys themselves*. So
// membership rides its own explicit, self-encrypted, replaceable list:
//
//   kind 30078, d = "armada/concord", NIP-44 self-encrypted content, on app
//   relays.
//
// This entry IS the vault: lose it and the keys (hence the room) are gone
// forever. Modelled on Vector's `community/list.rs`.

/** The `d` tag for the Concord membership list (distinct from kind-10009). */
export const CONCORD_LIST_D_TAG = "armada/concord";
/** NIP-78 application-specific kind, shared with armada's other 30078 events. */
export const CONCORD_LIST_KIND = 30078;

/**
 * A community's secret bundle as held in the membership list. This is the
 * material that lets a fresh device read the room — the community/channel keys
 * the protocol layer needs. Opaque to this module; the protocol port defines
 * its real shape (mirrors Vector's `CommunityInvite`). Kept as `unknown`-ish
 * JSON here so the list module can carry it without depending on the crypto.
 */
export interface ConcordKeyBundle {
  communityId: string;
  /** Base epoch this bundle's keys belong to. Drives merge freshness. */
  epoch: number;
  name: string;
  relays: string[];
  /** Channel/community key material — opaque until the protocol layer lands. */
  keys: Record<string, unknown>;
}

/** One community the user belongs to, as stored in the membership list. */
export interface ConcordListEntry {
  communityId: string;
  /**
   * Stable seed bundle (earliest/join). The widest-backfill anchor — kept
   * verbatim so full history stays reachable even as the community rekeys.
   */
  seed: ConcordKeyBundle;
  /**
   * Latest snapshot (current root + channel keys + name). Drives instant
   * rehydration on a fresh device without walking every rekey.
   */
  current: ConcordKeyBundle;
  /** ms timestamp the community was added (join/create). */
  addedAt: number;
}

/**
 * A tombstone for a community the user left or was removed from. Stops a stale
 * device from resurrecting it, and suppresses re-nagging old invites.
 */
export interface ConcordRemoval {
  communityId: string;
  /** ms timestamp of removal. An add newer than this resurrects (re-join). */
  removedAt: number;
}

/** The full membership list: live entries + tombstones. */
export interface ConcordList {
  entries: ConcordListEntry[];
  tombstones: ConcordRemoval[];
}

/** The empty list, before any membership exists. */
export const EMPTY_CONCORD_LIST: ConcordList = { entries: [], tombstones: [] };

/**
 * Canonical JSON for a value, with object keys sorted recursively. Used as the
 * total-order tiebreak in {@link mergeConcordLists} so every device, regardless
 * of merge order, computes byte-identical output for equal-freshness conflicts.
 */
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

/**
 * Deterministically merge two membership lists. Commutative and idempotent —
 * `merge(a, b)` and `merge(b, a)` produce byte-identical output — so every
 * device that has seen the same set of list versions converges to the same
 * state regardless of order. Per community:
 *
 *   - keep the **freshest `current`** (highest epoch; tie → lowest canonical
 *     bytes), so the latest keys win;
 *   - keep the **earliest `seed`** (lowest epoch; tie → lowest canonical
 *     bytes), preserving the widest backfill anchor;
 *   - keep the **newest removal**; an add newer than the removal resurrects the
 *     community (re-join), a removal newer than the add buries it.
 *
 * Output is sorted by community id for stable serialization.
 */
export function mergeConcordLists(a: ConcordList, b: ConcordList): ConcordList {
  // Fold entries per community.
  const entries = new Map<string, ConcordListEntry>();
  for (const e of [...a.entries, ...b.entries]) {
    const prev = entries.get(e.communityId);
    entries.set(e.communityId, prev ? mergeEntry(prev, e) : e);
  }

  // Fold tombstones per community (newest removal wins).
  const tombstones = new Map<string, ConcordRemoval>();
  for (const t of [...a.tombstones, ...b.tombstones]) {
    const prev = tombstones.get(t.communityId);
    if (!prev || t.removedAt > prev.removedAt) tombstones.set(t.communityId, t);
  }

  // Resolve add-vs-remove per community: the newer action wins.
  for (const [id, tomb] of tombstones) {
    const entry = entries.get(id);
    if (entry && entry.addedAt > tomb.removedAt) {
      // Re-joined after the removal — drop the stale tombstone.
      tombstones.delete(id);
    } else if (entry) {
      // Removed after (or at) the add — bury the entry.
      entries.delete(id);
    }
  }

  return {
    entries: [...entries.values()].sort((x, y) => x.communityId.localeCompare(y.communityId)),
    tombstones: [...tombstones.values()].sort((x, y) => x.communityId.localeCompare(y.communityId)),
  };
}

function mergeEntry(x: ConcordListEntry, y: ConcordListEntry): ConcordListEntry {
  return {
    communityId: x.communityId,
    current: freshest(x.current, y.current),
    seed: earliest(x.seed, y.seed),
    addedAt: Math.min(x.addedAt, y.addedAt),
  };
}

/** Higher epoch wins; tie → lower canonical bytes (total order). */
function freshest(a: ConcordKeyBundle, b: ConcordKeyBundle): ConcordKeyBundle {
  if (a.epoch !== b.epoch) return a.epoch > b.epoch ? a : b;
  return canonicalJson(a) <= canonicalJson(b) ? a : b;
}

/** Lower epoch wins; tie → lower canonical bytes (total order). */
function earliest(a: ConcordKeyBundle, b: ConcordKeyBundle): ConcordKeyBundle {
  if (a.epoch !== b.epoch) return a.epoch < b.epoch ? a : b;
  return canonicalJson(a) <= canonicalJson(b) ? a : b;
}

/** Add or update a community in the list (join/create). Pure. */
export function addToConcordList(
  list: ConcordList,
  bundle: ConcordKeyBundle,
  addedAt: number,
): ConcordList {
  const entry: ConcordListEntry = {
    communityId: bundle.communityId,
    seed: bundle,
    current: bundle,
    addedAt,
  };
  return mergeConcordLists(list, { entries: [entry], tombstones: [] });
}

/** Tombstone a community (leave/removed). Pure. */
export function removeFromConcordList(
  list: ConcordList,
  communityId: string,
  removedAt: number,
): ConcordList {
  return mergeConcordLists(list, {
    entries: [],
    tombstones: [{ communityId, removedAt }],
  });
}

/** Replace a community's `current` snapshot after a rekey/rename. Pure. */
export function refreshConcordCurrent(
  list: ConcordList,
  current: ConcordKeyBundle,
): ConcordList {
  const idx = list.entries.findIndex((e) => e.communityId === current.communityId);
  if (idx === -1) return list;
  // A local refresh is an authoritative "this is my current snapshot now" (e.g.
  // a channel was added, which doesn't bump the server-root epoch), so replace
  // `current` directly rather than routing through the epoch-keyed `freshest`
  // merge — otherwise a same-epoch update could lose the canonical-bytes
  // tiebreak and silently no-op. The entry list stays sorted by community id.
  const entries = list.entries.map((e, i) => (i === idx ? { ...e, current } : e));
  return { entries, tombstones: list.tombstones };
}

/** A list entry's community as a display descriptor. */
export function entryToCommunity(entry: ConcordListEntry): ConcordCommunity {
  return {
    communityId: entry.communityId,
    name: entry.current.name,
    relays: entry.current.relays,
  };
}

// ── Concord invite links ─────────────────────────────────────────────────────

/**
 * A parsed Concord invite link. The whole secret is the `token` (a code-word
 * that derives the bundle's location, decryption key, and authenticity signer);
 * the relays are bootstrap hints for finding the sealed invite bundle. Per
 * Vector `public_invite.rs`, keys are NEVER in the link — only this token.
 */
export interface ConcordInvite {
  /** Opaque invite token (the `#fragment` payload). */
  token: string;
  /** Bootstrap relays to look for the sealed invite bundle on. */
  relays: string[];
}

/**
 * A bare Concord invite token is the base64url `#fragment` payload on its own,
 * with no surrounding URL — the domain-agnostic form. Concord invites are
 * host-independent by design (the secret is the token; the host in a link is
 * only cosmetic), so the token alone is a complete, shareable invite. We accept
 * a generous base64url charset and a minimum length to avoid matching arbitrary
 * single words; the real validation happens when the token is decoded
 * (`parseInviteUrl`) and the sealed bundle is fetched + verified.
 */
const BARE_INVITE_TOKEN = /^[A-Za-z0-9_-]{24,}$/;

/** True when a string looks like a bare (domain-agnostic) Concord invite token. */
export function isBareConcordToken(input: string): boolean {
  return BARE_INVITE_TOKEN.test(input.trim());
}

/**
 * Parse a Concord invite into `{ token, relays }`. Accepts two forms:
 *
 *   1. A full invite URL — `https://host/invite#<token>` (optionally
 *      `?relays=…`). The token rides in the fragment, which by the way the web
 *      works never reaches the page's server — only this client reads it.
 *   2. A bare, domain-agnostic invite token — the base64url fragment payload on
 *      its own, no URL around it. Concord invites are host-independent, so the
 *      token alone is a complete invite.
 *
 * We do not (and cannot, without the protocol layer) validate the token here;
 * we only extract it and any bootstrap relays. Returns `undefined` for anything
 * that isn't a recognizable Concord invite.
 */
export function parseConcordInvite(input: string): ConcordInvite | undefined {
  const trimmed = input.trim();

  // Domain-agnostic: a bare base64url token (or `#token`) with no URL.
  const bare = trimmed.replace(/^#/, "");
  if (!/[:/]/.test(trimmed) && isBareConcordToken(bare)) {
    return { token: bare, relays: [] };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return undefined;
  }
  const path = url.pathname.replace(/\/$/, "");
  if (path !== CONCORD_INVITE_PATH) return undefined;

  const token = url.hash.replace(/^#/, "").trim();
  if (!token) return undefined;

  const relays = (url.searchParams.get("relays") ?? "")
    .split(",")
    .map((r) => normalizeRelayUrl(r))
    .filter((r): r is string => Boolean(r));

  return { token, relays };
}

/** True when a string looks like a Concord invite (link or bare token). */
export function isConcordInvite(input: string): boolean {
  return parseConcordInvite(input) !== undefined;
}

/**
 * The result of classifying a pasted "add" input. The Add wizard's escape
 * hatch takes one free-text field and figures out what the user pasted:
 *
 *   - `concord` — a Concord invite (full link or bare domain-agnostic token);
 *     join the encrypted chat.
 *   - `nip29`   — a relay URL (or bare host); add the server.
 *   - `unknown` — nothing recognizable yet.
 *
 * Concord invites are checked first because their bare-token form never looks
 * like a relay URL (no scheme/host), so there's no ambiguity.
 */
export type AddInput =
  | { kind: "concord"; invite: ConcordInvite }
  | { kind: "nip29"; relay: string }
  | { kind: "unknown" };

/** Classify a pasted string into a Concord invite, a NIP-29 relay, or unknown. */
export function classifyAddInput(input: string): AddInput {
  const trimmed = input.trim();
  if (!trimmed) return { kind: "unknown" };

  const invite = parseConcordInvite(trimmed);
  if (invite) return { kind: "concord", invite };

  const relay = normalizeRelayUrl(trimmed);
  if (relay) return { kind: "nip29", relay };

  return { kind: "unknown" };
}

// ── Protocol implementation ─────────────────────────────────────────────────
//
// The Concord wire protocol (sealed envelopes, signed roster, epoch rekey,
// invites, key derivation) is implemented under `lib/concord/` (ported from
// Vector's `vector-core/community`). The I/O-bound create/join actions are
// `useConcordActions`; the membership directory is `useConcordList`. This file
// is the pure model + link parsing those build on.

/** Whether the Concord protocol is wired in. */
export const CONCORD_ENABLED = true;

/**
 * Whether GENERATION of experimental CORD communities (and hence their v3
 * invite links) is offered in the UI. Dev builds only — production keeps the
 * create flow strictly Vector-parity while the format iterates. JOINING a CORD
 * invite someone sends you works everywhere regardless (parsing is always on).
 */
export const CORD_CREATE_ENABLED: boolean = import.meta.env.DEV;
