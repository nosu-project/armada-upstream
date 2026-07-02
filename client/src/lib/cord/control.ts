/**
 * CORD control plane (CORD-04) — kind-3308 edition rumors carried as CORD-01
 * stream events on the Control Plane (CORD-02 §5), keyed by
 * `group_key("concord/control", CommunityRoot, community_id, epoch)`.
 *
 * The edition structure (vsk/eid/ev/ep/vac tags + per-entity version chains)
 * carries over from v1 verbatim (the gap-fill convention); what changes is the
 * envelope (streams instead of z-pseudonym outers), the authorship proof (the
 * kind-13 SEAL signature — the rumor itself is unsigned), the edition-hash
 * domain label (`concord/edition`), and the owner proof (the self-certifying
 * community id instead of an attestation event).
 */

import { bytesToHex } from "@noble/hashes/utils.js";
import type { EventTemplate, NostrEvent } from "nostr-tools/pure";

import {
  authorizeDelegation,
  foldEntities,
  metadataAuthorized,
  pushEdition,
  VSK_BANLIST,
  VSK_CHANNEL,
  VSK_COMMUNITY_ROOT,
  VSK_GRANT,
  VSK_ROLE,
  type FoldedBanlist,
  type FoldedMetadata,
  type FoldedRoster,
} from "@/lib/concord/control";
import { parseEditionFields, type AuthorityCitation, type ParsedEdition } from "@/lib/concord/edition";
import { citationToTag } from "@/lib/concord/edition";
import { KIND_COMMUNITY_CONTROL } from "@/lib/concord/kinds";
import type { ChannelMetadata, CommunityMetadata } from "@/lib/concord/metadata";
import { grantFromJSON, grantToJSON, Permissions, roleFromJSON, roleToJSON, type MemberGrant, type Role } from "@/lib/concord/roles";
import { hex32, type Community } from "@/lib/concord/types";
import {
  controlGroupKey,
  cordBanlistLocator,
  cordGrantLocator,
  CORD_EDITION_LABEL,
  verifyCordCommunityId,
} from "@/lib/cord/derive";
import { openCordStream, type EpochGroup } from "@/lib/cord/stream";

/**
 * The control-plane group keys across every retained root epoch (current +
 * priors), newest first. Members query `authors = [pk per epoch]`.
 */
export function cordControlGroups(community: Community): EpochGroup[] {
  const roots = [
    { epoch: community.serverRootEpoch, key: community.serverRootKey },
    ...(community.priorRoots ?? []),
  ];
  const out = new Map<string, EpochGroup>();
  for (const r of roots) {
    out.set(r.epoch.toString(), { epoch: r.epoch, group: controlGroupKey(r.key, community.id, r.epoch) });
  }
  return [...out.values()].sort((a, b) => (a.epoch > b.epoch ? -1 : a.epoch < b.epoch ? 1 : 0));
}

/**
 * The PROVEN owner of a CORD community: the `owner` x-only key iff, together
 * with `ownerSalt`, it reproduces the community id (CORD-02 §1). Undefined for
 * a community whose proof is missing or fails — the roster then fails closed.
 */
export function cordProvenOwner(community: Community): string | undefined {
  if (community.proto !== "cord" || !community.owner || !community.ownerSalt) return undefined;
  try {
    return verifyCordCommunityId(community.id, hex32(community.owner), hex32(community.ownerSalt))
      ? community.owner
      : undefined;
  } catch {
    return undefined;
  }
}

// ── Edition rumor builders ───────────────────────────────────────────────────

const TAG_SUBKIND = "vsk";
const TAG_ENTITY = "eid";
const TAG_EVERSION = "ev";
const TAG_EPREV = "ep";

/** Build the UNSIGNED kind-3308 edition rumor template (no `v` tag — CORD streams blend in). */
export function buildCordEditionRumor(opts: {
  vsk: string;
  entityId: Uint8Array;
  version: bigint;
  prevHash?: Uint8Array;
  content: string;
  createdAtSecs: number;
  authority?: AuthorityCitation;
}): EventTemplate {
  const tags: string[][] = [
    [TAG_SUBKIND, opts.vsk],
    [TAG_ENTITY, bytesToHex(opts.entityId)],
    [TAG_EVERSION, opts.version.toString()],
  ];
  if (opts.prevHash) tags.push([TAG_EPREV, bytesToHex(opts.prevHash)]);
  if (opts.authority) tags.push(citationToTag(opts.authority));
  return {
    kind: KIND_COMMUNITY_CONTROL,
    content: opts.content,
    tags,
    created_at: opts.createdAtSecs,
  };
}

/** Role edition rumor (vsk=1, entity_id == role_id bytes). */
export function buildCordRoleRumor(opts: { role: Role; version: bigint; prevHash?: Uint8Array; createdAtSecs: number }) {
  return buildCordEditionRumor({
    vsk: VSK_ROLE,
    entityId: hex32(opts.role.roleId),
    version: opts.version,
    prevHash: opts.prevHash,
    content: roleToJSON(opts.role),
    createdAtSecs: opts.createdAtSecs,
  });
}

