import { describe, expect, it } from "vitest";

import { shouldShowDmTimelineLoading } from "./useDmTransport";

describe("shouldShowDmTimelineLoading", () => {
  it("holds the skeleton only while nothing is painted and a plane is reading", () => {
    expect(shouldShowDmTimelineLoading(0, true, true, true)).toBe(true);
    expect(shouldShowDmTimelineLoading(0, true, false, true)).toBe(true);
    expect(shouldShowDmTimelineLoading(0, false, true, true)).toBe(true);
  });

  it("settles once both planes' local reads are done", () => {
    expect(shouldShowDmTimelineLoading(0, false, false, true)).toBe(false);
  });

  it("paints a NIP-17 thread without waiting on the kind-4 plane", () => {
    // The regression: a modern conversation has its whole history as rumors
    // and zero local kind-4 rows, so the kind-4 half stayed loading through a
    // relay round for messages that don't exist — and the OR'd gate hid every
    // already-folded rumor behind a skeleton for the whole of it.
    expect(shouldShowDmTimelineLoading(42, true, false, true)).toBe(false);
  });

  it("paints a legacy thread without waiting on the NIP-17 plane", () => {
    expect(shouldShowDmTimelineLoading(42, false, true, true)).toBe(false);
  });

  it("paints a snapshot-seeded thread once NIP-17's first paint has resolved", () => {
    // The KV/localStorage prewarm exists precisely to put rows on screen
    // before either store read lands; the gate must not overrule it.
    expect(shouldShowDmTimelineLoading(12, true, true, true)).toBe(false);
  });

  it("holds until NIP-17's first local paint resolves, even with kind-4 painted", () => {
    // The flicker: kind-4 seeds a paint SYNCHRONOUSLY (frame 0) while NIP-17's
    // snapshot lands a KV hop later. Painting the kind-4 half alone and then
    // reflowing the NIP-17 rows in beneath it is the flash. Hold the merged
    // skeleton across that one hop so both snapshots paint together — even
    // though kind-4 rows already exist to show.
    expect(shouldShowDmTimelineLoading(7, false, false, false)).toBe(true);
    expect(shouldShowDmTimelineLoading(0, false, false, false)).toBe(true);
  });
});
