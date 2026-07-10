/**
 * Concord V2 Control Plane — CORD-02 §5/§6/§9, CORD-04.
 *
 * The Control Plane is one Private Stream per Community (keyed by the
 * community_root at `control_pk`) carrying versioned, real-npub-signed
 * editions inside PLAINTEXT seals (kind 20014 — the one plane whose seals stay
 * plaintext so a compaction can re-wrap signed editions across epochs).
 *
 * `foldControlState` replays the whole plane into current state in one pass:
 * the owner-rooted roster first (delegation fixpoint — the owner's rank comes
 * from the community_id itself, never from any fold), then every authority-
 * gated entity (metadata, channels, banlist, invite registries).
 */

import type { NostrEvent } from "nostr-tools/pure";

import {
  banlistLocator,
  bytesToHex,
  controlGroupKey,
  dissolvedGroupKey,
  grantLocator,
  hex32,
  inviteLinksLocator,
  type GroupKey,
} from "@/concord-v2/lib/derive";
import {
  buildEditionRumor,
  parseEdition,
  toFoldEdition,
  type AuthorityCitation,
  type ParsedEdition,
} from "@/concord-v2/lib/edition";
import {
  KIND_SEAL_PLAINTEXT,
  VSK_BANLIST,
  VSK_CHANNEL,
  VSK_DISSOLVED,
  VSK_GRANT,
  VSK_INVITE_REGISTRY,
  VSK_METADATA,
  VSK_ROLE,
} from "@/concord-v2/lib/kinds";
import {
  canActOnPosition,
  emptyRoles,
  grantFromJSON,
  grantToJSON,
  isAuthorized,
  MAX_ROLES_PER_COMMUNITY,
  Permissions,
  roleFromJSON,
  roleToJSON,
  type CommunityRoles,
  type MemberGrant,
  type Role,
} from "@/concord-v2/lib/roles";
import { buildRumor, openWrap, sealRumor, wrapSeal, type OpenedEvent, type Rumor, type StreamSigner } from "@/concord-v2/lib/stream";
import {
  utf8Len,
  DESCRIPTION_MAX_BYTES,
  NAME_MAX_BYTES,
  capRelays,
  isImagePointer,
  type ChannelMetadata,
  type CommunityMetadata,
  type CommunityV2,
} from "@/concord-v2/lib/types";
import { fold, type Edition } from "@/concord-v2/lib/version";

// ── Addressing ───────────────────────────────────────────────────────────────

/** Every control-plane stream key across the community's held root epochs, newest first. */
export function controlGroups(community: CommunityV2): GroupKey[] {
  return community.heldRoots.map((r) => controlGroupKey(r.key, community.id, r.epoch));
}

/** The CURRENT control-plane stream key (where new editions publish). */
export function currentControlGroup(community: CommunityV2): GroupKey {
  return controlGroupKey(community.root, community.id, community.rootEpoch);
}

// ── Sealing / opening ────────────────────────────────────────────────────────

/** Sign (plaintext seal) + wrap one edition rumor for the control stream. */
export async function sealEdition(rumor: Rumor, control: GroupKey, signer: StreamSigner): Promise<NostrEvent> {
  const seal = await sealRumor(rumor, KIND_SEAL_PLAINTEXT, control, signer);
  return wrapSeal(seal, control);
}

/**
 * Decode-once memo for opened+parsed control editions, keyed by wrap id. The
 * roster/metadata/banlist consumers re-fold on every mount and poll; a wrap's
 * decryption + seal verify is immutable, so parse each exactly once per
 * session. `null` remembers a failure (not ours / malformed) so it isn't
 * retried either.
 */
const parsedEditionMemo = new Map<string, ParsedEdition | null>();

/** Open every control wrap that decodes under one of `groups` into editions. */
export function openControlWraps(wraps: NostrEvent[], groups: GroupKey[]): ParsedEdition[] {
  const byPk = new Map(groups.map((g) => [g.pk, g]));
  const out: ParsedEdition[] = [];
  for (const wrap of wraps) {
    const cached = parsedEditionMemo.get(wrap.id);
    if (cached !== undefined) {
      if (cached) out.push(cached);
      continue;
    }
    const group = byPk.get(wrap.pubkey);
    if (!group) continue; // an epoch we don't hold — leave uncached (a caught-up rekey may open it)
    let parsed: ParsedEdition | null = null;
    try {
      parsed = parseEdition(openWrap(wrap, group));
    } catch {
      parsed = null;
    }
    parsedEditionMemo.set(wrap.id, parsed);
    if (parsed) out.push(parsed);
  }
  return out;
}

