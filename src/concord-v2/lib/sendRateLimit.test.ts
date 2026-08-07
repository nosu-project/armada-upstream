import { beforeEach, describe, expect, it } from "vitest";

import { KIND_COMMENT, KIND_DELETE, KIND_MESSAGE, KIND_POLL, KIND_REACTION } from "@/concord-v2/lib/kinds";
import {
  LOCKOUT_TIERS,
  SEND_BURST,
  SEND_REFILL_MS,
  SendRateLimitError,
  TIER_DECAY_MS,
  attemptSend,
  consumeSend,
  formatRetryAfter,
  isRateLimitedKind,
  resetSendLimits,
  sendRefusal,
} from "@/concord-v2/lib/sendRateLimit";

beforeEach(() => {
  resetSendLimits();
});

/** Spend the whole bucket at `now`, leaving it empty but un-violated. */
function drain(id: string, now: number): void {
  for (let i = 0; i < SEND_BURST; i++) {
    expect(consumeSend(id, now)).toBe(0);
  }
}

describe("isRateLimitedKind", () => {
  it("charges the kinds a reader sees as a post", () => {
    expect(isRateLimitedKind(KIND_MESSAGE)).toBe(true);
    expect(isRateLimitedKind(KIND_COMMENT)).toBe(true);
    expect(isRateLimitedKind(KIND_POLL)).toBe(true);
  });

  it("exempts reactions, edits and deletes", () => {
    expect(isRateLimitedKind(KIND_REACTION)).toBe(false);
    expect(isRateLimitedKind(KIND_DELETE)).toBe(false);
    expect(isRateLimitedKind(3302)).toBe(false);
  });
});

describe("the token bucket", () => {
  it("allows a full burst back-to-back", () => {
    drain("a", 1_000);
  });

  it("hands a token back per refill interval", () => {
    drain("a", 0);
    // Empty but not yet in violation: waiting out the refill is enough.
    expect(consumeSend("a", SEND_REFILL_MS)).toBe(0);
    expect(consumeSend("a", 2 * SEND_REFILL_MS)).toBe(0);
  });

  it("refills to the burst cap and no further", () => {
    drain("a", 0);
    const later = 3_600_000;
    // An hour idle buys back a burst, not an hour's worth of tokens.
    drain("a", later);
    expect(consumeSend("a", later)).toBe(LOCKOUT_TIERS[0]);
  });

  it("keeps communities independent", () => {
    drain("a", 1_000);
    expect(consumeSend("a", 1_000)).toBe(LOCKOUT_TIERS[0]);
    expect(consumeSend("b", 1_000)).toBe(0);
  });

  it("treats a backwards clock as no elapsed time rather than free tokens", () => {
    drain("a", 10_000);
    expect(consumeSend("a", 5_000)).toBe(LOCKOUT_TIERS[0]);
  });
});

