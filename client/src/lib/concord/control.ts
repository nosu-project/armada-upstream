/**
 * Concord control plane — ported from Vector's `community/roster.rs` (focused
 * subset: build/seal/open/fold the kind-3308 authority editions that define
 * roles, grants, and the owner-derived roster).
 *
 * Authority is keyless: a control change is an inner event signed by the actor's
 * real npub (the proof of WHO acted), sealed under the server-root key (only
 * members decrypt), addressed by the control pseudonym (no stable on-wire id).
 * Every client fetches the union, folds per-entity version chains, and resolves
 * authority against the owner attestation + the delegation chain.
 *
 * Content JSON is Vector-serde-compatible (snake_case fields, integer
 * permission bitfields, internally-tagged role scope), so roles, grants, and
 * metadata authored by either client deserialize on the other.
 */

import { bytesToHex } from "@noble/hashes/utils.js";
import { finalizeEvent, verifyEvent } from "nostr-tools/pure";
import type { NostrEvent } from "nostr-tools/pure";

import { open as cipherOpen, seal as cipherSeal } from "@/lib/concord/cipher";
import { banlistLocator, channelPseudonym, dissolvedEnvelopeKey, dissolvedLocator, dissolvedPseudonym, grantLocator } from "@/lib/concord/derive";
import {
  buildEditionInner,
  parseEditionInner,
  toFoldEdition,
  type ParsedEdition,
} from "@/lib/concord/edition";
import { KIND_COMMUNITY_CONTROL } from "@/lib/concord/kinds";
import type { ChannelMetadata, CommunityMetadata } from "@/lib/concord/metadata";
import { verifyOwnerAttestation } from "@/lib/concord/owner";
import {
  canActOnPosition,
  grantFromJSON,
  grantToJSON,
  Permissions,
  roleFromJSON,
  roleToJSON,
  type CommunityRoles,
  type MemberGrant,
  type Role,
} from "@/lib/concord/roles";
import { hex32 } from "@/lib/concord/types";
import { fold, type Edition } from "@/lib/concord/version";

/** Control-edition sub-kinds (the `vsk` tag), matching Vector's allocation. */
export const VSK_COMMUNITY_ROOT = "0";
export const VSK_ROLE = "1";
export const VSK_CHANNEL = "2";
export const VSK_GRANT = "3";
export const VSK_BANLIST = "4";
/** vsk=10: the owner-dissolution tombstone (no version chain; presence = dissolved). */
export const VSK_DISSOLVED = "10";

/**
 * The control-plane relay address (`#z`). Derived from the server-root key +
 * community id, so members compute it but outsiders can't. Reuses the channel
 * pseudonym derivation (distinct IKM/id keeps it from aliasing a channel's).
 */
export function controlPseudonym(serverRoot: Uint8Array, communityId: Uint8Array, epoch: bigint): string {
  return bytesToHex(channelPseudonym(serverRoot, communityId, epoch));
}

/** Seal a signed control edition (kind 3308) for the wire (server-root-encrypted, ephemeral outer). */
export function sealControlEdition(
  inner: NostrEvent,
  serverRoot: Uint8Array,
  communityId: Uint8Array,
  epoch: bigint,
  ephemeralSk?: Uint8Array,
): NostrEvent {
  if (inner.kind !== KIND_COMMUNITY_CONTROL) throw new Error("a control edition must be kind 3308");
  const content = cipherSeal(serverRoot, JSON.stringify(inner));
  const pseudonym = controlPseudonym(serverRoot, communityId, epoch);
  const sk = ephemeralSk ?? crypto.getRandomValues(new Uint8Array(32));
  return finalizeEvent(
    { kind: KIND_COMMUNITY_CONTROL, content, created_at: Math.floor(Date.now() / 1000), tags: [["z", pseudonym], ["v", "1"]] },
    sk,
  );
}