/**
 * Parse already-OPENED control events (from the decrypted opened-event cache)
 * into editions. The wrap decrypt + seal verify happened at ingest; this only
 * extracts the edition machinery. Memoized per rumor id, so re-folds are cheap.
 */
export function openControlEditions(opened: OpenedEvent[]): ParsedEdition[] {
  const out: ParsedEdition[] = [];
  for (const ev of opened) {
    const cached = parsedEditionMemo.get(ev.rumorId);
    if (cached !== undefined) {
      if (cached) out.push(cached);
      continue;
    }
    let parsed: ParsedEdition | null = null;
    try {
      parsed = parseEdition(ev);
    } catch {
      parsed = null;
    }
    parsedEditionMemo.set(ev.rumorId, parsed);
    if (parsed) out.push(parsed);
  }
  return out;
}

// ── Edition builders ─────────────────────────────────────────────────────────

interface BuildCommon {
  actorPubkey: string;
  version: bigint;
  prevHash?: Uint8Array;
  createdAtSecs?: number;
  authority?: AuthorityCitation;
}

/** Community metadata (vsk 0); eid = the community_id. Gated by MANAGE_METADATA. */
export function buildMetadataEdition(communityId: Uint8Array, metadata: CommunityMetadata, o: BuildCommon): Rumor {
  if (utf8Len(metadata.name) > NAME_MAX_BYTES) throw new Error(`community name exceeds ${NAME_MAX_BYTES} bytes`);
  if (metadata.description !== undefined && utf8Len(metadata.description) > DESCRIPTION_MAX_BYTES) {
    throw new Error(`description exceeds ${DESCRIPTION_MAX_BYTES} bytes`);
  }
  return buildEditionRumor({ vsk: VSK_METADATA, entityId: communityId, content: JSON.stringify(metadata), ...o });
}

/** Role (vsk 1); eid = the role_id. Gated by MANAGE_ROLES. */
export function buildRoleEdition(role: Role, o: BuildCommon): Rumor {
  if (utf8Len(role.name) > NAME_MAX_BYTES) throw new Error(`role name exceeds ${NAME_MAX_BYTES} bytes`);
  return buildEditionRumor({ vsk: VSK_ROLE, entityId: hex32(role.roleId), content: roleToJSON(role), ...o });
}

/** Channel metadata (vsk 2); eid = the channel_id. Gated by MANAGE_CHANNELS. */
export function buildChannelEdition(channelId: Uint8Array, metadata: ChannelMetadata, o: BuildCommon): Rumor {
  if (utf8Len(metadata.name) > NAME_MAX_BYTES) throw new Error(`channel name exceeds ${NAME_MAX_BYTES} bytes`);
  return buildEditionRumor({ vsk: VSK_CHANNEL, entityId: channelId, content: JSON.stringify(metadata), ...o });
}

/** Grant (vsk 3); eid = grant_locator(cid, member). Empty role_ids = a revoke. */
export function buildGrantEdition(communityId: Uint8Array, grant: MemberGrant, o: BuildCommon): Rumor {
  const entityId = grantLocator(communityId, hex32(grant.member));
  return buildEditionRumor({ vsk: VSK_GRANT, entityId, content: grantToJSON(grant), ...o });
}

/** Banlist (vsk 4); eid = banlist_locator(cid). The whole list, replaced entire. */
export function buildBanlistEdition(communityId: Uint8Array, banned: string[], o: BuildCommon): Rumor {
  return buildEditionRumor({
    vsk: VSK_BANLIST,
    entityId: banlistLocator(communityId),
    content: JSON.stringify(banned),
    ...o,
  });
}

