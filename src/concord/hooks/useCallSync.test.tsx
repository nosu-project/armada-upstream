/**
 * Live call enforcement wiring (CORD-07 §1/§7): while connected, the call must
 * follow the vault + Control fold — rejoin the freshly-derived room on an
 * epoch roll (the rotation that severs a removed member from chat must move
 * the call too) and hang up on a ban verdict or vault removal. Before this
 * hook, the connected room was a join-time snapshot nothing ever refreshed:
 * a Ban→Refounding left everyone parked in the OLD room the banned member
 * could still derive, and a banned member's own client never disconnected.
 */

import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

import { channelsView, mintCommunity } from "@/concord/lib/community";
import type { FoldedChannel, FoldedControl } from "@/concord/lib/control";
import { bytesToHex, random32 } from "@/concord/lib/derive";
import type { CommunityListEntry } from "@/concord/lib/communityList";
import type { Channel, Community } from "@/concord/lib/types";
import type { ConcordVoiceContext } from "@/contexts/CallContext";

import { useCallSync } from "./useCallSync";

// ── Module mocks ─────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({
  join: vi.fn(),
  user: undefined as unknown,
  listData: undefined as unknown,
  community: undefined as Community | undefined,
  entry: undefined as CommunityListEntry | undefined,
  folded: undefined as FoldedControl | undefined,
  coalesced: new Map<string, { state: string; ms: number }>(),
}));

vi.mock("@/hooks/useCall", () => ({
  useCall: () => ({ joinConcordCall: h.join }),
}));
vi.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ user: h.user }),
}));
vi.mock("@/concord/hooks/useControlPlane", () => ({
  useControlFold: () => ({ data: h.folded }),
}));
vi.mock("@/concord/hooks/useGuestbook", () => ({
  useGuestbook: () => ({ coalesced: h.coalesced }),
}));
vi.mock("@/concord/hooks/useCommunityList", () => ({
  useCommunityList: () => ({ data: h.listData }),
  useCommunity: () => h.community,
  useCommunityEntry: () => h.entry,
}));

// ── Fixtures ─────────────────────────────────────────────────────────────────

const OWNER = bytesToHex(random32());
const ME = bytesToHex(random32());
const BROKER = "https://broker.example";

function foldedWith(
  channels: FoldedChannel[],
  opts?: { banned?: string[]; bannedAt?: Map<string, number> },
): FoldedControl {
  return {
    roster: [],
    ownerHex: OWNER,
    metadata: undefined,
    channels: new Map(channels.map((c) => [c.channelIdHex, c])),
    banned: new Set(opts?.banned ?? []),
    bannedAt: opts?.bannedAt ?? new Map(),
    liveInviteLinks: new Set(),
    registriesByCreator: new Map(),
    heads: new Map(),
    headEditions: new Map(),
    incomplete: [],
  } as unknown as FoldedControl;
}

function fixture(): { community: Community; channel: Channel; folded: FoldedControl } {
  const { community, generalChannelId } = mintCommunity("Fleet", OWNER, ["wss://relay.example"]);
  const folded = foldedWith([
    { channelIdHex: bytesToHex(generalChannelId), name: "general", isPrivate: false, deleted: false, metadata: { name: "general", private: false } },
  ]);
  const [channel] = channelsView(community, folded);
  return { community, channel, folded };
}