/** Open a control-edition outer → its inner edition event (decrypt under the server-root key). */
export function openControlEdition(outer: NostrEvent, serverRoot: Uint8Array): NostrEvent {
  if (outer.kind !== KIND_COMMUNITY_CONTROL) throw new Error("not a control-plane outer (kind != 3308)");
  const v = outer.tags.find((t) => t[0] === "v")?.[1];
  if (v !== "1") throw new Error(`unsupported control edition version: ${v}`);
  const json = cipherOpen(serverRoot, outer.content);
  const inner = JSON.parse(json) as NostrEvent;
  if (inner.kind !== KIND_COMMUNITY_CONTROL) throw new Error("control inner is not kind 3308");
  return inner;
}

/**
 * Decode-once cache for opened control editions, keyed by the outer event id.
 * The roster/metadata/banlist folds re-run on every mount and every 30s poll,
 * each re-decrypting (NIP-44) every control edition — the same wasteful pattern
 * Vector avoids by folding only on a fresh relay fetch. An outer event id is
 * globally unique and its decryption is immutable, so memoizing the opened inner
 * makes every re-fold after the first nearly free (just the pure version-chain
 * replay), without persisting anything new. Lives for the page session.
 */
const openedEditionMemo = new Map<string, NostrEvent>();

/** Memoized {@link openControlEdition}: decrypt+parse once per outer id, then reuse. */
export function openControlEditionMemo(outer: NostrEvent, serverRoot: Uint8Array): NostrEvent {
  const hit = openedEditionMemo.get(outer.id);
  if (hit) return hit;
  const inner = openControlEdition(outer, serverRoot);
  openedEditionMemo.set(outer.id, inner);
  return inner;
}


// ── Edition builders ──────────────────────────────────────────────────────────

/** Build an unsigned RoleMetadata edition (vsk=1, entity_id == role_id bytes). */
export function buildRoleEditionUnsigned(opts: {
  role: Role;
  version: bigint;
  prevHash?: Uint8Array;
  createdAtSecs: number;
}) {
  return buildEditionInner({
    vsk: VSK_ROLE,
    entityId: hex32(opts.role.roleId),
    version: opts.version,
    prevHash: opts.prevHash,
    content: roleToJSON(opts.role),
    createdAtSecs: opts.createdAtSecs,
  });
}

/** Build an unsigned Grant edition (vsk=3, entity_id == grant_locator(cid, member)). */
export function buildGrantEditionUnsigned(opts: {
  communityId: Uint8Array;
  grant: MemberGrant;
  version: bigint;
  prevHash?: Uint8Array;
  createdAtSecs: number;
}) {
  const entityId = grantLocator(opts.communityId, hex32(opts.grant.member));
  return buildEditionInner({
    vsk: VSK_GRANT,
    entityId,
    version: opts.version,
    prevHash: opts.prevHash,
    content: grantToJSON(opts.grant),
    createdAtSecs: opts.createdAtSecs,
  });
}

/** Build an unsigned GroupRoot (community metadata) edition (vsk=0, entity_id == community_id). */
export function buildCommunityRootEditionUnsigned(opts: {
  communityId: Uint8Array;
  metadata: CommunityMetadata;
  version: bigint;
  prevHash?: Uint8Array;
  createdAtSecs: number;
}) {
  return buildEditionInner({
    vsk: VSK_COMMUNITY_ROOT,
    entityId: opts.communityId,
    version: opts.version,
    prevHash: opts.prevHash,
    content: JSON.stringify(opts.metadata),
    createdAtSecs: opts.createdAtSecs,
  });
}

/** Build an unsigned ChannelMetadata edition (vsk=2, entity_id == channel_id). */
export function buildChannelMetadataEditionUnsigned(opts: {
  channelId: Uint8Array;
  metadata: ChannelMetadata;
  version: bigint;
  prevHash?: Uint8Array;
  createdAtSecs: number;
}) {
  return buildEditionInner({
    vsk: VSK_CHANNEL,
    entityId: opts.channelId,
    version: opts.version,
    prevHash: opts.prevHash,
    content: JSON.stringify(opts.metadata),
    createdAtSecs: opts.createdAtSecs,
  });
}

/** Build an unsigned Banlist edition (vsk=4, entity_id == banlistLocator(communityId)). */
export function buildBanlistEditionUnsigned(opts: {
  communityId: Uint8Array;
  banned: string[];
  version: bigint;
  prevHash?: Uint8Array;
  createdAtSecs: number;
}) {
  return buildEditionInner({
    vsk: VSK_BANLIST,
    entityId: banlistLocator(opts.communityId),
    version: opts.version,
    prevHash: opts.prevHash,
    content: JSON.stringify(opts.banned),
    createdAtSecs: opts.createdAtSecs,
  });
}

