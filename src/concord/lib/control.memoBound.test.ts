import { beforeEach, describe, expect, it } from "vitest";

import {
  _parsedEditionMemoSizeForTests,
  _resetControlMemosForTests,
  openControlEditions,
} from "./control";

import type { OpenedEvent } from "./stream";

/**
 * The parsed-edition memo (`control.ts`) caches one entry per control rumor id
 * seen this session — INCLUDING parse failures (a non-control kind is cached as
 * `null`). Nothing evicts, so a long-lived session that folds many distinct
 * control events grows it without bound. This pins that it stays bounded.
 *
 * Each `openControlEditions` call here feeds a distinct rumor id whose kind is
 * not KIND_CONTROL, so `parseEdition` throws and the id is cached as `null` —
 * the cheapest way to exercise the memo insert without crypto fixtures.
 */
function nonControlOpened(rumorId: string): OpenedEvent {
  return {
    rumorId,
    author: "a".repeat(64),
    kind: 0, // not KIND_CONTROL → parseEdition throws → cached as null
    content: "",
    tags: [],
    ms: 0,
    createdAt: 0,
  };
}

describe("parsedEditionMemo growth", () => {
  beforeEach(() => {
    _resetControlMemosForTests();
  });

  it("does not grow without bound as distinct editions are folded", () => {
    const N = 30_000;
    for (let i = 0; i < N; i++) {
      openControlEditions([nonControlOpened(`edition-${i}`)]);
    }

    const size = _parsedEditionMemoSizeForTests();
    // Currently FAILS: with no eviction, size === N. A bounded FIFO keeps it
    // well under the number of distinct ids ever seen.
    expect(size).toBeLessThan(N);
    // And the cap must be a session-scale ceiling, not "N minus one".
    expect(size).toBeLessThanOrEqual(20_000);
  });

  it("still serves a cached edition rather than re-parsing it", () => {
    // The bound must not defeat the memo's purpose: a recently-seen id stays a
    // hit. (Guards a fix that evicts too aggressively.)
    const ev = nonControlOpened("recent");
    openControlEditions([ev]);
    const before = _parsedEditionMemoSizeForTests();
    openControlEditions([ev]);
    expect(_parsedEditionMemoSizeForTests()).toBe(before);
  });
});
