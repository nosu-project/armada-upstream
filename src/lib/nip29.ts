import type { NostrFilter } from "@nostrify/nostrify";
import type { NostrRumor } from "@/lib/nostrRumor";
import { nip19 } from "nostr-tools";

import { tryNaddrEncode } from "@/lib/safeNip19";

/** NIP-29 (Relay-based Groups) constants and event parsing. */

/** User-facing reason for a publish error: strips the NIP-01 OK machine prefix; generic fallback. */
export function relayRejectionMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const trimmed = raw.trim();
  if (!trimmed) return "The relay rejected the message.";
  const m = trimmed.match(/^(blocked|restricted|invalid|error|rate-limited|duplicate|pow):\s*(.+)$/i);
  const message = m ? m[2] : trimmed;
  return message.length > 200 ? message.slice(0, 197) + "…" : message;
}

/** NIP-09 event deletion request. */
export const KIND_DELETE = 5;
/** NIP-25 reaction to an event (requires `h` tag inside a group). */
export const KIND_REACTION = 7;
/** Chat message inside a group (requires `h` tag). */
export const KIND_GROUP_CHAT = 9;
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
 * Moderation: replace the pinned-events list. Carries the FULL list as `e`/`a`
 * tags in display order; the relay regenerates kind 39005 from it.
 */
export const KIND_UPDATE_PIN_LIST = 9010;

/**
 * NIP-52 all-day calendar event: `start`/`end` are `YYYY-MM-DD` (`end` exclusive).
 * Addressable on a random `d`; group-scoped via `h`. One event per occurrence.
 */
export const KIND_CALENDAR_DATE = 31922;
/** NIP-52 time-based calendar event: Unix-timestamp strings, optional `start_tzid`/`end_tzid`. */
export const KIND_CALENDAR_TIME = 31923;
/** NIP-52 RSVP: `a` coordinate (+ `e` when known) and a `status` tag. Group-scoped via `h`. */
export const KIND_CALENDAR_RSVP = 31925;

/**
 * Webxdc `sendUpdate()` mapped to NIP-29 (see NIP-DC / ditto's NOSTR_WEBXDC.md):
 * `h`-scoped, `i` = session UUID, JSON payload. Ordered by `created_at`.
 */
export const KIND_GROUP_WEBXDC_UPDATE = 9450;
/** Webxdc `joinRealtimeChannel()` data: ephemeral, `h`-scoped, `i` = session UUID, base64 payload. */
export const KIND_GROUP_WEBXDC_REALTIME = 24450;

/** User: request to join a group. */
export const KIND_JOIN_REQUEST = 9021;
/** User: request to leave a group. */
export const KIND_LEAVE_REQUEST = 9022;

// Relay-level membership (zooid / Coracle "relay access"): some relays gate all
// access behind relay membership separate from NIP-29 group membership. Join by
// publishing RELAY_JOIN with a `claim` minted as a RELAY_INVITE. Not NIP-29 proper.

/** User: ephemeral request to join the *relay* (carries a `claim` tag). */
export const KIND_RELAY_JOIN = 28934;
/** Relay-signed: an invite "claim" usable with KIND_RELAY_JOIN. */
export const KIND_RELAY_INVITE = 28935;
/**
 * NIP-43 relay-level membership snapshot (Buzz community roster): relay-signed,
 * one per relay (no `d`). Distinct from per-group 39001/39002. Members are
 * `["member", pk, role]` or `["p", pk, relay_url, role]`.
 */
export const KIND_RELAY_MEMBERS = 13534;

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
/** Relay-signed: pinned events in display order (addressable, `d` = group id), mirrored from kind 9010. */
export const KIND_GROUP_PINS = 39005;

/** NIP-51: user's list of groups. */
export const KIND_USER_GROUPS = 10009;

/** NIP-32 label event. Used here for per-server self-labels (nickname/label). */
export const KIND_LABEL = 1985;