/** Invite Registry (vsk 8); eid = invite_links_locator(cid, creator). Locators only. */
export function buildRegistryEdition(communityId: Uint8Array, creatorHex: string, linkSigners: string[], o: BuildCommon): Rumor {
  return buildEditionRumor({
    vsk: VSK_INVITE_REGISTRY,
    entityId: inviteLinksLocator(communityId, hex32(creatorHex)),
    content: JSON.stringify(linkSigners),
    ...o,
  });
}

// ── The one-pass fold ────────────────────────────────────────────────────────

export interface EntityHead {
  version: bigint;
  hash: Uint8Array;
}

/** One channel's folded definition. */
export interface FoldedChannel {
  channelIdHex: string;
  name: string;
  isPrivate: boolean;
  deleted: boolean;
}

/** The Control Plane replayed into current state. */
export interface FoldedControl {
  roster: CommunityRoles;
  /** The proven owner (from the community_id commitment) — position 0, supreme. */
  ownerHex: string;
  metadata?: CommunityMetadata;
  /** channelIdHex → folded definition (deleted channels included, flagged). */
  channels: Map<string, FoldedChannel>;
  banned: Set<string>;
  /** Aggregate live public-invite link signers (the Public/Private source of truth). */
  liveInviteLinks: Set<string>;
  /** creatorHex → that creator's own registry list (for maintaining one's registry). */
  registriesByCreator: Map<string, string[]>;
  /** Per-entity head version + hash, for chaining the next edition (key = eid hex). */
  heads: Map<string, EntityHead>;
  /**
   * The chosen head EDITION per entity (key = eid hex) — carries the
   * re-wrappable plaintext seal a Refounding's compaction republishes.
   */
  headEditions: Map<string, ParsedEdition>;
}

function pushEdition(m: Map<string, ParsedEdition[]>, key: string, p: ParsedEdition) {
  const list = m.get(key);
  if (list) list.push(p);
  else m.set(key, [p]);
}

/**
 * Fold one entity's editions into an ORDERED candidate list:
 *
 *   1. the chain-verified fold head first (refuse-downgrade, contiguity — the
 *      steady-state answer, and the compaction case too: a re-wrapped head
 *      with a dangling `prev` is still the lowest-anchored walk's top);
 *   2. then the remaining per-version winners, DESCENDING — the bootstrap
 *      candidates a fresh joiner may accept when (and only when) a
 *      higher-priority candidate fails the caller's authority gate. "The
 *      highest authority-verified head" (CORD-04 §1) requires gating before
 *      choosing, or a forger could suppress a legit entity with garbage at a
 *      higher (or dangling lower) version.
 *
 * The caller picks the first candidate that passes its gate and records it in
 * `heads`.
 */
function headCandidates(editions: ParsedEdition[]): ParsedEdition[] {
  const folds: Edition[] = editions.map(toFoldEdition);
  const result = fold(folds, 0n);
  const ordered: ParsedEdition[] = [];
  if (result.head !== null) ordered.push(editions[result.head]);
  const rest = editions
    .map((e, i) => ({ e, i }))
    .filter(({ i }) => i !== result.head)
    .sort((a, b) => {
      if (a.e.version !== b.e.version) return a.e.version > b.e.version ? -1 : 1;
      return bytesToHex(a.e.rumorId) < bytesToHex(b.e.rumorId) ? -1 : 1;
    })
    .map(({ e }) => e);
  // Deduplicate per version (the fold's equal-version winner rule).
  const seenVersions = new Set<string>(ordered.map((e) => e.version.toString()));
  for (const e of rest) {
    const v = e.version.toString();
    if (seenVersions.has(v)) continue;
    seenVersions.add(v);
    ordered.push(e);
  }
  return ordered;
}

/** Pick the first candidate passing `gate`; record it as the entity's head. */
function pickHead(
  candidates: ParsedEdition[],
  heads: Map<string, EntityHead>,
  headEditions: Map<string, ParsedEdition>,
  gate: (p: ParsedEdition) => boolean,
): ParsedEdition | undefined {
  for (const p of candidates) {
    if (!gate(p)) continue;
    heads.set(bytesToHex(p.entityId), { version: p.version, hash: p.selfHash });
    headEditions.set(bytesToHex(p.entityId), p);
    return p;
  }
  return undefined;
}

