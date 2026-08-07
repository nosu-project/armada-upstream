import { beforeEach, describe, expect, it } from "vitest";

import { KIND_COMMENT, KIND_DELETE, KIND_MESSAGE, KIND_POLL, KIND_REACTION } from "@/concord-v2/lib/kinds";
import {
  SEND_BURST,
  SEND_REFILL_MS,
  SendRateLimitError,
  consumeSend,
  formatRetryAfter,
  isRateLimitedKind,
  peekSend,
  resetSendLimits,
  sendRefusal,
} from "@/concord-v2/lib/sendRateLimit";

beforeEach(() => {
  resetSendLimits();
});

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

describe("consumeSend", () => {
  it("allows a full burst back-to-back", () => {
    for (let i = 0; i < SEND_BURST; i++) {
      expect(consumeSend("a", 1_000)).toBe(0);
    }
  });

  it("refuses the send past the burst, with a wait of one refill", () => {
    for (let i = 0; i < SEND_BURST; i++) consumeSend("a", 1_000);
    expect(consumeSend("a", 1_000)).toBe(SEND_REFILL_MS);
  });

  it("spends nothing on a refusal, so the wait doesn't grow by retrying", () => {
    for (let i = 0; i < SEND_BURST; i++) consumeSend("a", 1_000);
    consumeSend("a", 1_000);
    consumeSend("a", 1_000);
    // A whole refill after the burst: one token, regardless of the two refusals.
    expect(consumeSend("a", 1_000 + SEND_REFILL_MS)).toBe(0);
    expect(consumeSend("a", 1_000 + SEND_REFILL_MS)).toBe(SEND_REFILL_MS);
  });

  it("counts down as the bucket refills", () => {
    for (let i = 0; i < SEND_BURST; i++) consumeSend("a", 0);
    expect(consumeSend("a", SEND_REFILL_MS / 4)).toBe(SEND_REFILL_MS * 0.75);
    expect(consumeSend("a", SEND_REFILL_MS / 2)).toBe(SEND_REFILL_MS / 2);
    expect(consumeSend("a", SEND_REFILL_MS)).toBe(0);
  });

  it("refills to the burst cap and no further", () => {
    for (let i = 0; i < SEND_BURST; i++) consumeSend("a", 0);
    // An hour idle buys back a burst, not an hour's worth of tokens.
    const later = 3_600_000;
    for (let i = 0; i < SEND_BURST; i++) expect(consumeSend("a", later)).toBe(0);
    expect(consumeSend("a", later)).toBe(SEND_REFILL_MS);
  });

  it("keeps communities independent", () => {
    for (let i = 0; i < SEND_BURST; i++) consumeSend("a", 1_000);
    expect(consumeSend("a", 1_000)).toBe(SEND_REFILL_MS);
    expect(consumeSend("b", 1_000)).toBe(0);
  });

  it("treats a backwards clock as no elapsed time rather than free tokens", () => {
    for (let i = 0; i < SEND_BURST; i++) consumeSend("a", 10_000);
    expect(consumeSend("a", 5_000)).toBe(SEND_REFILL_MS);
    // Re-anchored at the earlier reading: a refill from THERE is what pays.
    expect(consumeSend("a", 5_000 + SEND_REFILL_MS)).toBe(0);
  });
});

describe("peekSend", () => {
  it("reports the wait without spending a token", () => {
    for (let i = 0; i < SEND_BURST - 1; i++) consumeSend("a", 1_000);
    expect(peekSend("a", 1_000)).toBe(0);
    expect(peekSend("a", 1_000)).toBe(0);
    // The one remaining token survived both peeks.
    expect(consumeSend("a", 1_000)).toBe(0);
    expect(peekSend("a", 1_000)).toBe(SEND_REFILL_MS);
  });
});

describe("sendRefusal", () => {
  it("is null while the budget holds", () => {
    expect(sendRefusal("a", 1_000)).toBeNull();
  });

  it("names the wait once the budget is spent", () => {
    for (let i = 0; i < SEND_BURST; i++) consumeSend("a", 1_000);
    expect(sendRefusal("a", 1_000)).toBe("You're sending messages too quickly. Try again in 3 seconds.");
  });
});

describe("formatRetryAfter", () => {
  it("rounds up so a sub-second wait never reads as zero", () => {
    expect(formatRetryAfter(1)).toBe("1 second");
    expect(formatRetryAfter(1_000)).toBe("1 second");
    expect(formatRetryAfter(1_001)).toBe("2 seconds");
    expect(formatRetryAfter(3_000)).toBe("3 seconds");
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