// Per-server self-labels (NIP-32 kind 1985 about one's own pubkey, namespace
// `armada`, scoped by an `r` tag). A client convention, not a guarantee: the
// event is published to, queried from, and rendered for its target relay only.

/** NIP-32 label namespace for Armada self-labels. */
export const SERVER_PROFILE_NAMESPACE = "armada";
/** Label mark identifying a per-server nickname value. */
export const SERVER_NICKNAME_MARK = "armada/nickname";
/** Label mark identifying a per-server label value. */
export const SERVER_LABEL_MARK = "armada/label";
/** Label mark identifying a per-server username color (CSS hex like `#ff8800`). */
export const SERVER_COLOR_MARK = "armada/color";

/** A user's per-server self-profile (nickname + label + color) for one relay. */
export interface ServerProfile {
  relay: string;
  nickname?: string;
  label?: string;
  /** Username color (CSS hex). */
  color?: string;
}

export interface Nip29Group {
  /** Group id (the `d` tag of the kind 39000 event). */
  id: string;
  /** Relay hosting this instance of the group. */
  relay: string;
  name: string;
  picture?: string;
  banner?: string;
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
  event: NostrRumor;
}

export interface Nip29Admin {
  pubkey: string;
  roles: string[];
}

export interface Nip29Role {
  name: string;
  description?: string;
}

export interface GroupRef {
  id: string;
  relay: string;
}

/** Parsed kind 10009 (NIP-51 "Simple groups"): joined groups and servers, from public or encrypted tags. */
export interface UserGroupList {
  /** `["group", id, relay, name?]` */
  groups: GroupRef[];
  /** `["r", relayUrl]` values, normalized and deduped. */
  servers: string[];
}

export type RsvpStatus = "accepted" | "declined" | "tentative";

export interface CalendarParticipant {
  pubkey: string;
  /** Optional relay hint (tag slot 2). */
  relay?: string;
  /** Optional role, e.g. "host" / "speaker" (tag slot 3). */
  role?: string;
}

/** Parsed NIP-52 calendar event (31922/31923), group-scoped via `h`. */
export interface CalendarEvent {
  identifier: string;
  /** 31922 (all-day, date strings) or 31923 (timestamped). */
  kind: typeof KIND_CALENDAR_DATE | typeof KIND_CALENDAR_TIME;
  title: string;
  description: string;
  summary?: string;
  image?: string;
  location?: string;
  /** 31922: `YYYY-MM-DD`. 31923: Unix timestamp string. */
  start: string;
  /** End (exclusive). Optional. Same format as `start`. */
  end?: string;
  startTzid?: string;
  hashtags: string[];
  references: string[];
  participants: CalendarParticipant[];
  groupId?: string;
  event: NostrRumor;
}