/**
 * The delegation fixpoint (CORD-04 §2): start with the owner authorized (their
 * rank comes from the community_id, not any fold), then admit role/grant
 * entities whose signer is authorized to make them, repeating until stable.
 * Per entity the ORDERED candidates are tried in turn and the first authorized
 * one settles it, so a forger's garbage edition can't suppress a legit head.
 * Anything whose signer never becomes authorized is dropped (the
 * self-promotion / forged-delegation defense).
 */
function authorizeDelegation(
  roleCandidates: Map<string, Array<{ role: Role; author: string; parsed: ParsedEdition }>>,
  grantCandidates: Map<string, Array<{ grant: MemberGrant; author: string; parsed: ParsedEdition }>>,
  ownerHex: string,
  heads: Map<string, EntityHead>,
  headEditions: Map<string, ParsedEdition>,
): CommunityRoles {
  const roster = emptyRoles();
  const settledRoles = new Set<string>();
  const settledGrants = new Set<string>();
  let changed = true;

  const settle = (p: ParsedEdition) => {
    heads.set(bytesToHex(p.entityId), { version: p.version, hash: p.selfHash });
    headEditions.set(bytesToHex(p.entityId), p);
  };

  while (changed) {
    changed = false;

    // Roles: the owner may define any role (position ≥ 1 — the top is not
    // mintable, enforced at parse); a non-owner needs MANAGE_ROLES and must
    // strictly outrank the position they mint.
    for (const [eid, candidates] of roleCandidates) {
      if (settledRoles.has(eid)) continue;
      for (const { role, author, parsed } of candidates) {
        const ok = author === ownerHex || canActOnPosition(roster, author, ownerHex, role.position, Permissions.MANAGE_ROLES);
        if (!ok) continue;
        roster.roles.push(role);
        settledRoles.add(eid);
        settle(parsed);
        changed = true;
        break;
      }
    }

    // Grants: honored only if the signer outranks every Role handed out.
    for (const [eid, candidates] of grantCandidates) {
      if (settledGrants.has(eid)) continue;
      for (const { grant, author, parsed } of candidates) {
        const positions = grant.roleIds
          .map((rid) => roster.roles.find((r) => r.roleId === rid)?.position)
          .filter((p): p is number => p !== undefined);
        const allKnown = positions.length === grant.roleIds.length;
        const ok =
          author === ownerHex ||
          (allKnown && positions.every((pos) => canActOnPosition(roster, author, ownerHex, pos, Permissions.MANAGE_ROLES)));
        if (!ok) continue;
        roster.grants.push(grant);
        settledGrants.add(eid);
        settle(parsed);
        changed = true;
        break;
      }
    }
  }

  // Deterministic cap: a Community carries at most 100 Roles — fold the 100
  // lowest role_ids and ignore the rest (CORD-04 §2).
  if (roster.roles.length > MAX_ROLES_PER_COMMUNITY) {
    roster.roles.sort((a, b) => (a.roleId < b.roleId ? -1 : a.roleId > b.roleId ? 1 : 0));
    roster.roles = roster.roles.slice(0, MAX_ROLES_PER_COMMUNITY);
  }
  return roster;
}

/** Fold-once memo, keyed on the community + the exact edition set. */
const foldMemo = new Map<string, FoldedControl>();

/**
 * Replay a set of opened control editions into current state. `ownerHex` is
 * the community's proven owner (verified against the id commitment when the
 * membership entry was accepted).
 */
