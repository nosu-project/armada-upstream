/**
 * The warm-up's persistence discipline: a control sweep that came up short
 * must not become the client's durable baseline.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  truncated: false,
  writeFolded: vi.fn(async () => undefined),
}));

vi.mock("@/concord-v2/lib/planeSync", () => ({
  controlSweepTruncated: () => h.truncated,
  sweepControl: async () => [],
  sweepGuestbook: async () => [],
  whenAuthSettled: async () => undefined,
}));
vi.mock("@/concord-v2/lib/rumorStore", () => ({
  pruneControlSnapshots: async () => undefined,
  queryPlane: async () => [],
  writeRumors: async () => undefined,
}));
vi.mock("@/concord-v2/lib/streamAuth", () => ({ registerStreamKeys: () => undefined }));
vi.mock("@/lib/foldedCache", () => ({ writeFolded: h.writeFolded }));
vi.mock("@/lib/syncActivity", () => ({
  beginSyncTask: () => ({ update: () => undefined, end: () => undefined }),
}));
vi.mock("@/wire/bus", () => ({ emitWireScopes: () => undefined }));
vi.mock("@/concord-v2/lib/chat", () => ({ openChatBatch: async () => [] }));
vi.mock("@/concord-v2/lib/community", () => ({ channelsView: () => [] }));
vi.mock("@/concord-v2/lib/guestbook", () => ({ guestbookGroups: () => [] }));
vi.mock("@/concord-v2/lib/control", () => ({
  controlFoldKey: (idHex: string) => `concord2-fold:${idHex}`,
  controlGroups: () => [{ pk: "aa".repeat(32) }],
  openControlEditions: () => [],
  foldControlState: () => ({ channels: new Map(), banned: new Set(), heads: new Map(), incomplete: [] }),
}));
vi.mock("@/concord-v2/lib/communityList", () => ({
  rehydrateCommunity: () => ({ idHex: "cc".repeat(32), relays: ["wss://relay.test"] }),
}));

const { warmupCommunities2 } = await import("@/concord-v2/lib/loginWarmup");

const nostr = { relay: () => ({ query: async () => [] }) };

describe("warmupCommunities2 persistence gate", () => {
  beforeEach(() => {
    h.truncated = false;
    h.writeFolded.mockClear();
  });

  it("persists the fold when the sweep ran its course", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await warmupCommunities2(nostr as any, [{} as any]);
    expect(h.writeFolded).toHaveBeenCalled();
  });

  it("does not persist a fold from a sweep that hit its budget", async () => {
    // The reported ban-evasion: any member can inflate the control plane past
    // any budget, and a cold login folding under that flood would otherwise
    // freeze a ban-less roster on disk for every later launch. The fold still
    // renders this session — it just doesn't get to become the baseline.
    h.truncated = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await warmupCommunities2(nostr as any, [{} as any]);
    expect(h.writeFolded).not.toHaveBeenCalled();
  });
});
