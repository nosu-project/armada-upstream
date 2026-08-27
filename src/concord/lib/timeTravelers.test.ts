import { describe, expect, it } from "vitest";

import { describeAhead, timeTravelers, travelerRank, TIME_TRAVELER_THRESHOLD_MS } from "@/concord/lib/timeTravelers";
import type { OpenedChat } from "@/concord/lib/chat";

let seq = 0;
function msg(author: string, ms: number, content = "hello"): OpenedChat {
  seq += 1;
  return {
    rumorId: `r${seq}`,
    author,
    kind: 9,
    content,
    tags: [],
    ms,
    createdAt: Math.floor(ms / 1000),
    channelIdHex: "aa".repeat(32),
    epoch: 0n,
  };
}

function chan(...rows: OpenedChat[]): Map<string, OpenedChat[]> {
  return new Map([["aa".repeat(32), rows]]);
}

describe("timeTravelers", () => {
  const now = 1_800_000_000_000;

  it("flags an author dated well ahead of now", () => {
    const out = timeTravelers(chan(msg("ana", now + 5 * 60_000, "from the future")), now);
    expect(out).toHaveLength(1);
    expect(out[0].author).toBe("ana");
    expect(out[0].sample).toBe("from the future");
    expect(out[0].aheadMs).toBe(5 * 60_000);
  });

  it("ignores present and past messages, and small skew within the threshold", () => {
    const out = timeTravelers(
      chan(
        msg("ana", now - 60_000),
        msg("ben", now),
        msg("cat", now + TIME_TRAVELER_THRESHOLD_MS - 1), // just under: not flagged
      ),
      now,
    );
    expect(out).toHaveLength(0);
  });

  it("collapses an author's many future messages into one entry, keeping the furthest ahead", () => {
    const out = timeTravelers(
      chan(
        msg("ana", now + 2 * 60_000, "two minutes"),
        msg("ana", now + 9 * 60_000, "nine minutes"),
        msg("ana", now + 4 * 60_000, "four minutes"),
      ),
      now,
    );
    expect(out).toHaveLength(1);
    expect(out[0].count).toBe(3);
    expect(out[0].aheadMs).toBe(9 * 60_000);
    expect(out[0].sample).toBe("nine minutes"); // the furthest-ahead one
  });

  it("sorts the furthest traveler first", () => {
    const out = timeTravelers(
      chan(msg("near", now + 2 * 60_000), msg("far", now + 3 * 60 * 60_000)),
      now,
    );
    expect(out.map((t) => t.author)).toEqual(["far", "near"]);
  });

  it("excludes the reader's own messages", () => {
    const out = timeTravelers(chan(msg("me", now + 10 * 60_000), msg("ana", now + 10 * 60_000)), now, {
      self: "me",
    });
    expect(out.map((t) => t.author)).toEqual(["ana"]);
  });

  it("scans across every channel it is handed", () => {
    const byChannel = new Map<string, OpenedChat[]>([
      ["cc".repeat(32), [msg("ana", now + 5 * 60_000)]],
      ["dd".repeat(32), [msg("ben", now + 6 * 60_000)]],
    ]);
    const out = timeTravelers(byChannel, now);
    expect(new Set(out.map((t) => t.author))).toEqual(new Set(["ana", "ben"]));
  });

  it("truncates a long sample to one bounded line", () => {
    const long = "x".repeat(200);
    const out = timeTravelers(chan(msg("ana", now + 5 * 60_000, `line one\nline two ${long}`)), now);
    expect(out[0].sample.length).toBeLessThanOrEqual(80);
    expect(out[0].sample).not.toContain("\n");
  });
});

describe("describeAhead", () => {
  it("rounds to a friendly unit and never reads below a minute", () => {
    expect(describeAhead(30_000)).toBe("a minute");
    expect(describeAhead(5 * 60_000)).toBe("5 minutes");
    expect(describeAhead(3 * 60 * 60_000)).toBe("3 hours");
    expect(describeAhead(5 * 24 * 60 * 60_000)).toBe("5 days");
  });
});

describe("travelerRank", () => {
  it("escalates with distance into the future", () => {
    expect(travelerRank(2 * 60_000)).toBe("Slightly ahead of schedule");
    expect(travelerRank(30 * 60_000)).toBe("Chrono-drifter");
    expect(travelerRank(3 * 60 * 60_000)).toBe("Temporal tourist");
    expect(travelerRank(3 * 24 * 60 * 60_000)).toBe("Certified time traveler");
    expect(travelerRank(30 * 24 * 60 * 60_000)).toBe("Escaped the timeline");
  });
});