export function foldControlState(editions: ParsedEdition[], communityId: Uint8Array, ownerHex: string): FoldedControl {
  const cidHex = bytesToHex(communityId);
  const memoKey = `${cidHex}:${ownerHex}:${editions.map((e) => e.opened.wrapId).sort().join(",")}`;
  const hit = foldMemo.get(memoKey);
  if (hit) return hit;

  // 1. Group by (vsk, entity).
  const byVsk = new Map<string, Map<string, ParsedEdition[]>>();
  for (const p of editions) {
    let m = byVsk.get(p.vsk);
    if (!m) byVsk.set(p.vsk, (m = new Map()));
    pushEdition(m, bytesToHex(p.entityId), p);
  }

  const heads = new Map<string, EntityHead>();
  const headEditions = new Map<string, ParsedEdition>();
  /** Ordered head candidates per entity of one vsk. */
  const candidatesOf = (vsk: string): Map<string, ParsedEdition[]> => {
    const out = new Map<string, ParsedEdition[]>();
    for (const [eid, list] of byVsk.get(vsk) ?? new Map<string, ParsedEdition[]>()) {
      out.set(eid, headCandidates(list));
    }
    return out;
  };

  // 2. Roster (owner-rooted fixpoint) — resolved before any gated entity.
  const roleCandidates = new Map<string, Array<{ role: Role; author: string; parsed: ParsedEdition }>>();
  for (const [eid, candidates] of candidatesOf(VSK_ROLE)) {
    const parsed = candidates
      .map((p) => ({ role: roleFromJSON(p.content), author: p.author, parsed: p }))
      // The entity coordinate must be the role's own id (anti-spoofing).
      .filter((c): c is { role: Role; author: string; parsed: ParsedEdition } =>
        Boolean(c.role && bytesToHex(hex32(c.role.roleId)) === eid),
      );
    if (parsed.length > 0) roleCandidates.set(eid, parsed);
  }
  const grantCandidates = new Map<string, Array<{ grant: MemberGrant; author: string; parsed: ParsedEdition }>>();
  for (const [eid, candidates] of candidatesOf(VSK_GRANT)) {
    const parsed = candidates
      .map((p) => ({ grant: grantFromJSON(p.content), author: p.author, parsed: p }))
      // The coordinate must be the member's grant locator (anti-spoofing).
      .filter((c): c is { grant: MemberGrant; author: string; parsed: ParsedEdition } =>
        Boolean(c.grant && bytesToHex(grantLocator(communityId, hex32(c.grant.member))) === eid),
      );
    if (parsed.length > 0) grantCandidates.set(eid, parsed);
  }
  const roster = authorizeDelegation(roleCandidates, grantCandidates, ownerHex, heads, headEditions);

  // 3. Metadata (vsk 0): must be the community's own entity + an authorized actor.
  let metadata: CommunityMetadata | undefined;
  {
    const candidates = candidatesOf(VSK_METADATA).get(cidHex) ?? [];
    const head = pickHead(candidates, heads, headEditions, (p) => {
      if (!isAuthorized(roster, p.author, ownerHex, Permissions.MANAGE_METADATA)) return false;
      try {
        const parsed = JSON.parse(p.content) as CommunityMetadata;
        return typeof parsed.name === "string";
      } catch {
        return false;
      }
    });
    if (head) {
      const parsed = JSON.parse(head.content) as CommunityMetadata;
      metadata = {
        ...parsed,
        relays: capRelays(Array.isArray(parsed.relays) ? parsed.relays : []),
        icon: isImagePointer(parsed.icon) ? parsed.icon : undefined,
        banner: isImagePointer(parsed.banner) ? parsed.banner : undefined,
      };
    }
  }

  // 4. Channels (vsk 2), each gated by MANAGE_CHANNELS.
  const channels = new Map<string, FoldedChannel>();
  for (const [eid, candidates] of candidatesOf(VSK_CHANNEL)) {
    const head = pickHead(candidates, heads, headEditions, (p) => {
      if (!isAuthorized(roster, p.author, ownerHex, Permissions.MANAGE_CHANNELS)) return false;
      try {
        const meta = JSON.parse(p.content) as ChannelMetadata;
        return typeof meta.name === "string" && meta.name.length > 0;
      } catch {
        return false;
      }
    });
    if (!head) continue;
    const meta = JSON.parse(head.content) as ChannelMetadata;
    channels.set(eid, {
      channelIdHex: eid,
      name: meta.name,
      isPrivate: meta.private === true,
      deleted: meta.deleted === true,
    });
  }

  // 5. Banlist (vsk 4): the one anti-roster; unauthorized head → empty (fail closed).
  const banned = new Set<string>();
  {
    const eid = bytesToHex(banlistLocator(communityId));
    const candidates = candidatesOf(VSK_BANLIST).get(eid) ?? [];
    const head = pickHead(candidates, heads, headEditions, (p) => {
      if (!isAuthorized(roster, p.author, ownerHex, Permissions.BAN)) return false;
      try {
        return Array.isArray(JSON.parse(p.content));
      } catch {
        return false;
      }
    });
    if (head) {
      for (const pk of JSON.parse(head.content) as unknown[]) {
        if (typeof pk === "string" && /^[0-9a-f]{64}$/i.test(pk)) banned.add(pk.toLowerCase());
      }
    }
  }

  // 6. Invite registries (vsk 8): each creator owns exactly their own list
  // (the coordinate binds to the author), honored only while its author holds
  // CREATE_INVITE. The aggregate active set is the Public/Private source of
  // truth (CORD-05 §5).
  const liveInviteLinks = new Set<string>();
  const registriesByCreator = new Map<string, string[]>();
  for (const [eid, candidates] of candidatesOf(VSK_INVITE_REGISTRY)) {
    const head = pickHead(candidates, heads, headEditions, (p) => {
      if (bytesToHex(inviteLinksLocator(communityId, hex32(p.author))) !== eid) return false;
      if (!isAuthorized(roster, p.author, ownerHex, Permissions.CREATE_INVITE)) return false;
      try {
        return Array.isArray(JSON.parse(p.content));
      } catch {
        return false;
      }
    });
    if (!head) continue;
    const list = (JSON.parse(head.content) as unknown[]).filter(
      (s): s is string => typeof s === "string" && /^[0-9a-f]{64}$/i.test(s),
    );
    registriesByCreator.set(head.author, list);
    for (const pk of list) liveInviteLinks.add(pk.toLowerCase());
  }

  const result: FoldedControl = { roster, ownerHex, metadata, channels, banned, liveInviteLinks, registriesByCreator, heads, headEditions };
  // Single-entry-per-community cache so the memo doesn't grow unbounded.
  for (const k of foldMemo.keys()) if (k.startsWith(`${cidHex}:`)) foldMemo.delete(k);
  foldMemo.set(memoKey, result);
  return result;
}

