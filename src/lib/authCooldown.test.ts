import { describe, expect, it } from "vitest";

import { AUTH_MIN_INTERVAL_MS, AUTH_STREAK_WINDOW_MS, authCooldownMs, nextAuthStreak } from "./authCooldown";

describe("authCooldownMs", () => {
  it("keeps a local key at the burst interval however often it signs", () => {
    expect(authCooldownMs(1, false)).toBe(AUTH_MIN_INTERVAL_MS);
    expect(authCooldownMs(50, false)).toBe(AUTH_MIN_INTERVAL_MS);
  });

  it("backs a prompting signer off geometrically, capped at ten minutes", () => {
    expect([1, 2, 3, 4, 5, 9].map((n) => authCooldownMs(n, true))).toEqual([
      5_000, 20_000, 80_000, 320_000, 600_000, 600_000,
    ]);
  });
});

describe("nextAuthStreak", () => {
  it("grows within the window and restarts after it", () => {
    let s = nextAuthStreak(undefined, 0);
    s = nextAuthStreak(s, 60_000);
    expect(s.count).toBe(2);
    expect(nextAuthStreak(s, 60_000 + AUTH_STREAK_WINDOW_MS).count).toBe(1);
  });
});
