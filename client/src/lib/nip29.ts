import type { NostrEvent } from "@nostrify/nostrify";

/**
 * NIP-29 (Relay-based Groups) constants and event parsing.
 * https://github.com/nostr-protocol/nips/blob/master/29.md
 */

// ── Kinds ────────────────────────────────────────────────────────────────────

/** Chat message inside a group (requires `h` tag). */
export const KIND_GROUP_CHAT = 9;
/** Thread/forum post inside a group. */
export const KIND_GROUP_THREAD = 11;

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

/** User: request to join a group. */
export const KIND_JOIN_REQUEST = 9021;
/** User: request to leave a group. */
export const KIND_LEAVE_REQUEST = 9022;

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

/** Parse a kind 10009 user-groups list into group references. */
export function parseUserGroupList(event: NostrEvent): GroupRef[] {
  if (event.kind !== KIND_USER_GROUPS) return [];
  const refs: GroupRef[] = [];
  for (const [name, id, relay] of event.tags) {
    if (name === "group" && id && relay) {
      refs.push({ id, relay });
    }
  }
  return refs;
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
