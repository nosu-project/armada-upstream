/**
 * Which senders' media a reader's client loads without asking. Anyone holding a
 * community's key can post (CORD-04 §1) and keys are free, so a per-key remedy
 * (mute, Banlist) always trails a spammer. This gates on TRUST instead: media from
 * an author the reader has no reason to trust is not fetched at all — no request,
 * no blurhash, no unfurl — until the reader asks for it. A render rule only;
 * nothing is dropped.
 *
 * Separately, a URL on a host the viewer doesn't know is held whoever sent it
 * (`holdsMediaUrl`, `lib/knownMediaHosts.ts`).
 *
 * An author's media loads when they are the reader, staff, followed by the reader,
 * reached by the fold's earned-trust graph (`floodVerdict`), or ESTABLISHED: first
 * observed by THIS client at least {@link MEDIA_PROBATION_MS} ago. Observation time
 * is the local clock, not `created_at`, so a backdated message can't age its key —
 * except while a channel is first being read ({@link MEDIA_SEED_GRACE_MS}), when
 * its existing history is all there is to go on.
 */
import { KvPrefixCache } from "@/lib/db/kvCache";
import { isKnownMediaHost } from "@/lib/knownMediaHosts";

/** How long a newly observed author's media stays held. */
export const MEDIA_PROBATION_MS = 24 * 3_600_000;
/**
 * The same for their avatar and banner. Shorter: a held picture costs every
 * newcomer their face, where held media costs only a tap.
 */
export const AVATAR_PROBATION_MS = 3_600_000;
/**
 * After this client first reads a channel, observations keep their own timestamp
 * for this long (its history arriving); afterwards an unseen author is new NOW.
 */
export const MEDIA_SEED_GRACE_MS = 5 * 60_000;
/** Authors kept per community; the OLDEST win, so overflow can only hold, never release. */
export const MEDIA_SIGHTINGS_MAX_AUTHORS = 5000;

export type MediaAutoload = "always" | "trusted" | "never";

/** One community's observation record. */
export interface Sightings {
  v: 1;
  /** channel id → when this client first read it (ms). */
  channels: Record<string, number>;
  /** author → when this client first observed them speak (ms). */
  authors: Record<string, number>;
}

/**
 * Fold one channel's observed authors into `prev`. Returns the new record, or
 * `undefined` when nothing changed. A stamp only ever moves earlier.
 */
export function noteSightings(
  prev: Sightings | undefined,
  channelIdHex: string,
  observed: Iterable<readonly [author: string, ms: number]>,
  now: number,
): Sightings | undefined {
  const channelSince = prev?.channels[channelIdHex];
  const seeding = channelSince === undefined || now - channelSince < MEDIA_SEED_GRACE_MS;
  let authors: Record<string, number> | undefined;
  for (const [author, ms] of observed) {
    const stamp = seeding ? Math.min(ms, now) : now;
    const current = (authors ?? prev?.authors)?.[author];
    if (current !== undefined && current <= stamp) continue;
    authors ??= { ...prev?.authors };
    authors[author] = stamp;
  }
  if (!authors && channelSince !== undefined) return undefined;
  const channels = channelSince === undefined ? { ...prev?.channels, [channelIdHex]: now } : prev!.channels;
  return { v: 1, channels, authors: capAuthors(authors ?? prev?.authors ?? {}) };
}

function capAuthors(authors: Record<string, number>): Record<string, number> {
  const entries = Object.entries(authors);
  if (entries.length <= MEDIA_SIGHTINGS_MAX_AUTHORS) return authors;
  entries.sort((a, b) => a[1] - b[1]);
  return Object.fromEntries(entries.slice(0, MEDIA_SIGHTINGS_MAX_AUTHORS));
}

export interface MediaHoldInputs {
  mode: MediaAutoload;
  self?: string;
  isStaff?: (author: string) => boolean;
  /** The fold's earned-trust set. */
  trusted?: ReadonlySet<string>;
  follows?: ReadonlySet<string>;
  /** Unread (not warm yet) holds everyone not otherwise trusted. */
  sightings?: Sightings;
  now: number;
}

