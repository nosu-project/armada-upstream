import { describe, expect, it } from "vitest";

import {
  DISAPPEARING_PRESETS,
  disappearingNotice,
  formatDisappearingDuration,
  formatTimeLeft,
} from "@/lib/nip17/disappearing";

describe("formatDisappearingDuration", () => {
  it("names every offered preset", () => {
    for (const preset of DISAPPEARING_PRESETS) {
      const expected = preset.seconds === 0 ? "off" : preset.label;
      expect(formatDisappearingDuration(preset.seconds)).toBe(expected);
    }
  });

  it("composes a duration another client may have set", () => {
    expect(formatDisappearingDuration(90)).toBe("1 minute 30 seconds");
    expect(formatDisappearingDuration(2 * 60 * 60)).toBe("2 hours");
    expect(formatDisappearingDuration(9 * 24 * 60 * 60)).toBe("1 week 2 days");
  });

  it("reads a zero or negative timer as off", () => {
    expect(formatDisappearingDuration(0)).toBe("off");
    expect(formatDisappearingDuration(-1)).toBe("off");
  });
});

describe("formatTimeLeft", () => {
  const now = 1_700_000_000;

  it("abbreviates the largest unit, rounding up", () => {
    expect(formatTimeLeft(now + 45, now)).toBe("45s");
    expect(formatTimeLeft(now + 90, now)).toBe("2m");
    expect(formatTimeLeft(now + 3 * 3600, now)).toBe("3h");
    expect(formatTimeLeft(now + 2 * 86400, now)).toBe("2d");
    expect(formatTimeLeft(now + 21 * 86400, now)).toBe("3w");
  });

  it("never counts below zero", () => {
    expect(formatTimeLeft(now, now)).toBe("0s");
    expect(formatTimeLeft(now - 500, now)).toBe("0s");
  });
});

describe("disappearingNotice", () => {
  it("phrases the change from the viewer's side", () => {
    expect(disappearingNotice(86400, true, "Alice")).toBe("You set disappearing messages to 1 day.");
    expect(disappearingNotice(86400, false, "Alice")).toBe("Alice set disappearing messages to 1 day.");
  });

  it("phrases turning it off without a duration", () => {
    expect(disappearingNotice(0, true, "Alice")).toBe("You turned off disappearing messages.");
    expect(disappearingNotice(0, false, "Alice")).toBe("Alice turned off disappearing messages.");
  });
});