/** Grant edition rumor (vsk=3, entity_id == cordGrantLocator(cid, member)). */
export function buildCordGrantRumor(opts: {
  communityId: Uint8Array;
  grant: MemberGrant;
  version: bigint;
  prevHash?: Uint8Array;
  createdAtSecs: number;
}) {
  return buildCordEditionRumor({
    vsk: VSK_GRANT,
    entityId: cordGrantLocator(opts.communityId, hex32(opts.grant.member)),
    version: opts.version,
    prevHash: opts.prevHash,
    content: grantToJSON(opts.grant),
    createdAtSecs: opts.createdAtSecs,
  });
}

/** GroupRoot metadata edition rumor (vsk=0, entity_id == community_id). */
export function buildCordCommunityRootRumor(opts: {
  communityId: Uint8Array;
  metadata: CommunityMetadata;
  version: bigint;
  prevHash?: Uint8Array;
  createdAtSecs: number;
}) {
  return buildCordEditionRumor({
    vsk: VSK_COMMUNITY_ROOT,
    entityId: opts.communityId,
    version: opts.version,
    prevHash: opts.prevHash,
    content: JSON.stringify(opts.metadata),
    createdAtSecs: opts.createdAtSecs,
  });
}

/** ChannelMetadata edition rumor (vsk=2, entity_id == channel_id). */
export function buildCordChannelMetadataRumor(opts: {
  channelId: Uint8Array;
  metadata: ChannelMetadata;
  version: bigint;
  prevHash?: Uint8Array;
  createdAtSecs: number;
}) {
  return buildCordEditionRumor({
    vsk: VSK_CHANNEL,
    entityId: opts.channelId,
    version: opts.version,
    prevHash: opts.prevHash,
    content: JSON.stringify(opts.metadata),
    createdAtSecs: opts.createdAtSecs,
  });
}

/** Banlist edition rumor (vsk=4, entity_id == cordBanlistLocator(communityId)). */
export function buildCordBanlistRumor(opts: {
  communityId: Uint8Array;
  banned: string[];
  version: bigint;
  prevHash?: Uint8Array;
  createdAtSecs: number;
}) {
  return buildCordEditionRumor({
    vsk: VSK_BANLIST,
    entityId: cordBanlistLocator(opts.communityId),
    version: opts.version,
    prevHash: opts.prevHash,
    content: JSON.stringify(opts.banned),
    createdAtSecs: opts.createdAtSecs,
  });
}

// ── Open + parse (decode-once, keyed by the wrap id) ─────────────────────────

const parsedMemo = new Map<string, ParsedEdition | null>();

/**
 * Open one control-plane stream event across the held root-epoch group keys
 * and parse it as an edition. The SEAL signature proves the author (the rumor
 * is unsigned); the edition hash uses the CORD chain label. Memoized by wrap
 * id; `undefined` = not ours / malformed (remembered).
 */
export function openCordControlEdition(outer: NostrEvent, groups: EpochGroup[]): ParsedEdition | undefined {
  const cached = parsedMemo.get(outer.id);
  if (cached !== undefined) return cached ?? undefined;
  let parsed: ParsedEdition | null = null;
  const hit = groups.find((eg) => eg.group.pk === outer.pubkey);
  if (hit) {
    try {
      const { rumor, author } = openCordStream(outer, hit.group);
      if (rumor.kind === KIND_COMMUNITY_CONTROL) {
        parsed = parseEditionFields(rumor, author, CORD_EDITION_LABEL);
      }
    } catch {
      parsed = null; // not ours / bad seal / malformed — remember the skip
    }
  }
  parsedMemo.set(outer.id, parsed);
  return parsed ?? undefined;
}

// ── Folds (shared per-entity version-chain + delegation machinery) ───────────

/** Fold the CORD control plane into the authorized roster (see v1 foldRoster). */
export function foldCordRoster(outers: NostrEvent[], community: Community): FoldedRoster {
  const groups = cordControlGroups(community);
  const ownerHex = cordProvenOwner(community);

  const roleEntities = new Map<string, ParsedEdition[]>();
  const grantEntities = new Map<string, ParsedEdition[]>();
  for (const outer of outers) {
    const parsed = openCordControlEdition(outer, groups);
    if (!parsed) continue;
    const key = bytesToHex(parsed.entityId);
    if (parsed.vsk === VSK_ROLE) pushEdition(roleEntities, key, parsed);
    else if (parsed.vsk === VSK_GRANT) pushEdition(grantEntities, key, parsed);
  }

  const heads = new Map<string, { version: bigint; hash: Uint8Array }>();
  const roleHeads = foldEntities(roleEntities, heads);
  const grantHeads = foldEntities(grantEntities, heads);

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
    if (grant && grant.member && bytesToHex(cordGrantLocator(community.id, hex32(grant.member))) === bytesToHex(p.entityId)) {
      grants.push({ grant, author: p.author });
    }
  }

  const authorized = authorizeDelegation(roles, grants, ownerHex);
  return { roster: authorized, ownerHex, heads };
}