export interface CalendarEventInput {
  identifier: string;
  kind: typeof KIND_CALENDAR_DATE | typeof KIND_CALENDAR_TIME;
  title: string;
  description?: string;
  summary?: string;
  image?: string;
  location?: string;
  /** 31922: `YYYY-MM-DD`. 31923: Unix-timestamp string. */
  start: string;
  end?: string;
  startTzid?: string;
  hashtags?: string[];
  references?: string[];
  participants?: CalendarParticipant[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TS_RE = /^\d+$/;

export function randomCalendarId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function calendarEventCoord(kind: number, pubkey: string, identifier: string): string {
  return `${kind}:${pubkey}:${identifier}`;
}

/** Parse a kind 31922/31923 event; undefined if not a calendar kind or missing `d`/`title`/valid `start`. */
export function parseCalendarEvent(event: NostrRumor): CalendarEvent | undefined {
  if (event.kind !== KIND_CALENDAR_DATE && event.kind !== KIND_CALENDAR_TIME) return undefined;
  const identifier = tag(event, "d")?.[1];
  const title = tag(event, "title")?.[1];
  const start = tag(event, "start")?.[1];
  if (!identifier || !title || !start) return undefined;

  if (event.kind === KIND_CALENDAR_DATE && !DATE_RE.test(start)) return undefined;
  if (event.kind === KIND_CALENDAR_TIME && !TS_RE.test(start)) return undefined;

  const end = tag(event, "end")?.[1];
  const hashtags: string[] = [];
  const references: string[] = [];
  const participants: CalendarParticipant[] = [];
  for (const [n, v, slot2, slot3] of event.tags) {
    if (n === "t" && v) hashtags.push(v);
    else if (n === "r" && v) references.push(v);
    else if (n === "p" && HEX64.test(v ?? "")) {
      participants.push({ pubkey: v, relay: slot2 || undefined, role: slot3 || undefined });
    }
  }

  return {
    identifier,
    kind: event.kind,
    title,
    description: event.content ?? "",
    summary: tag(event, "summary")?.[1],
    image: tag(event, "image")?.[1],
    location: tag(event, "location")?.[1],
    start,
    end: end || undefined,
    startTzid: tag(event, "start_tzid")?.[1],
    hashtags,
    references,
    participants,
    groupId: tag(event, "h")?.[1],
    event,
  };
}

/** NIP-52 event tags scoped to a group; the `h` tag lets relay29 route and authorize it. */
export function buildCalendarEventTags(groupId: string, input: CalendarEventInput): string[][] {
  const tags: string[][] = [
    ["d", input.identifier],
    ["h", groupId],
    ["title", input.title],
    ["start", input.start],
  ];
  if (input.end) tags.push(["end", input.end]);
  if (input.kind === KIND_CALENDAR_TIME && input.startTzid) {
    tags.push(["start_tzid", input.startTzid]);
  }
  if (input.summary) tags.push(["summary", input.summary]);
  if (input.image) tags.push(["image", input.image]);
  if (input.location) tags.push(["location", input.location]);
  for (const t of input.hashtags ?? []) {
    if (t.trim()) tags.push(["t", t.trim()]);
  }
  for (const r of input.references ?? []) {
    if (r.trim()) tags.push(["r", r.trim()]);
  }
  for (const p of input.participants ?? []) {
    if (!HEX64.test(p.pubkey)) continue;
    const t = ["p", p.pubkey, p.relay ?? ""];
    if (p.role) t.push(p.role);
    tags.push(t);
  }
  return tags;
}

export function formatCalendarEventWhen(event: CalendarEvent): string {
  if (event.kind === KIND_CALENDAR_TIME) {
    const start = new Date(Number(event.start) * 1000);
    const end = event.end ? new Date(Number(event.end) * 1000) : undefined;
    const dateFmt: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric" };
    const timeFmt: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };
    const startStr = `${start.toLocaleDateString(undefined, dateFmt)}, ${start.toLocaleTimeString(undefined, timeFmt)}`;
    if (!end) return startStr;
    const sameDay = start.toDateString() === end.toDateString();
    if (sameDay) return `${startStr} – ${end.toLocaleTimeString(undefined, timeFmt)}`;
    return `${startStr} – ${end.toLocaleDateString(undefined, dateFmt)}, ${end.toLocaleTimeString(undefined, timeFmt)}`;
  }
  // All-day: parse as UTC to avoid TZ drift.
  const dateFmt: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" };
  const start = new Date(`${event.start}T00:00:00Z`);
  const startStr = start.toLocaleDateString(undefined, dateFmt);
  if (!event.end || event.end === event.start) return `${startStr} · All day`;
  // `end` is exclusive — show the last included day.
  const endExclusive = new Date(`${event.end}T00:00:00Z`);
  endExclusive.setUTCDate(endExclusive.getUTCDate() - 1);
  if (endExclusive.toDateString() === start.toDateString()) return `${startStr} · All day`;
  return `${startStr} – ${endExclusive.toLocaleDateString(undefined, dateFmt)}`;
}

export function parseRsvpStatus(event: NostrRumor): RsvpStatus | undefined {
  if (event.kind !== KIND_CALENDAR_RSVP) return undefined;
  const status = tag(event, "status")?.[1];
  if (status === "accepted" || status === "declined" || status === "tentative") return status;
  return undefined;
}

export function parseRsvpCoord(event: NostrRumor): string | undefined {
  return tag(event, "a")?.[1];
}

/**
 * Kind 31925 RSVP tags. A stable `d` derived from the coordinate makes
 * re-RSVPing replace the prior one; `h` scopes it to the group.
 */
export function buildRsvpTags(params: {
  groupId: string;
  eventCoord: string;
  eventId?: string;
  eventAuthor?: string;
  status: RsvpStatus;
}): string[][] {
  const tags: string[][] = [
    ["a", params.eventCoord],
    ["d", `rsvp:${params.eventCoord}`],
    ["h", params.groupId],
    ["status", params.status],
  ];
  if (params.eventId && HEX64.test(params.eventId)) tags.push(["e", params.eventId]);
  if (params.eventAuthor && HEX64.test(params.eventAuthor)) tags.push(["p", params.eventAuthor]);
  return tags;
}

const HEX64 = /^[0-9a-f]{64}$/;

function tag(event: NostrRumor, name: string): string[] | undefined {
  return event.tags.find(([n]) => n === name);
}

function hasTag(event: NostrRumor, name: string): boolean {
  return event.tags.some(([n]) => n === name);
}

export function parseGroupMetadata(event: NostrRumor, relay: string): Nip29Group | undefined {
  if (event.kind !== KIND_GROUP_METADATA) return undefined;
  const id = tag(event, "d")?.[1];
  if (!id) return undefined;

  const supported = tag(event, "supported_kinds");

  return {
    id,
    relay,
    name: tag(event, "name")?.[1] || id,
    picture: tag(event, "picture")?.[1],
    banner: tag(event, "banner")?.[1],
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

// NIP-29 group identifiers: naddr of the kind-39000 metadata (pubkey = relay
// `self`, `d` = group id, relay hint). An invite rides as `?invite=<code>`;
// `?` is outside bech32, so the bare naddr stays valid.

/** A parsed group identifier (`naddr1...` with optional `?invite=` suffix). */
export interface ParsedGroupNaddr {
  groupId: string;
  /** First relay hint (not normalized). */
  relay?: string;
  inviteCode?: string;
}

/** Group naddr with optional invite; undefined when `relaySelf` isn't a valid pubkey (NIP-11 unresolved). */
export function buildGroupNaddr(params: {
  relaySelf: string;
  groupId: string;
  relay: string;
  inviteCode?: string;
}): string | undefined {
  const naddr = tryNaddrEncode({
    kind: KIND_GROUP_METADATA,
    pubkey: params.relaySelf,
    identifier: params.groupId,
    relays: [params.relay],
  });
  if (!naddr) return undefined;
  return params.inviteCode
    ? `${naddr}?invite=${encodeURIComponent(params.inviteCode)}`
    : naddr;
}

/**
 * Parse `naddr1…` / `nostr:naddr1…` with optional `?invite=`. Undefined unless it
 * points at a kind-39000 coordinate. Unknown suffixes are ignored, per spec.
 */
export function parseGroupNaddr(input: string): ParsedGroupNaddr | undefined {
  let value = input.trim();
  if (value.toLowerCase().startsWith("nostr:")) value = value.slice("nostr:".length);

  let inviteCode: string | undefined;
  const q = value.indexOf("?");
  if (q !== -1) {
    const suffix = value.slice(q + 1);
    value = value.slice(0, q);
    inviteCode = new URLSearchParams(suffix).get("invite") || undefined;
  }

  try {
    const decoded = nip19.decode(value);
    if (decoded.type !== "naddr") return undefined;
    if (decoded.data.kind !== KIND_GROUP_METADATA) return undefined;
    return {
      groupId: decoded.data.identifier,
      relay: decoded.data.relays?.[0],
      inviteCode,
    };
  } catch {
    return undefined;
  }
}

/**
 * Local-cache filters for one relay's kind-39000 metadata. MUST be relay-scoped
 * (all servers share one cache): by `authors: [relaySelf]` when known, else by
 * the group ids remembered for this relay, else no filters at all.
 */
export function relayGroupCacheFilters(
  relaySelf: string | undefined,
  rememberedIds: string[],
): NostrFilter[] {
  if (relaySelf) return [{ kinds: [KIND_GROUP_METADATA], authors: [relaySelf] }];
  if (rememberedIds.length > 0) return [{ kinds: [KIND_GROUP_METADATA], "#d": rememberedIds }];
  return [];
}

/**
 * Dedupe kind-39000 events by `d` (newest wins) into a name-sorted channel list.
 * Staleness is decided by `reconcileRelayGroups`.
 */
export function buildRelayGroups(events: NostrRumor[], relay: string): Nip29Group[] {
  const groups = new Map<string, Nip29Group>();
  for (const event of events) {
    const group = parseGroupMetadata(event, relay);
    if (!group) continue;
    const existing = groups.get(group.id);
    if (!existing || existing.event.created_at < event.created_at) {
      groups.set(group.id, group);
    }
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Reconcile cached channels against a live read. A non-empty `live` is
 * authoritative (cached copies still compete on `created_at`); unnamed cached
 * channels go in `stale`. An empty `live` is ambiguous (no channels, cold pool,
 * AUTH-gated), so the cache stays and nothing is stale.
 */
export function reconcileRelayGroups(
  cached: NostrRumor[],
  live: NostrRumor[],
  relay: string,
): { groups: Nip29Group[]; stale: string[] } {
  if (live.length === 0) {
    return { groups: buildRelayGroups(cached, relay), stale: [] };
  }
  const liveIds = new Set(buildRelayGroups(live, relay).map((g) => g.id));
  const stale: string[] = [];
  const kept: NostrRumor[] = [];
  for (const group of buildRelayGroups(cached, relay)) {
    if (liveIds.has(group.id)) kept.push(group.event);
    else stale.push(group.id);
  }
  return { groups: buildRelayGroups([...kept, ...live], relay), stale };
}

export function parseGroupAdmins(event: NostrRumor): Nip29Admin[] {
  if (event.kind !== KIND_GROUP_ADMINS) return [];
  return event.tags
    .filter(([n, v]) => n === "p" && HEX64.test(v ?? ""))
    .map(([, pubkey, ...roles]) => ({ pubkey, roles: roles.filter(Boolean) }));
}

export function parseGroupMembers(event: NostrRumor): string[] {
  if (event.kind !== KIND_GROUP_MEMBERS) return [];
  return event.tags
    .filter(([n, v]) => n === "p" && HEX64.test(v ?? ""))
    .map(([, pubkey]) => pubkey);
}

/** Per-member roles from kind 39002: Buzz puts the role in the last slot; plain NIP-29 yields `{}`. */
export function parseGroupMemberRoles(event: NostrRumor): Record<string, string> {
  if (event.kind !== KIND_GROUP_MEMBERS) return {};
  const out: Record<string, string> = {};
  for (const [n, pubkey, ...rest] of event.tags) {
    if (n !== "p" || !HEX64.test(pubkey ?? "")) continue;
    const role = rest.filter(Boolean).pop();
    if (role) out[pubkey] = role;
  }
  return out;
}

/**
 * Kind 13534 NIP-43 snapshot → `pubkey → role`. Unknown/missing roles default
 * to `member` (Buzz). Case-insensitive; first tag per pubkey wins.
 */
export function parseRelayMemberRoles(event: NostrRumor): Record<string, string> {
  if (event.kind !== KIND_RELAY_MEMBERS) return {};
  const out: Record<string, string> = {};
  for (const tag of event.tags) {
    const [name] = tag;
    if (name !== "member" && name !== "p") continue;
    const pubkey = (tag[1] ?? "").toLowerCase();
    if (!HEX64.test(pubkey) || out[pubkey]) continue;
    // `member` tags: role at index 2; NIP-29 `p` tags: relay_url at 2, role at 3.
    const raw = (name === "member" ? tag[2] : tag[3])?.toLowerCase();
    out[pubkey] = raw === "owner" || raw === "admin" ? raw : "member";
  }
  return out;
}

export function parseGroupRoles(event: NostrRumor): Nip29Role[] {
  if (event.kind !== KIND_GROUP_ROLES) return [];
  return event.tags
    .filter(([n, v]) => n === "role" && Boolean(v))
    .map(([, name, description]) => ({ name, description }));
}

export function parseGroupParticipants(event: NostrRumor): string[] {
  if (event.kind !== KIND_GROUP_PARTICIPANTS) return [];
  return event.tags
    .filter(([n, v]) => n === "participant" && HEX64.test(v ?? ""))
    .map(([, pubkey]) => pubkey);
}

/** `a` pin ref `kind:pubkey:d`; `d` may contain colons. */
const ADDR_PIN = /^(\d+):([0-9a-f]{64}):(.*)$/;

export interface PinAddr {
  kind: number;
  pubkey: string;
  identifier: string;
}

/** Address coordinates from a pin ref, or undefined for event-id pins. */
export function parseAddrPinRef(ref: string): PinAddr | undefined {
  const m = ADDR_PIN.exec(ref);
  if (!m) return undefined;
  const kind = Number(m[1]);
  if (!Number.isInteger(kind)) return undefined;
  return { kind, pubkey: m[2], identifier: m[3] };
}

/**
 * Ordered, deduped pin refs (`e` ids, `a` coordinates) in display order. Accepts
 * kind 39005 and kind 9010 (for optimistic updates).
 */
export function parseGroupPins(event: NostrRumor): string[] {
  if (event.kind !== KIND_GROUP_PINS && event.kind !== KIND_UPDATE_PIN_LIST) {
    return [];
  }
  const refs: string[] = [];
  const seen = new Set<string>();
  for (const [n, v] of event.tags) {
    if (!v || seen.has(v)) continue;
    if ((n === "e" && HEX64.test(v)) || (n === "a" && ADDR_PIN.test(v))) {
      seen.add(v);
      refs.push(v);
    }
  }
  return refs;
}

/** Kind 9010 tags: the FULL replacement pin list in display order, `h`-scoped. */
export function buildGroupPinsTags(groupId: string, pinnedRefs: string[]): string[][] {
  const tags: string[][] = [["h", groupId]];
  const seen = new Set<string>();
  for (const ref of pinnedRefs) {
    if (seen.has(ref)) continue;
    if (HEX64.test(ref)) {
      seen.add(ref);
      tags.push(["e", ref]);
    } else if (ADDR_PIN.test(ref)) {
      seen.add(ref);
      tags.push(["a", ref]);
    }
  }
  return tags;
}

/** Parse kind 10009 tags (public or decrypted) into joined groups and servers. */
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

/** Build kind 10009 tags: servers (`r`) then groups (with host relay), preserving input order. */
export function buildGroupListTags(list: UserGroupList): string[][] {
  return [
    ...list.servers.map((url) => ["r", url]),
    ...list.groups.map((g) => ["group", g.id, g.relay]),
  ];
}

function groupListItemKey(tag: string[]): string | undefined {
  if (tag[0] === "group" && tag[1] && tag[2]) return `g\u0000${tag[1]}\u0000${tag[2]}`;
  if (tag[0] === "r" && tag[1]) return `r\u0000${tag[1]}`;
  return undefined;
}

/**
 * Rebuild a kind 10009's public tags and private items for `next` (NIP-51). An item
 * stays where it was, public or private, with its original tag (a group's optional
 * name included); only new items take `newItemsPrivate`. Non-item tags stay in
 * their own section untouched.
 */
export function buildGroupListSections(
  prevPublic: string[][],
  prevPrivate: string[][],
  next: UserGroupList,
  newItemsPrivate: boolean,
): { publicTags: string[][]; privateTags: string[][] } {
  const placed = new Map<string, { tag: string[]; isPrivate: boolean }>();
  const others = { public: [] as string[][], private: [] as string[][] };
  for (const [section, tags] of [["public", prevPublic], ["private", prevPrivate]] as const) {
    for (const tag of tags) {
      const key = groupListItemKey(tag);
      if (!key) others[section].push(tag);
      else if (!placed.has(key)) placed.set(key, { tag, isPrivate: section === "private" });
    }
  }

  const publicTags = [...others.public];
  const privateTags = [...others.private];
  for (const tag of buildGroupListTags(next)) {
    const prev = placed.get(groupListItemKey(tag)!);
    const isPrivate = prev ? prev.isPrivate : newItemsPrivate;
    (isPrivate ? privateTags : publicTags).push(prev?.tag ?? tag);
  }
  return { publicTags, privateTags };
}

/**
 * Parse a kind-1985 Armada per-server self-label by `pubkey` for `relay`, else undefined.
 * Shape: `["L","armada"]`, `["l",value,"armada/nickname"|"armada/label"|"armada/color"]`,
 * `["p",pubkey]`, `["r",relay]`.
 */
export function parseServerProfile(
  event: NostrRumor,
  pubkey: string,
  relay: string,
): ServerProfile | undefined {
  if (event.kind !== KIND_LABEL) return undefined;
  if (event.pubkey !== pubkey) return undefined;

  const namespaces = event.tags.filter(([n]) => n === "L").map(([, v]) => v);
  if (!namespaces.includes(SERVER_PROFILE_NAMESPACE)) return undefined;

  const targetsSelf = event.tags.some(([n, v]) => n === "p" && v === pubkey);
  if (!targetsSelf) return undefined;

  const scopedToRelay = event.tags.some(([n, v]) => n === "r" && v === relay);
  if (!scopedToRelay) return undefined;

  let nickname: string | undefined;
  let label: string | undefined;
  let color: string | undefined;
  for (const [n, value, mark] of event.tags) {
    if (n !== "l") continue;
    if (mark === SERVER_NICKNAME_MARK && value) nickname = value;
    else if (mark === SERVER_LABEL_MARK && value) label = value;
    else if (mark === SERVER_COLOR_MARK && isHexColor(value)) color = value;
  }

  if (nickname === undefined && label === undefined && color === undefined) return undefined;
  return { relay, nickname, label, color };
}

export function isHexColor(value: string | undefined): value is string {
  return typeof value === "string" && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value);
}

/** Kind 1985 self-label tags; blank values are omitted so clearing removes them. */
export function buildServerProfileTags(
  pubkey: string,
  relay: string,
  profile: { nickname?: string; label?: string; color?: string },
): string[][] {
  const tags: string[][] = [
    ["L", SERVER_PROFILE_NAMESPACE],
    ["p", pubkey],
    ["r", relay],
  ];
  const nickname = profile.nickname?.trim();
  const label = profile.label?.trim();
  const color = profile.color?.trim();
  if (nickname) tags.push(["l", nickname, SERVER_NICKNAME_MARK]);
  if (label) tags.push(["l", label, SERVER_LABEL_MARK]);
  if (isHexColor(color)) tags.push(["l", color, SERVER_COLOR_MARK]);
  return tags;
}

/**
 * NIP-22 tags for a kind-1111 reply inside a group: uppercase `K`/`E`/`P` pin
 * the thread root (inherited from a comment parent, as Flotilla/@welshman do),
 * lowercase point at the immediate parent; `h` scopes it to the group.
 */
export function buildCommentTags(parent: NostrRumor, groupId: string): string[][] {
  const tags: string[][] = [["h", groupId]];

  const rootTags = parent.tags.filter(([n]) => n === "K" || n === "E" || n === "P");
  if (rootTags.length > 0) {
    for (const t of rootTags) tags.push([...t]);
  } else {
    tags.push(["K", String(parent.kind)]);
    tags.push(["E", parent.id, "", parent.pubkey]);
    tags.push(["P", parent.pubkey]);
  }

  tags.push(["k", String(parent.kind)]);
  tags.push(["e", parent.id, "", parent.pubkey]);
  tags.push(["p", parent.pubkey]);

  return tags;
}
