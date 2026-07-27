import { describe, expect, it } from "vitest";

import { buildPollTags, isPollEnded, parsePoll, tallyPollVotes, type PollVote } from "@/lib/polls";

describe("polls", () => {
  it("parses options, type, and endsAt from a poll's tags", () => {
    const parsed = parsePoll({
      tags: [
        ["option", "a1", "Tacos"],
        ["option", "b2", "Sushi"],
        ["polltype", "multiplechoice"],
        ["endsAt", "1735689600"],
        ["alt", "Poll: Lunch?"],
      ],
    });
    expect(parsed.options).toEqual([
      { id: "a1", label: "Tacos" },
      { id: "b2", label: "Sushi" },
    ]);
    expect(parsed.pollType).toBe("multiplechoice");
    expect(parsed.endsAt).toBe(1735689600);
  });

  it("defaults to single choice with no end when unspecified", () => {
    const parsed = parsePoll({ tags: [["option", "a1", "Only"]] });
    expect(parsed.pollType).toBe("singlechoice");
    expect(parsed.endsAt).toBeUndefined();
  });

  const options = [
    { id: "a1", label: "Tacos" },
    { id: "b2", label: "Sushi" },
  ];

  it("tallies latest vote per voter and drops unknown option ids", () => {
    const votes: PollVote[] = [
      { pubkey: "bob", optionIds: ["a1"], ms: 1100 },
      { pubkey: "carol", optionIds: ["a1"], ms: 1200 },
      { pubkey: "carol", optionIds: ["b2"], ms: 1300 }, // supersedes carol's a1
      { pubkey: "dave", optionIds: ["zz"], ms: 1400 }, // unknown option → no count
    ];
    const tally = tallyPollVotes(votes, options, undefined, "carol");
    expect(tally.counts.get("a1")).toBe(1); // bob only
    expect(tally.counts.get("b2")).toBe(1); // carol's latest
    // dave is still a distinct voter even though his choice was invalid.
    expect(tally.totalVoters).toBe(3);
    expect([...(tally.myVote ?? [])]).toEqual(["b2"]);
  });

  it("dedupes repeated responses within one vote (multiple choice)", () => {
    const votes: PollVote[] = [{ pubkey: "bob", optionIds: ["a1", "a1", "b2"], ms: 1 }];
    const tally = tallyPollVotes(votes, options, undefined, undefined);
    expect(tally.counts.get("a1")).toBe(1);
    expect(tally.counts.get("b2")).toBe(1);
    expect(tally.totalVoters).toBe(1);
  });

  it("ignores votes cast after endsAt (seconds vs ms)", () => {
    const endsAt = 2; // unix seconds
    const votes: PollVote[] = [
      { pubkey: "bob", optionIds: ["a1"], ms: 1500 }, // 1.5s ≤ 2s: counts
      { pubkey: "carol", optionIds: ["b2"], ms: 3000 }, // 3s > 2s: ignored
    ];
    const tally = tallyPollVotes(votes, options, endsAt, undefined);
    expect(tally.counts.get("a1")).toBe(1);
    expect(tally.counts.get("b2")).toBeUndefined();
    expect(tally.totalVoters).toBe(1);
  });

  it("reports no vote for a user who hasn't voted", () => {
    const tally = tallyPollVotes([{ pubkey: "bob", optionIds: ["a1"], ms: 1 }], options, undefined, "carol");
    expect(tally.myVote).toBeUndefined();
  });

  it("builds descriptive tags without a relay-routing tag", () => {
    const tags = buildPollTags("Lunch?", options, "singlechoice", 0);
    expect(tags).toContainEqual(["option", "a1", "Tacos"]);
    expect(tags).toContainEqual(["polltype", "singlechoice"]);
    expect(tags).toContainEqual(["alt", "Poll: Lunch?"]);
    // No end when duration is 0, and never a relay tag (sealed plane).
    expect(tags.some(([n]) => n === "endsAt")).toBe(false);
    expect(tags.some(([n]) => n === "relay")).toBe(false);
  });

  it("adds an endsAt tag for a positive duration", () => {
    const before = Math.floor(Date.now() / 1000) + 3 * 86_400;
    const tags = buildPollTags("Q", options, "singlechoice", 3);
    const endsAt = Number(tags.find(([n]) => n === "endsAt")?.[1]);
    expect(endsAt).toBeGreaterThanOrEqual(before);
  });

  it("treats only a past endsAt as ended", () => {
    expect(isPollEnded(undefined)).toBe(false);
    expect(isPollEnded(Math.floor(Date.now() / 1000) + 3600)).toBe(false);
    expect(isPollEnded(Math.floor(Date.now() / 1000) - 3600)).toBe(true);
  });
});
