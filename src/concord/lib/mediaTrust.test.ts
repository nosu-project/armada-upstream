/**
 * The media hold's decisions and its probation clock. The property that matters
 * most: once a channel is being watched, a key cannot age itself by backdating —
 * only this client's own clock starts its probation.
 */
import { describe, expect, it } from "vitest";

import {
  MEDIA_PROBATION_MS,
  MEDIA_SEED_GRACE_MS,
  MEDIA_SIGHTINGS_MAX_AUTHORS,
  flushSightings,
  holdsMedia,
  nextEstablishedAt,
  noteSightings,
  readSightings,
  recordSightings,
  sightingsReady,
  type MediaHoldInputs,
  type Sightings,
} from "@/concord/lib/mediaTrust";

const NOW = 1_800_000_000_000;
const DAY = 24 * 3_600_000;
const ana = "a".repeat(64);
const ben = "b".repeat(64);
const spam = "f".repeat(64);

const base = (over: Partial<MediaHoldInputs> = {}): MediaHoldInputs => ({ mode: "trusted", now: NOW, ...over });

describe("noteSightings", () => {
  it("seeds a channel's first read from its own history", () => {
    const s = noteSightings(undefined, "chan", [[ana, NOW - 30 * DAY], [ben, NOW - DAY / 2]], NOW)!;
    expect(s.channels.chan).toBe(NOW);
    expect(s.authors[ana]).toBe(NOW - 30 * DAY);
    expect(s.authors[ben]).toBe(NOW - DAY / 2);
  });

  it("stamps a newcomer with the local clock once the grace has passed, whatever they claim", () => {
    const seeded = noteSightings(undefined, "chan", [[ana, NOW - 30 * DAY]], NOW)!;
    const later = NOW + MEDIA_SEED_GRACE_MS;
    const s = noteSightings(seeded, "chan", [[spam, NOW - 365 * DAY]], later)!;
    expect(s.authors[spam]).toBe(later);
    expect(holdsMedia(spam, base({ sightings: s, now: later }))).toBe(true);
  });

  it("clamps a future-dated seed to now", () => {
    const s = noteSightings(undefined, "chan", [[spam, NOW + 10 * DAY]], NOW)!;
    expect(s.authors[spam]).toBe(NOW);
  });

  it("never moves a stamp later, and reports no change when nothing moved", () => {
    const seeded = noteSightings(undefined, "chan", [[ana, NOW - 30 * DAY]], NOW)!;
    expect(noteSightings(seeded, "chan", [[ana, NOW]], NOW + DAY)).toBeUndefined();
  });

  it("gives each channel its own seeding window", () => {
    const seeded = noteSightings(undefined, "general", [[ana, NOW - 30 * DAY]], NOW)!;
    const later = NOW + 2 * DAY;
    const s = noteSightings(seeded, "art", [[ben, NOW - 10 * DAY]], later)!;
    expect(s.channels.art).toBe(later);
    expect(s.authors[ben]).toBe(NOW - 10 * DAY);
  });

  it("keeps the oldest authors when over the cap, so overflow only ever holds", () => {
    const authors: Record<string, number> = {};
    for (let i = 0; i < MEDIA_SIGHTINGS_MAX_AUTHORS; i++) authors[i.toString(16).padStart(64, "0")] = NOW - DAY - i;
    const prev: Sightings = { v: 1, channels: { chan: NOW - DAY }, authors };
    const s = noteSightings(prev, "chan", [[spam, 0]], NOW)!;
    expect(Object.keys(s.authors)).toHaveLength(MEDIA_SIGHTINGS_MAX_AUTHORS);
    expect(s.authors[spam]).toBeUndefined();
  });
});

describe("holdsMedia", () => {
  const established: Sightings = { v: 1, channels: {}, authors: { [ana]: NOW - 2 * DAY, [ben]: NOW - 60_000 } };

  it("loads from the reader, staff, followed, graph-trusted and established authors", () => {
    expect(holdsMedia(spam, base({ self: spam }))).toBe(false);
    expect(holdsMedia(spam, base({ isStaff: (a) => a === spam }))).toBe(false);
    expect(holdsMedia(spam, base({ follows: new Set([spam]) }))).toBe(false);
    expect(holdsMedia(spam, base({ trusted: new Set([spam]) }))).toBe(false);
    expect(holdsMedia(ana, base({ sightings: established }))).toBe(false);
  });

  it("holds strangers and authors still on probation", () => {
    expect(holdsMedia(spam, base({ sightings: established }))).toBe(true);
    expect(holdsMedia(ben, base({ sightings: established }))).toBe(true);
    expect(holdsMedia(ben, base({ sightings: established, now: NOW - 60_000 + MEDIA_PROBATION_MS }))).toBe(false);
  });

  it("holds everyone not otherwise trusted before the record is read", () => {
    expect(holdsMedia(ana, base())).toBe(true);
  });

  it("honours the always/never modes, never holding the reader's own", () => {
    expect(holdsMedia(spam, base({ mode: "always" }))).toBe(false);
    expect(holdsMedia(ana, base({ mode: "never", sightings: established, follows: new Set([ana]) }))).toBe(true);
    expect(holdsMedia(ana, base({ mode: "never", self: ana }))).toBe(false);
  });

  it("schedules the next probation crossing", () => {
    expect(nextEstablishedAt(established, NOW)).toBe(NOW - 60_000 + MEDIA_PROBATION_MS);
    expect(nextEstablishedAt(undefined, NOW)).toBeUndefined();
  });
});

describe("sightings store", () => {
  it("reads staged records before they are flushed, and keeps them after", async () => {
    await sightingsReady();
    const community = "c".repeat(64);
    recordSightings(community, "chan", [[ana, Date.now() - 30 * DAY]]);
    expect(readSightings(community)?.authors[ana]).toBeDefined();
    flushSightings();
    expect(readSightings(community)?.authors[ana]).toBeDefined();
  });
});