// ── Fold ────────────────────────────────────────────────────────────────────

/** The folded roster: the authorized roles + grants, plus the proven owner. */
export interface FoldedRoster {
  roster: CommunityRoles;
  /** The proven owner pubkey (hex), derived from the owner attestation. */
  ownerHex?: string;
  /** Per-entity head version + hash (for chaining the next edition). */
  heads: Map<string, { version: bigint; hash: Uint8Array }>;
}

/**
 * Fold a set of control-plane outer events into the current roster. Verifies
 * each inner signature, folds each entity's version chain (refuse-downgrade,
 * deterministic tiebreak, gap detection), then applies the delegation gate:
 * the owner is supreme; a role/grant is honored only if its signer holds
 * MANAGE_ROLES and outranks what they're editing, traceable to the owner.
 *
 * A simplified but sound delegation fixpoint: owner-signed entries seed the
 * roster, then admin-signed entries those admins are authorized to make are
 * folded in, until stable. Anything whose signer never becomes authorized is
 * dropped (the self-promotion / forged-delegation defense).
 */
export function foldRoster(
  outers: NostrEvent[],
  serverRoot: Uint8Array,
  communityId: Uint8Array,
  ownerAttestation: string | undefined,
): FoldedRoster {
  const cidHex = bytesToHex(communityId);

  // Fold-once cache: useConcordRoster is instantiated by several hooks
  // (metadata, banlist, messages, page) that all fold the SAME shared control
  // events, so without this each instance re-runs the full fold. Key on the
  // community + the set of edition ids; an append-only edition set means a new
  // id only appears when there's genuinely new control state to fold.
  const memoKey = `${cidHex}:${ownerAttestation ?? ""}:${outers.map((o) => o.id).sort().join(",")}`;
  const cached = foldRosterMemo.get(memoKey);
  if (cached) return cached;

  const result = foldRosterUncached(outers, serverRoot, communityId, ownerAttestation, cidHex);
  // Single-entry-per-community cache: drop other keys for this community so the
  // map doesn't grow unbounded as editions accrue.
  for (const k of foldRosterMemo.keys()) {
    if (k.startsWith(`${cidHex}:`)) foldRosterMemo.delete(k);
  }
  foldRosterMemo.set(memoKey, result);
  return result;
}

const foldRosterMemo = new Map<string, FoldedRoster>();

function foldRosterUncached(
  outers: NostrEvent[],
  serverRoot: Uint8Array,
  communityId: Uint8Array,
  ownerAttestation: string | undefined,
  cidHex: string,
): FoldedRoster {
  const ownerHex = ownerAttestation ? verifyOwnerAttestation(ownerAttestation, cidHex) : undefined;

  // 1. Decrypt + verify + group editions by (vsk, entity).
  const roleEntities = new Map<string, ParsedEdition[]>();
  const grantEntities = new Map<string, ParsedEdition[]>();
  for (const outer of outers) {
    let inner: NostrEvent;
    try {
      inner = openControlEditionMemo(outer, serverRoot);
    } catch {
      continue;
    }
    let parsed: ParsedEdition;
    try {
      parsed = parseEditionInner(inner);
    } catch {
      continue;
    }
    const key = bytesToHex(parsed.entityId);
    if (parsed.vsk === VSK_ROLE) push(roleEntities, key, parsed);
    else if (parsed.vsk === VSK_GRANT) push(grantEntities, key, parsed);
  }

  // 2. Fold each entity chain to its head edition.
  const heads = new Map<string, { version: bigint; hash: Uint8Array }>();
  const roleHeads = foldEntities(roleEntities, heads);
  const grantHeads = foldEntities(grantEntities, heads);

  // 3. Parse head contents into Role/MemberGrant + remember each head's signer.
  const roles: Array<{ role: Role; author: string }> = [];
  for (const p of roleHeads) {
    const role = roleFromJSON(p.content);
    if (role && role.roleId && bytesToHex(hex32(role.roleId)) === bytesToHex(p.entityId)) {
      roles.push({ role, author: p.author });
    }
  }
  const grants: Array<{ grant: MemberGrant; author: string }> = [];
  for (const p of grantHeads) {
    const grant = grantFromJSON(p.content);
    // entity must be the member's grant locator (anti-spoofing).
    if (grant && grant.member && bytesToHex(grantLocator(communityId, hex32(grant.member))) === bytesToHex(p.entityId)) {
      grants.push({ grant, author: p.author });
    }
  }

  // 4. Delegation fixpoint, seeded by the owner.
  const authorized = authorizeDelegation(roles, grants, ownerHex);

  return { roster: authorized, ownerHex, heads };
}

