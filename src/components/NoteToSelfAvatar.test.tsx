import { describe, expect, it } from "vitest";

import { noteStripFor, NOTE_TO_SELF_NAME } from "@/components/NoteToSelfAvatar";

describe("note to self mark", () => {
  it("carries Signal's four-path notepad on each strip", () => {
    for (const px of [16, 48, 96]) {
      const strip = noteStripFor(px);
      expect(strip.paths).toHaveLength(4);
      for (const d of strip.paths) expect(d.startsWith("M")).toBe(true);
    }
  });

  it("draws each strip on the viewport its own drawable used", () => {
    // The paths are Signal's geometry verbatim, so a strip rendered on the
    // wrong viewport is silently mis-scaled rather than broken.
    expect(noteStripFor(16).viewBox).toBe("0 0 16 16");
    expect(noteStripFor(48).viewBox).toBe("0 0 24 24");
    expect(noteStripFor(96).viewBox).toBe("0 0 40 40");
  });

  it("switches strip at Signal's own size boundaries", () => {
    // FallbackAvatar.getSizeByDp: SMALL under 32, LARGE at 80 and up.
    expect(noteStripFor(31)).toBe(noteStripFor(16));
    expect(noteStripFor(32)).toBe(noteStripFor(48));
    expect(noteStripFor(79)).toBe(noteStripFor(48));
    expect(noteStripFor(80)).toBe(noteStripFor(400));
  });

  it("uses Signal's own label", () => {
    expect(NOTE_TO_SELF_NAME).toBe("Note to Self");
  });
});
