import { describe, expect, it } from "vitest";

import { filterChannelGitTicketRoots, gitTicketOlderCursor } from "./useChannelGitTicketRoots";

import type { NostrEvent } from "@nostrify/nostrify";

const address = `30617:${"a".repeat(64)}:armada`;
const attachment = { address: { kind: 30617 as const, owner: "a".repeat(64), identifier: "armada", coordinate: address }, relayHints: [], attachedAt: 100, detachedAt: 200 };
const event = (id: string, created_at: number, repository = address): NostrEvent => ({ id, kind: 1621, pubkey: "b".repeat(64), created_at, content: "body", tags: [["a", repository]], sig: "" });

describe("channel Git ticket root filtering", () => {
  it("keeps only roots in attachment intervals, dedupes relay delivery, and sorts deterministic oldest-first", () => {
    expect(filterChannelGitTicketRoots([
      event("z", 150), event("a", 150), event("a", 150), event("before", 99), event("after", 200), event("other", 150, `30617:${"c".repeat(64)}:other`),
    ], [attachment]).map((root) => root.id)).toEqual(["a", "z"]);
  });

  it("uses an exclusive cursor without crossing the attachment boundary", () => {
    expect(gitTicketOlderCursor([event("new", 150), event("old", 101)], [attachment])).toBe(100);
    expect(gitTicketOlderCursor([event("floor", 100)], [attachment])).toBeUndefined();
  });
});