function setup(community: Community, channel: Channel, folded: FoldedControl) {
  h.join = vi.fn();
  h.user = { pubkey: ME };
  h.listData = { event: null, list: { entries: [], tombstones: [] } };
  h.community = community;
  h.entry = { community_id: community.idHex, added_at: Date.now() } as unknown as CommunityListEntry;
  h.folded = folded;
  h.coalesced = new Map();
  const ctx: ConcordVoiceContext = { community, channel, broker: BROKER };
  const onLeave = vi.fn();
  const view = renderHook(() => useCallSync(ctx, onLeave));
  return { ctx, onLeave, view };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("useCallSync", () => {
  it("does nothing while the live state matches the snapshot", () => {
    const { community, channel, folded } = fixture();
    const { onLeave } = setup(community, channel, folded);
    expect(h.join).not.toHaveBeenCalled();
    expect(onLeave).not.toHaveBeenCalled();
  });

  it("rejoins the new room when the vault adopts a rekey mid-call", () => {
    const { community, channel, folded } = fixture();
    const { onLeave, view } = setup(community, channel, folded);

    // A Refounding lands: the vault's entry advances to epoch 1 / a new root.
    h.community = {
      ...community,
      root: random32(),
      rootEpoch: 1n,
      heldRoots: [{ epoch: 1n, key: random32() }, ...community.heldRoots],
    };
    view.rerender();

    expect(onLeave).not.toHaveBeenCalled();
    expect(h.join).toHaveBeenCalledTimes(1);
    const next = h.join.mock.calls[0][0] as ConcordVoiceContext;
    // Same channel, same broker — but the freshly-derived epoch-1 room the
    // removed member cannot derive (CORD-07 §1 severance).
    expect(next.channel.idHex).toBe(channel.idHex);
    expect(next.broker).toBe(BROKER);
    expect(next.channel.current.epoch).toBe(1n);
    expect(next.channel.voice.room.pk).not.toBe(channel.voice.room.pk);
    expect(bytesToHex(next.channel.voice.mediaKey)).not.toBe(bytesToHex(channel.voice.mediaKey));
  });

  it("hangs up when the folded Banlist names this membership", () => {
    const { community, channel, folded } = fixture();
    const { onLeave, view } = setup(community, channel, folded);

    // A ban verdict postdating my join lands in the fold.
    h.folded = foldedWith(
      [{ channelIdHex: channel.idHex, name: "general", isPrivate: false, deleted: false, metadata: { name: "general", private: false } }],
      { banned: [ME], bannedAt: new Map([[ME, Math.floor(Date.now() / 1000) + 60]]) },
    );
    view.rerender();

    expect(onLeave).toHaveBeenCalledTimes(1);
    expect(h.join).not.toHaveBeenCalled();
  });

  it("hangs up when the coalesced Guestbook kicks this membership", () => {
    const { community, channel, folded } = fixture();
    const { onLeave, view } = setup(community, channel, folded);

    // A kick rolls no epoch and no room key, so nothing else in this watcher
    // would ever notice it — the compliance IS the removal.
    h.coalesced = new Map([[ME, { state: "kick", ms: Date.now() + 60_000 }]]);
    view.rerender();

    expect(onLeave).toHaveBeenCalledTimes(1);
    expect(h.join).not.toHaveBeenCalled();
  });

  it("ignores a kick that predates re-admission", () => {
    const { community, channel, folded } = fixture();
    const { onLeave, view } = setup(community, channel, folded);

    // The Guestbook still carries the kick that preceded this rejoin; the
    // fresh Join hasn't swept back around yet.
    h.coalesced = new Map([[ME, { state: "kick", ms: 1 }]]);
    view.rerender();

    expect(onLeave).not.toHaveBeenCalled();
    expect(h.join).not.toHaveBeenCalled();
  });

  it("ignores a stale ban verdict that predates re-admission", () => {
    const { community, channel, folded } = fixture();
    const { onLeave, view } = setup(community, channel, folded);

    // A compaction resurfaces an OLD sentence (bannedAt long before added_at).
    h.folded = foldedWith(
      [{ channelIdHex: channel.idHex, name: "general", isPrivate: false, deleted: false, metadata: { name: "general", private: false } }],
      { banned: [ME], bannedAt: new Map([[ME, 1]]) },
    );
    view.rerender();

    expect(onLeave).not.toHaveBeenCalled();
    expect(h.join).not.toHaveBeenCalled();
  });

  it("hangs up when the vault entry disappears (self-removal on ban, or leave)", () => {
    const { community, channel, folded } = fixture();
    const { onLeave, view } = setup(community, channel, folded);

    h.community = undefined;
    h.entry = undefined;
    view.rerender();

    expect(onLeave).toHaveBeenCalledTimes(1);
    expect(h.join).not.toHaveBeenCalled();
  });

  it("stays connected while the vault/fold are merely loading", () => {
    const { community, channel, folded } = fixture();
    const { onLeave, view } = setup(community, channel, folded);

    // Vault not loaded at all: community absent must NOT read as removal.
    h.listData = undefined;
    h.community = undefined;
    h.entry = undefined;
    h.folded = undefined;
    view.rerender();

    expect(onLeave).not.toHaveBeenCalled();
    expect(h.join).not.toHaveBeenCalled();
  });

  it("acts at most once per mount (the remount takes over after a rejoin)", () => {
    const { community, channel, folded } = fixture();
    const { onLeave, view } = setup(community, channel, folded);

    h.community = {
      ...community,
      root: random32(),
      rootEpoch: 1n,
      heldRoots: [{ epoch: 1n, key: random32() }, ...community.heldRoots],
    };
    view.rerender();
    view.rerender();
    // Even a later ban must not double-fire from THIS mount — the remounted
    // room's fresh watcher handles it.
    h.folded = foldedWith(
      [{ channelIdHex: channel.idHex, name: "general", isPrivate: false, deleted: false, metadata: { name: "general", private: false } }],
      { banned: [ME], bannedAt: new Map([[ME, Math.floor(Date.now() / 1000) + 60]]) },
    );
    view.rerender();

    expect(h.join).toHaveBeenCalledTimes(1);
    expect(onLeave).not.toHaveBeenCalled();
  });
});
