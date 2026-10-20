import { describe, expect, it } from "vitest";

import { expandTemplate, formatDate, formatTime, sanitizeSegment, uniqueName } from "./template";

const date = new Date(2026, 9, 20, 9, 5, 7);
const vars = { user: "Alice", host: "Pod Squad", channel: "studio", date };

describe("expandTemplate", () => {
  it("expands every variable and splits folders on /", () => {
    expect(expandTemplate("%host/%date %time/%channel - %user", vars, { perUser: true })).toEqual([
      "Pod Squad",
      "2026-10-20 09-05-07",
      "studio - Alice",
    ]);
  });

  it("appends the user in multichannel mode when the template would name every file alike", () => {
    expect(expandTemplate("%date", vars, { perUser: true })).toEqual(["2026-10-20 - Alice"]);
    expect(expandTemplate("%date", { ...vars, user: "Mixdown" }, { perUser: false })).toEqual(["2026-10-20"]);
  });

  it("cannot be steered out of the chosen folder by a name", () => {
    const hostile = { ...vars, user: "../../etc/passwd", host: "..", channel: "a\\b:c" };
    const segments = expandTemplate("%host/%channel/%user", hostile, { perUser: true });
    expect(segments).toEqual(["Armada", "a_b_c", "_.._etc_passwd"]);
    for (const segment of segments) {
      expect(segment).not.toMatch(/[/\\]/);
      expect(segment).not.toBe("..");
    }
  });

  it("falls back when the template or a value is empty", () => {
    expect(expandTemplate("  ", vars, { perUser: true })).toEqual(["Pod Squad", "2026-10-20 09-05-07", "Alice"]);
    expect(expandTemplate("%user", { ...vars, user: "///" }, { perUser: true })).toEqual(["___"]);
    expect(expandTemplate("%user", { ...vars, user: "..." }, { perUser: true })).toEqual(["user"]);
  });
});

describe("filename helpers", () => {
  it("formats date and time without characters Windows rejects", () => {
    expect(formatDate(date)).toBe("2026-10-20");
    expect(formatTime(date)).toBe("09-05-07");
  });

  it("strips control characters and reserved punctuation", () => {
    expect(sanitizeSegment(' a\u0000b<c>"d"|e?*f. ')).toBe("ab_c__d__e__f");
  });

  it("numbers duplicates case-insensitively", () => {
    expect(uniqueName("Alice", "flac", new Set())).toBe("Alice.flac");
    expect(uniqueName("Alice", "flac", new Set(["alice.FLAC", "Alice (2).flac"]))).toBe("Alice (3).flac");
  });
});