// ── Metadata fold (GroupRoot vsk=0, Channel vsk=2) ───────────────────────────

/** The folded community metadata: the GroupRoot + per-channel name overrides. */
export interface FoldedMetadata {
  /** The community-level GroupRoot descriptor, if a valid one folded. */
  root?: CommunityMetadata;
  /** channelIdHex → folded channel name. */
  channelNames: Map<string, string>;
  /** Per-entity head version + hash, for chaining the next edition. */
  heads: Map<string, { version: bigint; hash: Uint8Array }>;
}

/**
 * Fold the metadata control plane (GroupRoot vsk=0 + ChannelMetadata vsk=2) from
 * the same kind-3308 outers. Authority is enforced against the already-folded
 * roster: a GroupRoot edit requires the owner or MANAGE_METADATA; a channel-name
 * edit requires the owner or MANAGE_CHANNELS. Anything from an unauthorized
 * signer is dropped (fail-closed). `communityId` anchors the GroupRoot entity.
 */
export function foldMetadata(
  outers: NostrEvent[],
  serverRoot: Uint8Array,
  communityId: Uint8Array,
  roster: CommunityRoles,
  ownerHex: string | undefined,
): FoldedMetadata {
  const rootEntities = new Map<string, ParsedEdition[]>();
  const channelEntities = new Map<string, ParsedEdition[]>();

  for (const outer of outers) {
    let inner: NostrEvent;
    try {
      inner = openControlEditionMemo(outer, serverRoot);
    } catch {
      continue;
    }
    let parsed: ParsedEdition;
    try {
      parsed = parseEditionInner(inner);
    } catch {
      continue;
    }
    const key = bytesToHex(parsed.entityId);
    if (parsed.vsk === VSK_COMMUNITY_ROOT) push(rootEntities, key, parsed);
    else if (parsed.vsk === VSK_CHANNEL) push(channelEntities, key, parsed);
  }

  const heads = new Map<string, { version: bigint; hash: Uint8Array }>();
  const rootHeads = foldEntities(rootEntities, heads);
  const channelHeads = foldEntities(channelEntities, heads);

  const cidHex = bytesToHex(communityId);

  // GroupRoot: must be the community's own entity AND signed by an authorized actor.
  let root: CommunityMetadata | undefined;
  for (const p of rootHeads) {
    if (bytesToHex(p.entityId) !== cidHex) continue;
    if (!metadataAuthorized(roster, p.author, ownerHex, Permissions.MANAGE_METADATA)) continue;
    try {
      root = JSON.parse(p.content) as CommunityMetadata;
    } catch {
      // skip malformed
    }
  }

  // Channel names: each authorized by MANAGE_CHANNELS.
  const channelNames = new Map<string, string>();
  for (const p of channelHeads) {
    if (!metadataAuthorized(roster, p.author, ownerHex, Permissions.MANAGE_CHANNELS)) continue;
    try {
      const meta = JSON.parse(p.content) as ChannelMetadata;
      if (typeof meta.name === "string" && meta.name.length > 0) {
        channelNames.set(bytesToHex(p.entityId), meta.name);
      }
    } catch {
      // skip malformed
    }
  }

  return { root, channelNames, heads };
}