/** Fold the CORD metadata plane (GroupRoot vsk=0 + ChannelMetadata vsk=2). */
export function foldCordMetadata(
  outers: NostrEvent[],
  community: Community,
  roster: FoldedRoster,
): FoldedMetadata {
  const groups = cordControlGroups(community);
  const rootEntities = new Map<string, ParsedEdition[]>();
  const channelEntities = new Map<string, ParsedEdition[]>();

  for (const outer of outers) {
    const parsed = openCordControlEdition(outer, groups);
    if (!parsed) continue;
    const key = bytesToHex(parsed.entityId);
    if (parsed.vsk === VSK_COMMUNITY_ROOT) pushEdition(rootEntities, key, parsed);
    else if (parsed.vsk === VSK_CHANNEL) pushEdition(channelEntities, key, parsed);
  }

  const heads = new Map<string, { version: bigint; hash: Uint8Array }>();
  const rootHeads = foldEntities(rootEntities, heads);
  const channelHeads = foldEntities(channelEntities, heads);
  const cidHex = bytesToHex(community.id);

  let root: CommunityMetadata | undefined;
  for (const p of rootHeads) {
    if (bytesToHex(p.entityId) !== cidHex) continue;
    if (!metadataAuthorized(roster.roster, p.author, roster.ownerHex, Permissions.MANAGE_METADATA)) continue;
    try {
      const parsed = JSON.parse(p.content) as CommunityMetadata;
      // A CORD GroupRoot must carry a VALID owner proof for this community.
      if (
        typeof parsed.owner === "string" &&
        typeof parsed.owner_salt === "string" &&
        verifyCordCommunityId(community.id, hex32(parsed.owner), hex32(parsed.owner_salt))
      ) {
        root = parsed;
      }
    } catch {
      // skip malformed
    }
  }

  const channelNames = new Map<string, string>();
  for (const p of channelHeads) {
    if (!metadataAuthorized(roster.roster, p.author, roster.ownerHex, Permissions.MANAGE_CHANNELS)) continue;
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

/**
 * The PUBLIC (derived) channels the control plane defines: every authorized
 * vsk=2 entity not flagged `private`. This is how a member discovers channels
 * added after their invite — a derived channel needs no key delivery at all.
 */
export function foldCordChannels(
  outers: NostrEvent[],
  community: Community,
  roster: FoldedRoster,
): Array<{ channelId: string; name: string; isPrivate: boolean }> {
  const groups = cordControlGroups(community);
  const channelEntities = new Map<string, ParsedEdition[]>();
  for (const outer of outers) {
    const parsed = openCordControlEdition(outer, groups);
    if (!parsed) continue;
    if (parsed.vsk === VSK_CHANNEL) pushEdition(channelEntities, bytesToHex(parsed.entityId), parsed);
  }
  const heads = new Map<string, { version: bigint; hash: Uint8Array }>();
  const channelHeads = foldEntities(channelEntities, heads);
  const out: Array<{ channelId: string; name: string; isPrivate: boolean }> = [];
  for (const p of channelHeads) {
    if (!metadataAuthorized(roster.roster, p.author, roster.ownerHex, Permissions.MANAGE_CHANNELS)) continue;
    try {
      const meta = JSON.parse(p.content) as ChannelMetadata;
      if (typeof meta.name === "string" && meta.name.length > 0) {
        out.push({ channelId: bytesToHex(p.entityId), name: meta.name, isPrivate: Boolean(meta.private) });
      }
    } catch {
      // skip malformed
    }
  }
  return out;
}

/** Fold the CORD banlist (vsk=4); honored only if its head signer holds BAN. */
export function foldCordBanlist(
  outers: NostrEvent[],
  community: Community,
  roster: FoldedRoster,
): FoldedBanlist {
  const groups = cordControlGroups(community);
  const eid = bytesToHex(cordBanlistLocator(community.id));
  const editions: ParsedEdition[] = [];
  for (const outer of outers) {
    const parsed = openCordControlEdition(outer, groups);
    if (!parsed) continue;
    if (parsed.vsk === VSK_BANLIST && bytesToHex(parsed.entityId) === eid) editions.push(parsed);
  }
  if (editions.length === 0) return { banned: new Set() };

  const heads = new Map<string, { version: bigint; hash: Uint8Array }>();
  const [head] = foldEntities(new Map([[eid, editions]]), heads);
  if (!head) return { banned: new Set() };
  if (!metadataAuthorized(roster.roster, head.author, roster.ownerHex, Permissions.BAN)) {
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
