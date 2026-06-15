import type { NostrEvent } from "@nostrify/nostrify";

/**
 * NIP-29 (Relay-based Groups) constants and event parsing.
 * https://github.com/nostr-protocol/nips/blob/master/29.md
 */

// ── Kinds ────────────────────────────────────────────────────────────────────

/** NIP-09 event deletion request. */
export const KIND_DELETE = 5;
/** NIP-25 reaction to an event (requires `h` tag inside a group). */
export const KIND_REACTION = 7;
/** Chat message inside a group (requires `h` tag). */
export const KIND_GROUP_CHAT = 9;
/** Thread/forum post inside a group. */
export const KIND_GROUP_THREAD = 11;
/** NIP-22 comment — used here as a threaded reply to a chat message. */
export const KIND_COMMENT = 1111;

/** Moderation: add user / set roles. */
export const KIND_PUT_USER = 9000;
/** Moderation: remove user. */
export const KIND_REMOVE_USER = 9001;
/** Moderation: edit group metadata. */
export const KIND_EDIT_METADATA = 9002;
/** Moderation: delete an event. */
export const KIND_DELETE_EVENT = 9005;
/** Moderation: create group. */
export const KIND_CREATE_GROUP = 9007;
/** Moderation: delete group. */
export const KIND_DELETE_GROUP = 9008;
/** Moderation: create invite code. */
export const KIND_CREATE_INVITE = 9009;

/**
 * Armada extension: a group's set of pinned messages. Addressable
 * (`d` = group id) so the newest event per group is the authoritative list.
 * Each pinned message is an `e` tag; the relay restricts writes to admins.
 * Not part of NIP-29 proper.
 */
export const KIND_GROUP_PINS = 39041;

/** User: request to join a group. */
export const KIND_JOIN_REQUEST = 9021;
/** User: request to leave a group. */
export const KIND_LEAVE_REQUEST = 9022;

// ── Relay membership (zooid / Coracle "relay access", NIP-43-ish) ────────────
//
// Some community relays (e.g. zooid, which backs Flotilla/Soapbox) gate ALL
// reads and writes behind *relay-level* membership, separate from per-group
// NIP-29 membership. A non-member is rejected with "restricted: you are not a
// member of this relay" before any group join is even considered. To become a
// relay member you publish an ephemeral RELAY_JOIN carrying a `claim` tag whose
// value was minted by the relay as a RELAY_INVITE event. These kinds are not
// part of NIP-29 proper; they are the de-facto Coracle/zooid relay-access
// protocol that we implement for cross-relay interop.

/** User: ephemeral request to join the *relay* (carries a `claim` tag). */
export const KIND_RELAY_JOIN = 28934;
/** Relay-signed: an invite "claim" usable with KIND_RELAY_JOIN. */
export const KIND_RELAY_INVITE = 28935;
/** User: ephemeral request to leave the *relay*. */
export const KIND_RELAY_LEAVE = 28936;

/** Relay-signed: group metadata (addressable, `d` = group id). */
export const KIND_GROUP_METADATA = 39000;
/** Relay-signed: group admins. */
export const KIND_GROUP_ADMINS = 39001;
/** Relay-signed: group members. */
export const KIND_GROUP_MEMBERS = 39002;
/** Relay-signed: roles supported by the group. */
export const KIND_GROUP_ROLES = 39003;
/** Relay-signed: live AV room participants. */
export const KIND_GROUP_PARTICIPANTS = 39004;

/** NIP-51: user's list of groups. */
export const KIND_USER_GROUPS = 10009;

// ── Types ────────────────────────────────────────────────────────────────────

export interface Nip29Group {
  /** Group id (the `d` tag of the kind 39000 event). */
  id: string;
  /** Relay websocket URL hosting this instance of the group. */
  relay: string;
  name: string;
  picture?: string;
  about?: string;
  /** Only members can read. */
  isPrivate: boolean;
  /** Only members can write. */
  isRestricted: boolean;
  /** Metadata hidden from non-members. */
  isHidden: boolean;
  /** Join requests are ignored (invite-only). */
  isClosed: boolean;
  /** Group supports LiveKit-powered live audio/video. */
  hasLivekit: boolean;
  /** Supported kinds, when restricted. `undefined` = all kinds. */
  supportedKinds?: number[];
  /** The raw kind 39000 event. */
  event: NostrEvent;
}