function untrusted(author: string, i: MediaHoldInputs, probationMs: number): boolean {
  if (i.isStaff?.(author) || i.trusted?.has(author) || i.follows?.has(author)) return false;
  const seen = i.sightings?.authors[author];
  return seen === undefined || i.now - seen < probationMs;
}

/** Whether `author`'s media must wait for the reader to load it. */
export function holdsMedia(author: string, i: MediaHoldInputs): boolean {
  if (author === i.self) return false;
  if (i.mode === "always") return false;
  if (i.mode === "never") return true;
  return untrusted(author, i, MEDIA_PROBATION_MS);
}

/**
 * Whether `author`'s profile picture and banner are withheld (initials instead).
 * `never` applies the trusted rule here: holding every avatar would leave no faces.
 */
export function holdsAvatar(author: string, i: MediaHoldInputs): boolean {
  if (author === i.self || i.mode === "always") return false;
  return untrusted(author, i, AVATAR_PROBATION_MS);
}

/**
 * Whether one media URL waits for "Load" because of where it is hosted, however
 * trusted its sender. Independent of the sender mode; never the reader's own, and
 * never behind a media proxy, which already keeps the host from seeing the reader.
 */
export function holdsMediaUrl(
  author: string,
  url: string,
  i: { self?: string; proxied: boolean },
  known: ReadonlySet<string>,
): boolean {
  if (author === i.self || i.proxied) return false;
  return !isKnownMediaHost(url, known);
}

/** When the next observed author leaves either probation, or undefined. */
export function nextEstablishedAt(sightings: Sightings | undefined, now: number): number | undefined {
  let next: number | undefined;
  for (const seen of Object.values(sightings?.authors ?? {})) {
    for (const at of [seen + AVATAR_PROBATION_MS, seen + MEDIA_PROBATION_MS]) {
      if (at > now && (next === undefined || at < next)) next = at;
    }
  }
  return next;
}

// Persistence: one KV entry per community, staged and flushed like `c2quar:`.

const cache = new KvPrefixCache<Sightings>({ prefix: "c2seen:" });
/** Staged records, read through so a decision never waits on the flush. */
const pending = new Map<string, Sightings>();
const listeners = new Set<() => void>();
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let revision = 0;

export const MEDIA_SIGHTINGS_FLUSH_MS = 2000;

function bump(): void {
  revision++;
  for (const l of listeners) {
    try {
      l();
    } catch {
      // A listener must never break a write.
    }
  }
}
cache.subscribe(bump);

/** Subscribing kicks the warm. */
export function subscribeSightings(listener: () => void): () => void {
  void cache.ready();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function sightingsRevision(): number {
  return revision;
}

/** Undefined before the warm lands, which {@link holdsMedia} treats as "nobody established". */
export function readSightings(communityIdHex: string): Sightings | undefined {
  if (!cache.warmed) return undefined;
  return pending.get(communityIdHex) ?? cache.get(communityIdHex);
}

/**
 * Record a channel's speakers. Waits for the warm: noting against an unread record
 * would re-seed every channel and let today's backdated messages through.
 */
export function recordSightings(
  communityIdHex: string,
  channelIdHex: string,
  observed: Iterable<readonly [author: string, ms: number]>,
): void {
  if (!communityIdHex || !channelIdHex || !cache.warmed) return;
  const next = noteSightings(readSightings(communityIdHex), channelIdHex, observed, Date.now());
  if (!next) return;
  pending.set(communityIdHex, next);
  bump();
  flushTimer ??= setTimeout(flushSightings, MEDIA_SIGHTINGS_FLUSH_MS);
}

/** Write staged records now (also the timer's body). */
export function flushSightings(): void {
  if (flushTimer !== undefined) clearTimeout(flushTimer);
  flushTimer = undefined;
  const staged = [...pending];
  pending.clear();
  for (const [id, value] of staged) cache.set(id, value);
}

/** Resolves once the record is warm (tests). */
export function sightingsReady(): Promise<void> {
  return cache.ready();
}

/** Logout: drop staged records (the KV cache itself is reset by `resetKvCaches`). */
export function clearSightingsMemory(): void {
  if (flushTimer !== undefined) clearTimeout(flushTimer);
  flushTimer = undefined;
  pending.clear();
  bump();
}
