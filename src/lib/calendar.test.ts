import { describe, expect, it } from "vitest";

import {
  buildCalendarTags,
  isUpcoming,
  KIND_CALENDAR_DATE,
  KIND_CALENDAR_TIME,
  parseCalendarEvents,
  type RsvpVote,
  tallyRsvps,
} from "@/lib/calendar";

import type { NostrEvent } from "@nostrify/nostrify";

function ev(partial: Partial<NostrEvent> & { kind: number; tags: string[][] }): NostrEvent {
  return {
    id: partial.id ?? "id",
    pubkey: partial.pubkey ?? "author",
    created_at: partial.created_at ?? 1000,
    kind: partial.kind,
    tags: partial.tags,
    content: partial.content ?? "",
    sig: "",
  };
}

describe("calendar", () => {
  it("builds NIP-52 tags without any transport binding", () => {
    const tags = buildCalendarTags({
      identifier: "d1",
      kind: KIND_CALENDAR_TIME,
      title: "Call",
      start: "1000",
      end: "3600",
      startTzid: "America/New_York",
      location: "Voice",
      hashtags: ["weekly"],
    });
    expect(tags).toContainEqual(["d", "d1"]);
    expect(tags).toContainEqual(["title", "Call"]);
    expect(tags).toContainEqual(["start", "1000"]);
    expect(tags).toContainEqual(["end", "3600"]);
    expect(tags).toContainEqual(["start_tzid", "America/New_York"]);
    expect(tags).toContainEqual(["location", "Voice"]);
    expect(tags).toContainEqual(["t", "weekly"]);
    // No group `h` tag and no relay routing — each transport adds its own binding.
    expect(tags.some(([n]) => n === "h")).toBe(false);
  });

  it("parses + dedups events newest-per-coordinate and sorts soonest-first", () => {
    const older = ev({ id: "a", pubkey: "p", created_at: 100, kind: KIND_CALENDAR_TIME, tags: [["d", "x"], ["title", "Old"], ["start", "5000"]] });
    const newer = ev({ id: "b", pubkey: "p", created_at: 200, kind: KIND_CALENDAR_TIME, tags: [["d", "x"], ["title", "New"], ["start", "5000"]] });
    const other = ev({ id: "c", pubkey: "p", created_at: 100, kind: KIND_CALENDAR_TIME, tags: [["d", "y"], ["title", "Earlier"], ["start", "1000"]] });
    const parsed = parseCalendarEvents([older, newer, other]);
    // Two coordinates survive; the "x" one keeps the newer title.
    expect(parsed.map((e) => e.title)).toEqual(["Earlier", "New"]);
  });

  it("drops malformed events (missing required fields / bad start format)", () => {
    const noTitle = ev({ kind: KIND_CALENDAR_TIME, tags: [["d", "1"], ["start", "1000"]] });
    const badDate = ev({ kind: KIND_CALENDAR_DATE, tags: [["d", "2"], ["title", "T"], ["start", "not-a-date"]] });
    expect(parseCalendarEvents([noTitle, badDate])).toEqual([]);
  });

  it("treats a past-ended time event as not upcoming", () => {
    const past = parseCalendarEvents([
      ev({ kind: KIND_CALENDAR_TIME, tags: [["d", "1"], ["title", "T"], ["start", "1000"], ["end", "2000"]] }),
    ])[0];
    expect(isUpcoming(past, 5000)).toBe(false);
    expect(isUpcoming(past, 1500)).toBe(true);
  });

  it("tallies latest RSVP per pubkey, bucketed by status, surfacing the user's own", () => {
    const votes: RsvpVote[] = [
      { pubkey: "alice", status: "accepted", ms: 1000 },
      { pubkey: "bob", status: "tentative", ms: 1000 },
      { pubkey: "bob", status: "declined", ms: 2000 }, // supersedes bob's tentative
      { pubkey: "carol", status: "accepted", ms: 1000 },
    ];
    const tally = tallyRsvps(votes, "bob");
    expect(tally.accepted.sort()).toEqual(["alice", "carol"]);
    expect(tally.declined).toEqual(["bob"]);
    expect(tally.tentative).toEqual([]);
    expect(tally.mine).toBe("declined");
  });

  it("reports no status for a user who hasn't RSVP'd", () => {
    const tally = tallyRsvps([{ pubkey: "alice", status: "accepted", ms: 1 }], "bob");
    expect(tally.mine).toBeUndefined();
  });
});
