import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Community } from "@/concord/lib/types";

const h = vi.hoisted(() => ({
  releaseSweep: undefined as undefined | (() => void),
  backfillSignals: [] as AbortSignal[],
}));

vi.mock("@nostrify/react", () => ({ useNostr: () => ({ nostr: { query: async () => [] } }) }));
vi.mock("@/concord/hooks/useControlPlane", () => {
  const channels = [{ idHex: "aa".repeat(32), name: "general", isPrivate: false, streams: [] }];
  const folded = { incomplete: [], channels: new Map(), roster: { grants: [] }, metadata: undefined };
  return { useChannels: () => channels, useControlFold: () => ({ data: folded }) };
});
vi.mock("@/concord/hooks/useChannel", () => ({ useChatModeration: () => undefined }));
vi.mock("@/hooks/useBlossomServers", () => ({ useBlossomServers: () => [] }));
vi.mock("@/hooks/useMediaPolicy", () => ({ useMediaPolicy: () => ({}) }));
vi.mock("@/concord/lib/planeSync", () => ({
  sweepControl: () => new Promise<void>((r) => { h.releaseSweep = r; }),
  controlSweepQuorum: () => true,
  controlSweepRelayReached: () => true,
  controlSweepTruncated: () => false,
}));
vi.mock("@/concord/lib/channelSync", () => ({
  backfillStore: async (_n: unknown, _r: unknown, _c: unknown, signal: AbortSignal) => {
    h.backfillSignals.push(signal);
    return { events: [], exhausted: true, failed: false };
  },
}));
vi.mock("@/concord/lib/rumorStore", () => ({
  queryChannelRumors: async () => [],
  writeRumors: async () => true,
}));

import { useHistoryAudit } from "@/concord/hooks/useHistoryAudit";

describe("useHistoryAudit unmount", () => {
  it("aborts the running audit, so nothing is backfilled after unmount", async () => {
    const community = { idHex: "cc".repeat(32), relays: ["wss://r"], name: "c" } as unknown as Community;
    const { result, unmount } = renderHook(() => useHistoryAudit(community));

    let done!: Promise<unknown>;
    act(() => { done = result.current.run({ embedAssets: false }); });
    await vi.waitFor(() => expect(h.releaseSweep).toBeDefined());

    unmount();
    h.releaseSweep!(); // the in-flight control sweep returns after unmount
    await expect(done).resolves.toBeUndefined();

    expect(h.backfillSignals).toEqual([]);
  });
});
