/**
 * Regression test for issue #19 — orphan replies are unreachable in the UI.
 *
 * The V2 timeline is Slack-style: a message carrying a `q` (reply) tag is
 * excluded from the top-level timeline and surfaced only via
 * `threadRepliesFor(rootId)` on its root's rendered row. If the root is not in
 * the loaded window (older than the 100-rumor window, undecoded, or missing),
 * the reply is bucketed under a row that never renders: no message, no thread
 * badge, no way to reach it. The user is notified (the native service decrypts
 * the wrap directly) but the client never shows the message — at ANY traffic
 * volume, on every platform, deterministically. A bot that always replies is
 * the archetypal victim.
 *
 * The test asserts the DESIRED invariant — every decoded message is reachable
 * from the rendered timeline — so it fails until the bug is fixed.
 */

import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { OpenedChat } from "@/concord-v2/lib/chat";
import { KIND_MESSAGE, KIND_SEAL_ENCRYPTED } from "@/concord-v2/lib/kinds";
import type { ChannelV2, CommunityV2 } from "@/concord-v2/lib/types";

import { useTransport2 } from "./useTransport2";

import type { NostrEvent } from "@nostrify/nostrify";

// ── Module mocks ─────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({
  folded: { messages: [] as unknown[], reactions: new Map() },
}));

vi.mock("@/concord-v2/hooks/useChannel2", () => ({
  useChannelTimeline2: () => ({
    folded: h.folded,
    isLoading: false,
    loadOlder: async () => 0,
    hasMore: false,
    isLoadingOlder: false,
  }),
  useSendMessage2: () => ({ mutateAsync: async () => ({}) }),
  useMessageActions2: () => ({ retry: () => {}, discard: () => {}, deleteMessage: () => {} }),
  useSendStatus2: () => ({}),
}));
vi.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ user: undefined }),
}));

// ── Fixtures ─────────────────────────────────────────────────────────────────

const CHANNEL_ID = "aa".repeat(32);

function chat(id: string, content: string, ms: number, tags: string[][] = []): OpenedChat {
  return {
    rumorId: id.padEnd(64, "0"),
    author: "b".repeat(64),
    kind: KIND_MESSAGE,
    content,
    tags: [["channel", CHANNEL_ID], ["epoch", "0"], ...tags],
    ms,
    createdAt: Math.floor(ms / 1000),
    wrapId: "c".repeat(64),
    streamPk: "d".repeat(64),
    sealKind: KIND_SEAL_ENCRYPTED,
    seal: {} as NostrEvent,
    channelIdHex: CHANNEL_ID,
    epoch: 0n,
  };
}

const community = { idHex: "cc".repeat(32), relays: [] } as unknown as CommunityV2;
const channel = { idHex: CHANNEL_ID } as unknown as ChannelV2;

// ── Test ─────────────────────────────────────────────────────────────────────

describe("useTransport2 — issue #19 (orphan replies are unreachable)", () => {
  it("keeps every decoded message reachable from the rendered timeline, even a reply whose root is outside the window", () => {
    const PARENT_ID = "11".repeat(32); // NOT in the decoded window (older history)
    const reply = chat("22".repeat(32), "reply to an old message", 2_000_000, [
      ["q", PARENT_ID, "", "e".repeat(64)],
    ]);
    const normal = chat("33".repeat(32), "ordinary top-level message", 3_000_000);
    h.folded = { messages: [reply, normal], reactions: new Map() };

    const { result } = renderHook(() => useTransport2(community, channel, true, false));
    const { transport } = result.current;

    // Everything the UI can possibly render: the top-level rows plus the
    // thread replies reachable from those rows.
    const reachable = new Set(transport.messages.map((m) => m.id));
    for (const m of transport.messages) {
      for (const r of transport.threadRepliesFor?.(m.id) ?? []) reachable.add(r.id);
    }

    expect(reachable.has(normal.rumorId)).toBe(true);
    // Desired: the reply is reachable — rendered top-level (degraded), or its
    // root is materialized so the thread can open. (Bug: it's bucketed under a
    // root row that never renders — decoded, present in memory, invisible.)
    expect(
      reachable.has(reply.rumorId),
      "a decoded reply whose root is outside the loaded window must still be reachable in the UI",
    ).toBe(true);
  });
});
