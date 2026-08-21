/**
 * Live call enforcement decision (CORD-07 §1/§7). These tests pin the promise
 * "Removal from the Channel IS removal from its calls" to concrete behavior:
 * an epoch roll rejoins the freshly-derived room, a ban/removal hangs up, and
 * transiently-missing data never tears a call down.
 */

import { describe, expect, it } from "vitest";

import {
  banVerdictPostdatesMembership,
  decideCallSync,
  type CallSyncDecision,
} from "@/concord/lib/callSync";
import { channelsView, mintCommunity } from "@/concord/lib/community";
import type { FoldedChannel, FoldedControl } from "@/concord/lib/control";
import { bytesToHex, random32 } from "@/concord/lib/derive";
import type { Channel, Community } from "@/concord/lib/types";

const OWNER = bytesToHex(random32());

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

/** Mint a community + its #general channel, plus the folded def naming it. */
function fixture(): { community: Community; channel: Channel; generalId: Uint8Array } {
  const { community, generalChannelId } = mintCommunity("Fleet", OWNER, ["wss://relay.example"]);
  const folded = foldedWith([
    { channelIdHex: bytesToHex(generalChannelId), name: "general", isPrivate: false, deleted: false, metadata: { name: "general", private: false } },
  ]);
  const [channel] = channelsView(community, folded);
  return { community, channel, generalId: generalChannelId };
}

function snapOf(channel: Channel) {
  return { channelIdHex: channel.idHex, epoch: channel.current.epoch, roomPk: channel.voice.room.pk };
}

describe("banVerdictPostdatesMembership", () => {
  const me = bytesToHex(random32());

  it("is true only when the ban edition postdates my join", () => {
    const bannedAt = new Map([[me, 2_000]]); // seconds
    const folded = foldedWith([], { banned: [me], bannedAt });
    // Joined BEFORE the ban (ms): a judgment on this membership.
    expect(banVerdictPostdatesMembership(folded, me, 1_000_000)).toBe(true);
    // Joined AFTER the ban (ms > bannedAt*1000): a stale, superseded sentence.
    expect(banVerdictPostdatesMembership(folded, me, 3_000_000)).toBe(false);
  });

  it("ignores an unbanned member and the owner", () => {
    const folded = foldedWith([], { banned: [OWNER], bannedAt: new Map([[OWNER, 1]]) });
    expect(banVerdictPostdatesMembership(folded, OWNER, 0)).toBe(false);
    expect(banVerdictPostdatesMembership(folded, me, 0)).toBe(false);
  });

  it("is false with missing inputs", () => {
    expect(banVerdictPostdatesMembership(undefined, me, 0)).toBe(false);
    expect(banVerdictPostdatesMembership(foldedWith([]), me, undefined)).toBe(false);
    expect(banVerdictPostdatesMembership(foldedWith([]), undefined, 0)).toBe(false);
  });
});

