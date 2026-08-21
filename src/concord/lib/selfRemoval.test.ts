/**
 * Self-removal verdicts (CORD-04 §4/§6). The bug these pin: a Concord KICK is
 * cooperative — it rotates no key, so the kicked member's own client keeps
 * every stream key it had and, without this compliance, went on reading and
 * writing while everyone else's member list had already dropped them.
 */

import { describe, expect, it } from "vitest";

import { kickVerdictPostdatesMembership, selfRemovalVerdict } from "@/concord/lib/selfRemoval";

const ME = "a".repeat(64);
const OWNER = "b".repeat(64);

/** Joined at t=1000s; a verdict at t=2000s judges THIS membership. */
const JOINED_MS = 1_000_000;
const AFTER_SECS = 2_000;
const BEFORE_SECS = 500;

function input(over: Partial<Parameters<typeof selfRemovalVerdict>[0]> = {}) {
  return {
    selfHex: ME,
    ownerHex: OWNER,
    addedAtMs: JOINED_MS,
    banned: false,
    banlistHeadAtSecs: undefined,
    guestbook: undefined,
    ...over,
  };
}

describe("selfRemovalVerdict", () => {
  it("returns null for an untouched member", () => {
    expect(selfRemovalVerdict(input())).toBeNull();
    expect(selfRemovalVerdict(input({ guestbook: { state: "join", ms: JOINED_MS + 1 } }))).toBeNull();
  });

  it("convicts on a Guestbook kick that postdates the membership", () => {
    expect(selfRemovalVerdict(input({ guestbook: { state: "kick", ms: JOINED_MS + 1 } }))).toBe("kick");
  });

  it("ignores a kick that predates the membership (a rejoin's own stale entry)", () => {
    // The coalesced Guestbook still reads `kick` until the fresh Join sweeps
    // back around; acting on it would tear the rejoiner down on the way in.
    expect(selfRemovalVerdict(input({ guestbook: { state: "kick", ms: JOINED_MS - 1 } }))).toBeNull();
  });

  it("convicts on a banlist head that postdates the membership", () => {
    expect(selfRemovalVerdict(input({ banned: true, banlistHeadAtSecs: AFTER_SECS }))).toBe("ban");
  });

  it("ignores a banlist edition older than the membership (compaction resurfacing)", () => {
    expect(selfRemovalVerdict(input({ banned: true, banlistHeadAtSecs: BEFORE_SECS }))).toBeNull();
    // Named in the fold but with no head edition held: not actionable.
    expect(selfRemovalVerdict(input({ banned: true, banlistHeadAtSecs: undefined }))).toBeNull();
  });

  it("reports the ban when both verdicts stand", () => {
    expect(
      selfRemovalVerdict(
        input({ banned: true, banlistHeadAtSecs: AFTER_SECS, guestbook: { state: "kick", ms: JOINED_MS + 1 } }),
      ),
    ).toBe("ban");
  });

  it("never convicts the owner", () => {
    expect(
      selfRemovalVerdict(
        input({
          selfHex: OWNER,
          banned: true,
          banlistHeadAtSecs: AFTER_SECS,
          guestbook: { state: "kick", ms: JOINED_MS + 1 },
        }),
      ),
    ).toBeNull();
  });
});

describe("kickVerdictPostdatesMembership", () => {
  it("matches the kick half of the verdict", () => {
    expect(kickVerdictPostdatesMembership({ state: "kick", ms: JOINED_MS + 1 }, ME, OWNER, JOINED_MS)).toBe(true);
    expect(kickVerdictPostdatesMembership({ state: "kick", ms: JOINED_MS - 1 }, ME, OWNER, JOINED_MS)).toBe(false);
    expect(kickVerdictPostdatesMembership({ state: "leave", ms: JOINED_MS + 1 }, ME, OWNER, JOINED_MS)).toBe(false);
    expect(kickVerdictPostdatesMembership({ state: "kick", ms: JOINED_MS + 1 }, OWNER, OWNER, JOINED_MS)).toBe(false);
  });

  it("is false with missing inputs (never tear down on a gap)", () => {
    expect(kickVerdictPostdatesMembership(undefined, ME, OWNER, JOINED_MS)).toBe(false);
    expect(kickVerdictPostdatesMembership({ state: "kick", ms: JOINED_MS + 1 }, undefined, OWNER, JOINED_MS)).toBe(false);
    expect(kickVerdictPostdatesMembership({ state: "kick", ms: JOINED_MS + 1 }, ME, undefined, JOINED_MS)).toBe(false);
    expect(kickVerdictPostdatesMembership({ state: "kick", ms: JOINED_MS + 1 }, ME, OWNER, undefined)).toBe(false);
  });
});
