import { describe, expect, it } from "vitest";

import { NOTE_TO_SELF_NAME, NOTE_VIEWBOX, notePathsFor, noteStrokeFor } from "@/components/NoteToSelfAvatar";

/** Writing lines in a lines path, one `M` per rule. */
const lines = (d: string) => (d.match(/M/g) ?? []).length;

describe("note to self mark", () => {
  it("draws a page and its writing lines on one viewport", () => {
    expect(NOTE_VIEWBOX).toBe("0 0 24 24");
    for (const px of [16, 48, 96]) {
      const [page, rules] = notePathsFor(px);
      expect(page.startsWith("M")).toBe(true);
      expect(lines(rules)).toBeGreaterThanOrEqual(2);
    }
  });

  it("drops to two lines only where three cannot stay distinct", () => {
    expect(lines(notePathsFor(16)[1])).toBe(2);
    expect(lines(notePathsFor(31)[1])).toBe(2);
    expect(lines(notePathsFor(32)[1])).toBe(3);
    expect(lines(notePathsFor(96)[1])).toBe(3);
  });

  it("thickens the stroke as the mark gets smaller", () => {
    expect(noteStrokeFor(16)).toBeGreaterThan(noteStrokeFor(48));
    expect(noteStrokeFor(48)).toBeGreaterThan(noteStrokeFor(96));
  });

  it("steps the weight at fixed size boundaries", () => {
    expect(noteStrokeFor(31)).toBe(noteStrokeFor(16));
    expect(noteStrokeFor(32)).toBe(noteStrokeFor(48));
    expect(noteStrokeFor(79)).toBe(noteStrokeFor(48));
    expect(noteStrokeFor(80)).toBe(noteStrokeFor(400));
  });

  it("labels the conversation", () => {
    expect(NOTE_TO_SELF_NAME).toBe("Note to Self");
  });
});