/** Owner or a holder of `permission` may edit metadata. */
function metadataAuthorized(
  roster: CommunityRoles,
  authorHex: string,
  ownerHex: string | undefined,
  permission: bigint,
): boolean {
  if (ownerHex && authorHex === ownerHex) return true;
  // effectivePermissions lives in roles.ts; inline the union check via canActOnPosition
  // against the top position (owner can always; non-owner needs the permission bit).
  return canActOnPosition(roster, authorHex, ownerHex, Number.MAX_SAFE_INTEGER, permission);
}

// ── Banlist fold (vsk=4) ─────────────────────────────────────────────────────

/** The folded banlist + the entity head (for chaining the next ban edition). */
export interface FoldedBanlist {
  /** Banned pubkeys (lowercase hex). */
  banned: Set<string>;
  head?: { version: bigint; hash: Uint8Array };
}

/**
 * Fold the banlist control plane (vsk=4) from the kind-3308 outers. The head
 * edition's author must hold BAN (or be the owner); an unauthorized banlist is
 * ignored (fail-closed → empty banlist). The banlist entity is unique per
 * community (`banlistLocator`).
 */
export function foldBanlist(
  outers: NostrEvent[],
  serverRoot: Uint8Array,
  communityId: Uint8Array,
  roster: CommunityRoles,
  ownerHex: string | undefined,
): FoldedBanlist {
  const eid = bytesToHex(banlistLocator(communityId));
  const editions: ParsedEdition[] = [];
  for (const outer of outers) {
    let inner: NostrEvent;
    try {
      inner = openControlEditionMemo(outer, serverRoot);
    } catch {
      continue;
    }
    let parsed: ParsedEdition;
    try {
      parsed = parseEditionInner(inner);
    } catch {
      continue;
    }
    if (parsed.vsk === VSK_BANLIST && bytesToHex(parsed.entityId) === eid) editions.push(parsed);
  }
  if (editions.length === 0) return { banned: new Set() };

  const result = fold(editions.map(toFoldEdition), 0n);
  if (result.head === null) return { banned: new Set() };
  const head = editions[result.head];
  if (!metadataAuthorized(roster, head.author, ownerHex, Permissions.BAN)) {
    return { banned: new Set() };
  }
  try {
    const list = JSON.parse(head.content) as string[];
    return {
      banned: new Set(Array.isArray(list) ? list.filter((s) => typeof s === "string") : []),
      head: { version: head.version, hash: head.selfHash },
    };
  } catch {
    return { banned: new Set() };
  }
}


function push(m: Map<string, ParsedEdition[]>, key: string, p: ParsedEdition) {
  const list = m.get(key);
  if (list) list.push(p);
  else m.set(key, [p]);
}

/** Fold every entity's chain; record heads; return the chosen head editions. */
function foldEntities(
  byEntity: Map<string, ParsedEdition[]>,
  heads: Map<string, { version: bigint; hash: Uint8Array }>,
): ParsedEdition[] {
  const out: ParsedEdition[] = [];
  for (const [key, editions] of byEntity) {
    const folds: Edition[] = editions.map(toFoldEdition);
    const result = fold(folds, 0n);
    if (result.head === null) continue;
    const head = editions[result.head];
    heads.set(key, { version: head.version, hash: head.selfHash });
    out.push(head);
  }
  return out;
}

/**
 * The delegation fixpoint. Start with the owner authorized; admit role/grant
 * entries whose signer is authorized to make them, repeating until no new entry
 * is admitted. The owner can author anything; a non-owner needs MANAGE_ROLES +
 * a strict outrank of the position they're editing.
 */