describe("the escalating lockout", () => {
  it("locks for the first tier when the bucket runs dry", () => {
    drain("a", 0);
    expect(consumeSend("a", 0)).toBe(LOCKOUT_TIERS[0]);
  });

  it("counts down the lockout rather than restarting it on every attempt", () => {
    drain("a", 0);
    consumeSend("a", 0);
    expect(consumeSend("a", 5_000)).toBe(LOCKOUT_TIERS[0] - 5_000);
    expect(consumeSend("a", 10_000)).toBe(LOCKOUT_TIERS[0] - 10_000);
    // Hammering through the lockout is ONE bout: the next tier is still the
    // second, not the fiftieth.
    expect(consumeSend("a", LOCKOUT_TIERS[0])).toBe(0);
  });

  it("walks up a tier per fresh bout of flooding", () => {
    let now = 0;
    for (const tier of LOCKOUT_TIERS) {
      // Serve the previous penalty, refill, flood again.
      drain("a", now);
      expect(consumeSend("a", now)).toBe(tier);
      now += tier;
    }
    // Past the last tier the ceiling holds rather than growing without bound.
    drain("a", now);
    expect(consumeSend("a", now)).toBe(LOCKOUT_TIERS[LOCKOUT_TIERS.length - 1]);
  });

  it("empties the bucket, but every tier outlasts a full refill", () => {
    drain("a", 0);
    consumeSend("a", 0);
    // The shortest lockout is five refill intervals, so serving any penalty
    // hands back a whole burst — the lockout is the punishment, not a
    // half-empty bucket afterwards.
    expect(LOCKOUT_TIERS[0]).toBeGreaterThanOrEqual(SEND_BURST * SEND_REFILL_MS);
    drain("a", LOCKOUT_TIERS[0]);
  });

  it("decays a tier per stretch of clean time after the penalty is served", () => {
    drain("a", 0);
    consumeSend("a", 0); // tier 1
    let now = LOCKOUT_TIERS[0];
    drain("a", now);
    expect(consumeSend("a", now)).toBe(LOCKOUT_TIERS[1]); // tier 2
    now += LOCKOUT_TIERS[1];

    // Behave for one decay window: the next slip is a first-tier slip again.
    now += TIER_DECAY_MS;
    drain("a", now);
    expect(consumeSend("a", now)).toBe(LOCKOUT_TIERS[1]);
  });

  it("does not credit time spent locked out toward the decay", () => {
    // Climb to a lockout LONGER than the decay window (15 min vs 10), so
    // serving it would forgive a tier if serving counted as behaving.
    let now = 0;
    for (const tier of LOCKOUT_TIERS.slice(0, 4)) {
      drain("a", now);
      expect(consumeSend("a", now)).toBe(tier);
      now += tier;
    }
    expect(LOCKOUT_TIERS[3]).toBeGreaterThan(TIER_DECAY_MS);
    // Back the instant it lifts: no clean time has accrued, so the climb
    // continues rather than resuming a tier lower.
    drain("a", now);
    expect(consumeSend("a", now)).toBe(LOCKOUT_TIERS[4]);
  });

  it("returns to a clean slate after enough clean time", () => {
    drain("a", 0);
    consumeSend("a", 0);
    let now = LOCKOUT_TIERS[0];
    drain("a", now);
    expect(consumeSend("a", now)).toBe(LOCKOUT_TIERS[1]); // tier 2
    now += LOCKOUT_TIERS[1] + 2 * TIER_DECAY_MS;
    drain("a", now);
    expect(consumeSend("a", now)).toBe(LOCKOUT_TIERS[0]);
  });
});

describe("attemptSend", () => {
  it("does not spend a token when it allows the send", () => {
    for (let i = 0; i < 20; i++) expect(attemptSend("a", 1_000)).toBe(0);
    // All five are still there for the publish path.
    drain("a", 1_000);
  });

  it("counts a refusal, so the composer's pre-flight escalates too", () => {
    drain("a", 0);
    expect(attemptSend("a", 0)).toBe(LOCKOUT_TIERS[0]);
    const freed = LOCKOUT_TIERS[0];
    drain("a", freed);
    expect(attemptSend("a", freed)).toBe(LOCKOUT_TIERS[1]);
  });
});

describe("sendRefusal", () => {
  it("is null while the budget holds", () => {
    expect(sendRefusal("a", 1_000)).toBeNull();
  });

  it("names the wait once the budget is spent", () => {
    drain("a", 1_000);
    expect(sendRefusal("a", 1_000)).toBe("You're sending messages too quickly. Try again in 15 seconds.");
  });
});

describe("formatRetryAfter", () => {
  it("rounds up so a sub-second wait never reads as zero", () => {
    expect(formatRetryAfter(1)).toBe("1 second");
    expect(formatRetryAfter(1_000)).toBe("1 second");
    expect(formatRetryAfter(1_001)).toBe("2 seconds");
  });

  it("switches to the largest whole unit that reads naturally", () => {
    expect(formatRetryAfter(59_000)).toBe("59 seconds");
    expect(formatRetryAfter(60_000)).toBe("1 minute");
    expect(formatRetryAfter(90_000)).toBe("2 minutes");
    expect(formatRetryAfter(15 * 60_000)).toBe("15 minutes");
    expect(formatRetryAfter(60 * 60_000)).toBe("1 hour");
    expect(formatRetryAfter(90 * 60_000)).toBe("2 hours");
  });

  it("renders every tier as something a person can act on", () => {
    expect(LOCKOUT_TIERS.map(formatRetryAfter)).toEqual([
      "15 seconds",
      "1 minute",
      "5 minutes",
      "15 minutes",
      "1 hour",
    ]);
  });
});

describe("SendRateLimitError", () => {
  it("carries the wait and a message safe to show verbatim", () => {
    const err = new SendRateLimitError(2_500);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("SendRateLimitError");
    expect(err.retryAfterMs).toBe(2_500);
    expect(err.message).toBe("You're sending messages too quickly. Try again in 3 seconds.");
    // The composer's "is the signer down?" heuristic must not claim this one.
    expect(/timed? ?out|abort/i.test(err.message)).toBe(false);
  });
});