// ── Dissolution (CORD-02 §9) ─────────────────────────────────────────────────

const ZERO32_HEX = "0".repeat(64);

/**
 * Build the owner-dissolution tombstone rumor: chainless (no ev/ep/vac),
 * eid = 0…0, empty content. Published at `dissolved_pk` — a coordinate derived
 * from the community_id alone, so every member past or present resolves it.
 */
export function buildDissolvedRumor(ownerPubkey: string, createdAtSecs?: number): Rumor {
  return buildRumor({
    kind: 3308,
    content: "",
    tags: [
      ["vsk", VSK_DISSOLVED],
      ["eid", ZERO32_HEX],
    ],
    pubkey: ownerPubkey,
    ms: null,
    createdAtSecs,
  });
}

/** Sign + wrap the dissolution tombstone at the community's dissolved address. */
export async function sealDissolved(communityId: Uint8Array, ownerPubkey: string, signer: StreamSigner): Promise<NostrEvent> {
  const group = dissolvedGroupKey(communityId);
  const rumor = buildDissolvedRumor(ownerPubkey);
  const seal = await sealRumor(rumor, KIND_SEAL_PLAINTEXT, group, signer);
  return wrapSeal(seal, group);
}

/**
 * Whether any of `wraps` is a valid owner-signed dissolution tombstone for
 * this community. Only the owner's signature counts; an impostor's event at
 * the (findable-by-anyone) address is noise. Terminal: on sight, the client
 * seals the community read-only.
 */
export function isDissolved(wraps: NostrEvent[], communityId: Uint8Array, ownerHex: string): boolean {
  const group = dissolvedGroupKey(communityId);
  for (const wrap of wraps) {
    let opened: OpenedEvent;
    try {
      opened = openWrap(wrap, group);
    } catch {
      continue;
    }
    if (isDissolvedOpened(opened, ownerHex)) return true;
  }
  return false;
}

/** Whether an already-opened dissolved-address event is a valid owner tombstone. */
export function isDissolvedOpened(opened: OpenedEvent, ownerHex: string): boolean {
  if (opened.author !== ownerHex) return false;
  const vsk = opened.tags.find((t) => t[0] === "vsk")?.[1];
  const eid = opened.tags.find((t) => t[0] === "eid")?.[1];
  return opened.kind === 3308 && vsk === VSK_DISSOLVED && eid === ZERO32_HEX;
}
