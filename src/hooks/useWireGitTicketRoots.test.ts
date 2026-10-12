import { describe, expect, it } from "vitest";

import { childBackfillRootIds } from "@/hooks/useWireGitTicketRoots";
import type { NostrRumor } from "@/lib/nostrRumor";

const OWNER = "a".repeat(64);
const MIRROR = "b".repeat(64);
const MAIN = `30617:${OWNER}:armada`;
const FORK = `30617:${MIRROR}:armada`;

function issue(id: string, ...addresses: string[]): NostrRumor {
  return {
    id: id.repeat(64).slice(0, 64),
    kind: 1621,
    pubkey: OWNER,
    created_at: 1,
    content: "",
    tags: [...addresses.map((a) => ["a", a]), ["subject", "x"]],
  };
}

describe("childBackfillRootIds()", () => {
  it("skips a root another repository owns, on a relay only the other lists", () => {
    // Tagged with both, owned by the first the client knows: MAIN. A relay that
    // carries only FORK never gets the wire's child filter for it.
    const both = issue("1", MAIN, FORK);
    const known = new Set([MAIN, FORK]);
    expect(childBackfillRootIds([both], new Set([FORK]), known, undefined)).toEqual([]);
    expect(childBackfillRootIds([both], new Set([MAIN]), known, undefined)).toEqual([both.id]);
  });

  it("skips roots whose children a past round covered", () => {
    const root = issue("2", MAIN);
    const key = root.id.slice(0, 16);
    const ledger = { "100": [`c:${key}`, `s:${key}`] };
    expect(childBackfillRootIds([root], new Set([MAIN]), new Set([MAIN]), ledger)).toEqual([]);
    expect(childBackfillRootIds([root], new Set([MAIN]), new Set([MAIN]), { "100": [`c:${key}`] })).toEqual([root.id]);
  });
});
