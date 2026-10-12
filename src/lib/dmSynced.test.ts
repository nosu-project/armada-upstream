// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import { readDmPullFloor, writeDmPullFloor } from "@/lib/dmSynced";
import { seedDmCursors } from "@/hooks/useDirectMessages";

beforeEach(() => localStorage.clear());

describe("kind-4 pull floor", () => {
  it("is restored for the same relay set and peer set", () => {
    writeDmPullFloor("me", "wss://a,wss://b", "p1,p2", 1_000);
    expect(readDmPullFloor("me", "wss://a,wss://b", "p1,p2")).toBe(1_000);
  });

  it("is absent for a new relay or a newly established peer", () => {
    writeDmPullFloor("me", "wss://a", "p1", 1_000);
    expect(readDmPullFloor("me", "wss://a,wss://b", "p1")).toBeUndefined();
    expect(readDmPullFloor("me", "wss://a", "p1,p2")).toBeUndefined();
    expect(readDmPullFloor("other", "wss://a", "p1")).toBeUndefined();
  });

  it("is purged with the rest of Armada's storage", () => {
    writeDmPullFloor("me", "wss://a", "", 1_000);
    const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i));
    expect(keys).toHaveLength(1);
    expect(keys[0]?.startsWith("armada:")).toBe(true);
  });
});

describe("seedDmCursors()", () => {
  it("pages every relay back from below the oldest stored message", () => {
    const stored = [{ created_at: 500 }, { created_at: 300 }] as never[];
    expect(seedDmCursors(["wss://a", "wss://b"], stored)).toEqual({
      "wss://a": { sent: 299, received: 299 },
      "wss://b": { sent: 299, received: 299 },
    });
  });

  it("starts from the top when nothing is stored", () => {
    expect(seedDmCursors(["wss://a"], [])).toEqual({ "wss://a": { sent: undefined, received: undefined } });
  });
});