export interface Nip29Admin {
  pubkey: string;
  roles: string[];
}

export interface Nip29Role {
  name: string;
  description?: string;
}

/** A group reference stored in the user's kind 10009 list. */
export interface GroupRef {
  id: string;
  relay: string;
}

/**
 * The fully-parsed kind 10009 list (NIP-51 "Simple groups"): the user's joined
 * groups (`group` tags) and the servers/relays they use (`r` tags). Both can
 * appear in the public tags or the NIP-44-encrypted private tags.
 */
export interface UserGroupList {
  /** Joined groups: `["group", id, relay, name?]`. */
  groups: GroupRef[];
  /** Servers in use: `["r", relayUrl]`. Normalized, de-duplicated. */
  servers: string[];
}

// ── Parsing ──────────────────────────────────────────────────────────────────

const HEX64 = /^[0-9a-f]{64}$/;

function tag(event: NostrEvent, name: string): string[] | undefined {
  return event.tags.find(([n]) => n === name);
}

function hasTag(event: NostrEvent, name: string): boolean {
  return event.tags.some(([n]) => n === name);
}

/** Parse a kind 39000 group-metadata event. Returns undefined when malformed. */
export function parseGroupMetadata(event: NostrEvent, relay: string): Nip29Group | undefined {
  if (event.kind !== KIND_GROUP_METADATA) return undefined;
  const id = tag(event, "d")?.[1];
  if (!id) return undefined;

  const supported = tag(event, "supported_kinds");

  return {
    id,
    relay,
    name: tag(event, "name")?.[1] || id,
    picture: tag(event, "picture")?.[1],
    about: tag(event, "about")?.[1],
    isPrivate: hasTag(event, "private"),
    isRestricted: hasTag(event, "restricted"),
    isHidden: hasTag(event, "hidden"),
    isClosed: hasTag(event, "closed"),
    hasLivekit: hasTag(event, "livekit"),
    supportedKinds: supported
      ? supported.slice(1).map(Number).filter((n) => Number.isInteger(n))
      : undefined,
    event,
  };
}

/** Parse a kind 39001 group-admins event into a list of admins with roles. */
export function parseGroupAdmins(event: NostrEvent): Nip29Admin[] {
  if (event.kind !== KIND_GROUP_ADMINS) return [];
  return event.tags
    .filter(([n, v]) => n === "p" && HEX64.test(v ?? ""))
    .map(([, pubkey, ...roles]) => ({ pubkey, roles: roles.filter(Boolean) }));
}

/** Parse a kind 39002 group-members event into a list of pubkeys. */
export function parseGroupMembers(event: NostrEvent): string[] {
  if (event.kind !== KIND_GROUP_MEMBERS) return [];
  return event.tags
    .filter(([n, v]) => n === "p" && HEX64.test(v ?? ""))
    .map(([, pubkey]) => pubkey);
}

/** Parse a kind 39003 group-roles event. */
export function parseGroupRoles(event: NostrEvent): Nip29Role[] {
  if (event.kind !== KIND_GROUP_ROLES) return [];
  return event.tags
    .filter(([n, v]) => n === "role" && Boolean(v))
    .map(([, name, description]) => ({ name, description }));
}

/** Parse a kind 39004 livekit-participants event into a list of pubkeys. */
export function parseGroupParticipants(event: NostrEvent): string[] {
  if (event.kind !== KIND_GROUP_PARTICIPANTS) return [];
  return event.tags
    .filter(([n, v]) => n === "participant" && HEX64.test(v ?? ""))
    .map(([, pubkey]) => pubkey);
}

/**
 * Parse a kind 39041 group-pins event into the list of pinned message ids,
 * newest-pinned first (the order the admin pinned them — preserved as authored).
 */
export function parseGroupPins(event: NostrEvent): string[] {
  if (event.kind !== KIND_GROUP_PINS) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const [n, v] of event.tags) {
    if (n === "e" && HEX64.test(v ?? "") && !seen.has(v)) {
      seen.add(v);
      ids.push(v);
    }
  }
  return ids;
}

/** Build the tags for a kind 39041 group-pins event from a list of message ids. */
export function buildGroupPinsTags(groupId: string, pinnedIds: string[]): string[][] {
  const tags: string[][] = [["d", groupId], ["h", groupId]];
  const seen = new Set<string>();
  for (const id of pinnedIds) {
    if (HEX64.test(id) && !seen.has(id)) {
      seen.add(id);
      tags.push(["e", id]);
    }
  }
  return tags;
}

