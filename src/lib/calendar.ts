/**
 * Transport-agnostic NIP-52 calendar logic, shared by the NIP-29 relay path and
 * the Concord v2 sealed-rumor path (CORD.md "Calendar Events").
 *
 * The pure NIP-52 primitives (parsing, kinds, types, when-formatting) live in
 * `nip29.ts` and are re-exported here so both transports import one surface.
 * Everything genuinely shared-but-not-yet-extracted — the group-independent tag
 * builder, the addressable dedup, the RSVP tally — is defined here, mirroring
 * `polls.ts`: only WHERE events/RSVPs come from (a relay query vs the sealed
 * chat fold) and how they're published differs; the math agrees bit-for-bit.
 */

import type { NostrEvent } from "@nostrify/nostrify";

import {
  type CalendarEvent,
  type CalendarEventInput,
  KIND_CALENDAR_TIME,
  parseCalendarEvent,
  type RsvpStatus,
} from "@/lib/nip29";

export {
  KIND_CALENDAR_DATE,
  KIND_CALENDAR_TIME,
  KIND_CALENDAR_RSVP,
  randomCalendarId,
  parseCalendarEvent,
  parseRsvpStatus,
  formatCalendarEventWhen,
  calendarEventCoord,
} from "@/lib/nip29";
export type { CalendarEvent, CalendarEventInput, CalendarParticipant, RsvpStatus } from "@/lib/nip29";

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Build the NIP-52 tags for a calendar event (kind 31922/31923), WITHOUT any
 * transport binding — each transport prepends its own (NIP-29 an `h` group tag,
 * Concord the sealed `channel`/`epoch`). Mirrors `buildPollTags`.
 */
export function buildCalendarTags(input: CalendarEventInput): string[][] {
  const tags: string[][] = [
    ["d", input.identifier],
    ["title", input.title],
    ["start", input.start],
  ];
  if (input.end) tags.push(["end", input.end]);
  if (input.kind === KIND_CALENDAR_TIME && input.startTzid) tags.push(["start_tzid", input.startTzid]);
  if (input.summary) tags.push(["summary", input.summary]);
  if (input.image) tags.push(["image", input.image]);
  if (input.location) tags.push(["location", input.location]);
  for (const t of input.hashtags ?? []) if (t.trim()) tags.push(["t", t.trim()]);
  for (const r of input.references ?? []) if (r.trim()) tags.push(["r", r.trim()]);
  for (const p of input.participants ?? []) {
    if (!HEX64.test(p.pubkey)) continue;
    const t = ["p", p.pubkey, p.relay ?? ""];
    if (p.role) t.push(p.role);
    tags.push(t);
  }
  return tags;
}

/** Sort key for a calendar event: its start as an epoch second. */
export function startEpoch(e: CalendarEvent): number {
  if (e.kind === KIND_CALENDAR_TIME) return Number(e.start) || 0;
  // Date-based: parse YYYY-MM-DD as UTC midnight.
  const ms = Date.parse(`${e.start}T00:00:00Z`);
  return Number.isNaN(ms) ? 0 : Math.floor(ms / 1000);
}

/** End of an event in epoch seconds, falling back to its start. */
export function endEpoch(e: CalendarEvent): number {
  if (!e.end) return startEpoch(e);
  if (e.kind === KIND_CALENDAR_TIME) return Number(e.end) || startEpoch(e);
  const ms = Date.parse(`${e.end}T00:00:00Z`);
  return Number.isNaN(ms) ? startEpoch(e) : Math.floor(ms / 1000);
}

/** True if the event has not yet ended (upcoming or in progress). */
export function isUpcoming(e: CalendarEvent, now = Math.floor(Date.now() / 1000)): boolean {
  return endEpoch(e) >= now;
}

/**
 * Parse a batch of calendar-kind events into {@link CalendarEvent}s: keep the
 * newest per addressable coordinate (`kind:pubkey:d`), drop malformed ones, and
 * sort soonest-first. Shared by the relay query and the sealed-fold adapter.
 */
export function parseCalendarEvents(events: NostrEvent[]): CalendarEvent[] {
  const newest = new Map<string, NostrEvent>();
  for (const event of events) {
    const d = event.tags.find(([n]) => n === "d")?.[1] ?? "";
    const coord = `${event.kind}:${event.pubkey}:${d}`;
    const existing = newest.get(coord);
    if (!existing || existing.created_at < event.created_at) newest.set(coord, event);
  }
  const parsed: CalendarEvent[] = [];
  for (const event of newest.values()) {
    const c = parseCalendarEvent(event);
    if (c) parsed.push(c);
  }
  parsed.sort((a, b) => startEpoch(a) - startEpoch(b));
  return parsed;
}

// ── RSVP tally ───────────────────────────────────────────────────────────────

/** A single member's RSVP, normalized off the underlying event/rumor shape. */
export interface RsvpVote {
  pubkey: string;
  status: RsvpStatus;
  /** Ordering timestamp in epoch milliseconds — latest per pubkey wins. */
  ms: number;
}

/** The tallied RSVPs for one event. */
export interface RsvpTally {
  accepted: string[];
  declined: string[];
  tentative: string[];
  /** The current user's latest status, if they've RSVP'd. */
  mine?: RsvpStatus;
}

/**
 * Tally a batch of RSVPs: the latest RSVP per pubkey wins (by ms), bucketed by
 * status, with the current user's own status surfaced. Pure and deterministic,
 * so every member folds the same attendee lists.
 */
export function tallyRsvps(votes: RsvpVote[], selfPubkey: string | undefined): RsvpTally {
  const latest = new Map<string, RsvpVote>();
  for (const vote of votes) {
    const existing = latest.get(vote.pubkey);
    if (!existing || vote.ms > existing.ms) latest.set(vote.pubkey, vote);
  }
  const out: RsvpTally = { accepted: [], declined: [], tentative: [] };
  for (const vote of latest.values()) {
    out[vote.status].push(vote.pubkey);
    if (selfPubkey && vote.pubkey === selfPubkey) out.mine = vote.status;
  }
  return out;
}

// ── Transport contract ───────────────────────────────────────────────────────

/**
 * The capability surface the shared calendar UI (bar, detail dialog, RSVP
 * controls, create dialog) consumes — the calendar analog of `ChatTransport`.
 * NIP-29 relays and Concord's sealed streams each implement it, so both render
 * through exactly the same components.
 */
export interface CalendarTransport {
  /** The channel's events, soonest-first. */
  events: CalendarEvent[];
  /** Whether the current user may create/delete events. */
  canModerate: boolean;
  /** Whether the current user may RSVP (membership / write access). */
  canRsvp: boolean;
  /** Whether a create/edit publish is in flight. */
  isSaving: boolean;
  /** Whether an RSVP publish is in flight. */
  isSettingRsvp: boolean;
  /** Create a new event (or, for addressable transports, replace `prev`). */
  save: (input: CalendarEventInput, prev?: NostrEvent) => Promise<void>;
  /** Delete an event (author always; others require moderation). */
  remove: (event: CalendarEvent) => Promise<void>;
  /** The resolved RSVP tally for one event (precomputed; no I/O). */
  rsvpsFor: (event: CalendarEvent) => RsvpTally;
  /** Set the current user's RSVP for an event. */
  setRsvp: (event: CalendarEvent, status: RsvpStatus) => void;
}