describe("decideCallSync", () => {
  it("stays when nothing has changed", () => {
    const { community, channel } = fixture();
    const folded = foldedWith([
      { channelIdHex: channel.idHex, name: "general", isPrivate: false, deleted: false, metadata: { name: "general", private: false } },
    ]);
    const decision = decideCallSync({
      snapshot: snapOf(channel),
      listLoaded: true,
      community,
      folded,
      channels: [channel],
      selfBanned: false,
      selfKicked: false,
    });
    expect(decision).toEqual<CallSyncDecision>({ action: "stay" });
  });

  it("rejoins the freshly-derived room after an epoch roll", () => {
    const { community, channel } = fixture();
    // Simulate a Refounding: the vault advanced to epoch 1 with a new root.
    const rekeyed: Community = {
      ...community,
      root: random32(),
      rootEpoch: 1n,
      heldRoots: [{ epoch: 1n, key: random32() }, ...community.heldRoots],
    };
    const folded = foldedWith([
      { channelIdHex: channel.idHex, name: "general", isPrivate: false, deleted: false, metadata: { name: "general", private: false } },
    ]);
    const liveChannels = channelsView(rekeyed, folded);

    const decision = decideCallSync({
      snapshot: snapOf(channel), // still parked at epoch 0's room
      listLoaded: true,
      community: rekeyed,
      folded,
      channels: liveChannels,
      selfBanned: false,
      selfKicked: false,
    });

    expect(decision.action).toBe("rejoin");
    if (decision.action !== "rejoin") throw new Error("unreachable");
    // The rejoin target is a genuinely different SFU room under a new epoch —
    // exactly what a removed member cannot derive.
    expect(decision.channel.current.epoch).toBe(1n);
    expect(decision.channel.voice.room.pk).not.toBe(channel.voice.room.pk);
    expect(decision.community).toBe(rekeyed);
  });

  it("hangs up when a ban names this membership", () => {
    const { community, channel } = fixture();
    const folded = foldedWith([
      { channelIdHex: channel.idHex, name: "general", isPrivate: false, deleted: false, metadata: { name: "general", private: false } },
    ]);
    const decision = decideCallSync({
      snapshot: snapOf(channel),
      listLoaded: true,
      community,
      folded,
      channels: [channel],
      selfBanned: true,
      selfKicked: false,
    });
    expect(decision).toEqual<CallSyncDecision>({ action: "leave", reason: "banned" });
  });

  it("hangs up once the vault entry is gone (left / self-removed)", () => {
    const { channel } = fixture();
    const decision = decideCallSync({
      snapshot: snapOf(channel),
      listLoaded: true,
      community: undefined,
      folded: undefined,
      channels: [],
      selfBanned: false,
      selfKicked: false,
    });
    expect(decision).toEqual<CallSyncDecision>({ action: "leave", reason: "removed" });
  });

  it("hangs up when the channel is gone from the live view", () => {
    const { community, channel } = fixture();
    // The fold is live (deleted flag set) but the channel is dropped from view.
    const folded = foldedWith([
      { channelIdHex: channel.idHex, name: "general", isPrivate: false, deleted: true, metadata: { name: "general", private: false } },
    ]);
    const decision = decideCallSync({
      snapshot: snapOf(channel),
      listLoaded: true,
      community,
      folded,
      channels: channelsView(community, folded), // empty (deleted dropped)
      selfBanned: false,
      selfKicked: false,
    });
    expect(decision).toEqual<CallSyncDecision>({ action: "leave", reason: "channel-gone" });
  });

  it("stays put while data is still loading (fail-safe)", () => {
    const { community, channel } = fixture();
    // List not loaded yet, fold undefined: never tear down on transient gaps.
    expect(
      decideCallSync({
        snapshot: snapOf(channel),
        listLoaded: false,
        community: undefined,
        folded: undefined,
        channels: [],
        selfBanned: false,
        selfKicked: false,
      }),
    ).toEqual<CallSyncDecision>({ action: "stay" });
    // Community present but fold not yet folded.
    expect(
      decideCallSync({
        snapshot: snapOf(channel),
        listLoaded: true,
        community,
        folded: undefined,
        channels: [],
        selfBanned: false,
        selfKicked: false,
      }),
    ).toEqual<CallSyncDecision>({ action: "stay" });
  });

  it("hangs up when a Guestbook kick names this membership", () => {
    const { community, channel } = fixture();
    const folded = foldedWith([
      { channelIdHex: channel.idHex, name: "general", isPrivate: false, deleted: false, metadata: { name: "general", private: false } },
    ]);
    // A kick rotates NOTHING: the epoch, the room and the media key are all
    // unchanged, so the member's client would happily stay connected. This
    // hang-up is the entire effect a kick has on a live call.
    const decision = decideCallSync({
      snapshot: snapOf(channel),
      listLoaded: true,
      community,
      folded,
      channels: [channel],
      selfBanned: false,
      selfKicked: true,
    });
    expect(decision).toEqual<CallSyncDecision>({ action: "leave", reason: "kicked" });
  });

  it("reports a ban rather than a kick when both name me", () => {
    const { community, channel } = fixture();
    const folded = foldedWith([
      { channelIdHex: channel.idHex, name: "general", isPrivate: false, deleted: false, metadata: { name: "general", private: false } },
    ]);
    const decision = decideCallSync({
      snapshot: snapOf(channel),
      listLoaded: true,
      community,
      folded,
      channels: [channel],
      selfBanned: true,
      selfKicked: true,
    });
    expect(decision).toEqual<CallSyncDecision>({ action: "leave", reason: "banned" });
  });
});
