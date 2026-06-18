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
 * Content JSON is TS-native here (internal consistency drives the fold);
 * cross-wire parity with Vector's serde shapes is a later concern.
 */

import { bytesToHex } from "@noble/hashes/utils.js";
import { finalizeEvent, verifyEvent } from "nostr-tools/pure";
import type { NostrEvent } from "nostr-tools/pure";

import { open as cipherOpen, seal as cipherSeal } from "@/lib/concord/cipher";
import { channelPseudonym, grantLocator } from "@/lib/concord/derive";
import {
  buildEditionInner,
  parseEditionInner,
  toFoldEdition,
  type ParsedEdition,
} from "@/lib/concord/edition";
import { KIND_COMMUNITY_CONTROL } from "@/lib/concord/kinds";
import { verifyOwnerAttestation } from "@/lib/concord/owner";
import {
  canActOnPosition,
  Permissions,
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
    content: JSON.stringify(opts.role),
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
    content: JSON.stringify(opts.grant),
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
  const ownerHex = ownerAttestation ? verifyOwnerAttestation(ownerAttestation, cidHex) : undefined;

  // 1. Decrypt + verify + group editions by (vsk, entity).
  const roleEntities = new Map<string, ParsedEdition[]>();
  const grantEntities = new Map<string, ParsedEdition[]>();
  for (const outer of outers) {
    let inner: NostrEvent;
    try {
      inner = openControlEdition(outer, serverRoot);
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
    try {
      const role = JSON.parse(p.content) as Role;
      if (role.roleId && bytesToHex(hex32(role.roleId)) === bytesToHex(p.entityId)) {
        roles.push({ role, author: p.author });
      }
    } catch {
      // skip malformed
    }
  }
  const grants: Array<{ grant: MemberGrant; author: string }> = [];
  for (const p of grantHeads) {
    try {
      const grant = JSON.parse(p.content) as MemberGrant;
      // entity must be the member's grant locator (anti-spoofing).
      if (grant.member && bytesToHex(grantLocator(communityId, hex32(grant.member))) === bytesToHex(p.entityId)) {
        grants.push({ grant, author: p.author });
      }
    } catch {
      // skip malformed
    }
  }

  // 4. Delegation fixpoint, seeded by the owner.
  const authorized = authorizeDelegation(roles, grants, ownerHex);

  return { roster: authorized, ownerHex, heads };
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

export { verifyEvent };
