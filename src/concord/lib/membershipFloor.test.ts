import { describe, expect, it } from "vitest";

import { sentDuringMembership } from "@/concord/lib/membershipFloor";

describe("sentDuringMembership", () => {
  it("admits only what was sent at or after the join", () => {
    expect(sentDuringMembership(1_000, 2_000)).toBe(false);
    expect(sentDuringMembership(2_000, 2_000)).toBe(true);
    expect(sentDuringMembership(3_000, 2_000)).toBe(true);
    expect(sentDuringMembership(1_000, undefined)).toBe(true);
  });

  it("counts a whole-second timestamp from the join's own second", () => {
    expect(sentDuringMembership(2_000, 2_700)).toBe(true);
    expect(sentDuringMembership(1_999, 2_700)).toBe(false);
  });
});