/** Parse a kind 10009 user-groups list into group references (public tags only). */
export function parseUserGroupList(event: NostrEvent): GroupRef[] {
  if (event.kind !== KIND_USER_GROUPS) return [];
  return parseGroupListTags(event.tags).groups;
}

/**
 * Parse a set of kind 10009 tags (public or decrypted-private) into the full
 * list of joined groups and servers. Per NIP-51, the "Simple groups" list
 * carries `["group", id, relay, name?]` and `["r", relayUrl]` items.
 */
export function parseGroupListTags(tags: string[][]): UserGroupList {
  const groups: GroupRef[] = [];
  const servers: string[] = [];
  const seenGroups = new Set<string>();
  const seenServers = new Set<string>();

  for (const [name, a, b] of tags) {
    if (name === "group" && a && b) {
      const key = `${a}\u0000${b}`;
      if (!seenGroups.has(key)) {
        seenGroups.add(key);
        groups.push({ id: a, relay: b });
      }
    } else if (name === "r" && a) {
      if (!seenServers.has(a)) {
        seenServers.add(a);
        servers.push(a);
      }
    }
  }

  return { groups, servers };
}

/**
 * Build the kind 10009 tag list from groups + servers. Group tags carry the
 * host relay so the group can be located; server tags (`r`) list each relay in
 * use (NIP-51). Items are emitted in chronological order (servers first, then
 * groups) — callers preserve ordering by passing the existing arrays through.
 */
export function buildGroupListTags(list: UserGroupList): string[][] {
  return [
    ...list.servers.map((url) => ["r", url]),
    ...list.groups.map((g) => ["group", g.id, g.relay]),
  ];
}

/** Get the group id (`h` tag) of a group-scoped event. */
export function getGroupId(event: NostrEvent): string | undefined {
  return tag(event, "h")?.[1];
}

/**
 * Build NIP-29 timeline references (`previous` tag values): the first 8 hex
 * chars of recently-seen events in the group, excluding the user's own.
 */
export function buildPreviousRefs(events: NostrEvent[], selfPubkey: string | undefined, count = 3): string[] {
  const pool = events
    .filter((e) => e.pubkey !== selfPubkey)
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, 50);
  const picked = new Set<string>();
  for (const event of pool) {
    picked.add(event.id.slice(0, 8));
    if (picked.size >= count) break;
  }
  return [...picked];
}

/**
 * Build the NIP-22 tags for a kind-1111 comment replying to `parent` inside a
 * NIP-29 group. The uppercase `K`/`E`/`P` tags pin the immutable *thread root*;
 * the lowercase `k`/`e`/`p` tags point at the *immediate parent*. When the
 * parent is itself a comment, its uppercase root tags are inherited so the root
 * is stable at any nesting depth (matching Flotilla / @welshman). The group `h`
 * tag is kept so the NIP-29 relay scopes and authorizes the reply.
 *
 * https://github.com/nostr-protocol/nips/blob/master/22.md
 */
export function buildCommentTags(parent: NostrEvent, groupId: string): string[][] {
  const tags: string[][] = [["h", groupId]];

  const rootTags = parent.tags.filter(([n]) => n === "K" || n === "E" || n === "P");
  if (rootTags.length > 0) {
    // Parent is itself a comment: inherit its root pointer verbatim.
    for (const t of rootTags) tags.push([...t]);
  } else {
    // Parent is the root of this thread.
    tags.push(["K", String(parent.kind)]);
    tags.push(["E", parent.id, "", parent.pubkey]);
    tags.push(["P", parent.pubkey]);
  }

  // Immediate-parent pointer (always the event being replied to).
  tags.push(["k", String(parent.kind)]);
  tags.push(["e", parent.id, "", parent.pubkey]);
  tags.push(["p", parent.pubkey]);

  return tags;
}

/** The thread-root event id a comment belongs to (its uppercase `E` tag). */
export function getCommentRootId(event: NostrEvent): string | undefined {
  return tag(event, "E")?.[1];
}

/** The immediate parent event id a comment replies to (its lowercase `e` tag). */
export function getCommentParentId(event: NostrEvent): string | undefined {
  return tag(event, "e")?.[1];
}