function authorizeDelegation(
  roleHeads: Array<{ role: Role; author: string }>,
  grantHeads: Array<{ grant: MemberGrant; author: string }>,
  ownerHex: string | undefined,
): CommunityRoles {
  if (!ownerHex) return { roles: [], grants: [] }; // fail closed: no owner → empty roster

  const roster: CommunityRoles = { roles: [], grants: [] };
  let changed = true;
  const pendingRoles = [...roleHeads];
  const pendingGrants = [...grantHeads];

  while (changed) {
    changed = false;

    // Admit roles: owner may define any role; a non-owner needs MANAGE_ROLES and
    // must outrank the role's position (can't mint a peer/superior role).
    for (let i = pendingRoles.length - 1; i >= 0; i--) {
      const { role, author } = pendingRoles[i];
      if (author === ownerHex || canActOnPosition(roster, author, ownerHex, role.position, Permissions.MANAGE_ROLES)) {
        roster.roles.push(role);
        pendingRoles.splice(i, 1);
        changed = true;
      }
    }

    // Admit grants: owner may grant anything; a non-owner needs MANAGE_ROLES and
    // must outrank every role they're granting (can't grant a peer/superior role).
    for (let i = pendingGrants.length - 1; i >= 0; i--) {
      const { grant, author } = pendingGrants[i];
      const grantedPositions = grant.roleIds
        .map((rid) => roster.roles.find((r) => r.roleId === rid)?.position)
        .filter((p): p is number => p !== undefined);
      const allKnown = grantedPositions.length === grant.roleIds.length;
      const authorized =
        author === ownerHex ||
        (allKnown && grantedPositions.every((pos) => canActOnPosition(roster, author, ownerHex, pos, Permissions.MANAGE_ROLES)));
      if (authorized) {
        roster.grants.push(grant);
        pendingGrants.splice(i, 1);
        changed = true;
      }
    }
  }

  return roster;
}

// ── Dissolve (vsk=10) ────────────────────────────────────────────────────────

/** Build the unsigned owner-dissolution tombstone (vsk=10, chain-free, empty content). */
export function buildDissolvedEditionUnsigned(communityId: Uint8Array, createdAtSecs: number) {
  return buildEditionInner({
    vsk: VSK_DISSOLVED,
    entityId: dissolvedLocator(communityId),
    version: 1n,
    content: "{}",
    createdAtSecs,
  });
}

/**
 * Seal a signed dissolution tombstone. Unlike ordinary control editions (sealed
 * under the server-root key + control pseudonym), the tombstone is enveloped
 * under the epoch-free `dissolvedEnvelopeKey` and addressed by `dissolvedPseudonym`
 * — both community-id-derived — so ANY joiner at ANY epoch finds and opens it.
 */
export function sealDissolvedEdition(inner: NostrEvent, communityId: Uint8Array, ephemeralSk?: Uint8Array): NostrEvent {
  if (inner.kind !== KIND_COMMUNITY_CONTROL) throw new Error("a dissolved tombstone must be kind 3308");
  const content = cipherSeal(dissolvedEnvelopeKey(communityId), JSON.stringify(inner));
  const sk = ephemeralSk ?? crypto.getRandomValues(new Uint8Array(32));
  return finalizeEvent(
    {
      kind: KIND_COMMUNITY_CONTROL,
      content,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["z", dissolvedPseudonym(communityId)], ["v", "1"]],
    },
    sk,
  );
}

/** The `#z` address to fetch a community's dissolution tombstone by (epoch-free). */
export function dissolvedAddress(communityId: Uint8Array): string {
  return dissolvedPseudonym(communityId);
}

/**
 * Check whether any of `outers` is a valid owner-signed dissolution tombstone
 * for this community. Returns true once a tombstone decrypts (under the
 * dissolved envelope key), parses as a vsk=10 edition at the community's
 * dissolved locator, and is signed by the proven owner. Dissolution is terminal
 * and owner-only — a non-owner tombstone is ignored.
 */
export function isDissolved(
  outers: NostrEvent[],
  communityId: Uint8Array,
  ownerHex: string | undefined,
): boolean {
  if (!ownerHex) return false;
  const eid = bytesToHex(dissolvedLocator(communityId));
  const key = dissolvedEnvelopeKey(communityId);
  for (const outer of outers) {
    if (outer.kind !== KIND_COMMUNITY_CONTROL) continue;
    let inner: NostrEvent;
    try {
      const json = cipherOpen(key, outer.content);
      inner = JSON.parse(json) as NostrEvent;
    } catch {
      continue;
    }
    if (!verifyEvent(inner)) continue;
    let parsed: ParsedEdition;
    try {
      parsed = parseEditionInner(inner);
    } catch {
      continue;
    }
    if (parsed.vsk === VSK_DISSOLVED && bytesToHex(parsed.entityId) === eid && parsed.author === ownerHex) {
      return true;
    }
  }
  return false;
}

export { verifyEvent };
