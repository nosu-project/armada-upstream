import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { EventTemplate, NostrEvent } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";

import { guestbookGroupKey, random32, bytesToHex } from "@/concord-v2/lib/derive";
import {
  buildJoinRumor,
  buildKickRumor,
  buildLeaveRumor,
  buildSnapshotRumors,
  coalesceGuestbook,
  completeMemberlist,
  openGuestbookWraps,
  sealGuestbook,
} from "@/concord-v2/lib/guestbook";

function signer(sk = generateSecretKey()) {
  return { sk, pubkey: getPublicKey(sk), signEvent: async (t: EventTemplate) => finalizeEvent(t, sk) };
}

const root = new Uint8Array(32).fill(6);
const cid = new Uint8Array(32).fill(7);
const gb = guestbookGroupKey(root, cid, 0);

const allowAllKicks = () => true;
const denyAllKicks = () => false;

describe("guestbook coalesce (CORD-02 §5)", () => {
  it("one final state per npub — the latest entry wins", async () => {
    const alice = signer();
    const wraps: NostrEvent[] = [
      await sealGuestbook(buildJoinRumor(alice.pubkey, 1000), gb, alice),
      await sealGuestbook(buildLeaveRumor(alice.pubkey, 2000), gb, alice),
      await sealGuestbook(buildJoinRumor(alice.pubkey, 3000), gb, alice),
    ];
    const coalesced = coalesceGuestbook(openGuestbookWraps(wraps, [gb]), { nowMs: 10_000, canKick: denyAllKicks });
    expect(coalesced.get(alice.pubkey)?.state).toBe("join");
    expect(coalesced.get(alice.pubkey)?.ms).toBe(3000);
  });

  it("drops entries dated more than one hour ahead of the local clock", async () => {
    const alice = signer();
    const now = 1_000_000_000_000;
    const wraps = [
      await sealGuestbook(buildJoinRumor(alice.pubkey, now), gb, alice),
      await sealGuestbook(buildLeaveRumor(alice.pubkey, now + 2 * 60 * 60 * 1000), gb, alice), // 2h future
    ];
    const coalesced = coalesceGuestbook(openGuestbookWraps(wraps, [gb]), { nowMs: now, canKick: denyAllKicks });
    expect(coalesced.get(alice.pubkey)?.state).toBe("join"); // the forged-future leave was dropped
  });

  it("a kick is honored only from an authorized actor", async () => {
    const alice = signer();
    const admin = signer();
    const rando = signer();
    const wraps = [
      await sealGuestbook(buildJoinRumor(alice.pubkey, 1000), gb, alice),
      await sealGuestbook(buildKickRumor(rando.pubkey, alice.pubkey, 2000), gb, rando),
    ];
    const opened = openGuestbookWraps(wraps, [gb]);
    const unauthorized = coalesceGuestbook(opened, { nowMs: 10_000, canKick: (actor) => actor === admin.pubkey });
    expect(unauthorized.get(alice.pubkey)?.state).toBe("join");

    const kicked = [...wraps, await sealGuestbook(buildKickRumor(admin.pubkey, alice.pubkey, 3000), gb, admin)];
    const authorized = coalesceGuestbook(openGuestbookWraps(kicked, [gb]), {
      nowMs: 10_000,
      canKick: (actor) => actor === admin.pubkey,
    });
    expect(authorized.get(alice.pubkey)?.state).toBe("kick");
  });

  it("a snapshot seeds members but any newer self-signed entry supersedes it", async () => {
    const refounder = signer();
    const alice = signer();
    const bob = signer();
    const snapId = bytesToHex(random32());
    const rumors = buildSnapshotRumors(refounder.pubkey, [alice.pubkey, bob.pubkey], snapId, 5000);
    const wraps: NostrEvent[] = [];
    for (const r of rumors) wraps.push(await sealGuestbook(r, gb, refounder));
    wraps.push(await sealGuestbook(buildLeaveRumor(bob.pubkey, 6000), gb, bob));

    const coalesced = coalesceGuestbook(openGuestbookWraps(wraps, [gb]), {
      nowMs: 10_000,
      canKick: denyAllKicks,
      snapshotAuthority: refounder.pubkey,
    });
    expect(coalesced.get(alice.pubkey)?.state).toBe("join");
    expect(coalesced.get(alice.pubkey)?.fromSnapshot).toBe(true);
    expect(coalesced.get(bob.pubkey)?.state).toBe("leave");
  });

  it("a snapshot from anyone but the epoch's refounder is ignored", async () => {
    const refounder = signer();
    const impostor = signer();
    const alice = signer();
    const rumors = buildSnapshotRumors(impostor.pubkey, [alice.pubkey], bytesToHex(random32()), 5000);
    const wraps: NostrEvent[] = [];
    for (const r of rumors) wraps.push(await sealGuestbook(r, gb, impostor));
    const coalesced = coalesceGuestbook(openGuestbookWraps(wraps, [gb]), {
      nowMs: 10_000,
      canKick: allowAllKicks,
      snapshotAuthority: refounder.pubkey,
    });
    expect(coalesced.size).toBe(0);
  });

  it("chunks snapshots at 400 members with one shared id", () => {
    const refounder = signer();
    const members = Array.from({ length: 950 }, () => bytesToHex(random32()));
    const rumors = buildSnapshotRumors(refounder.pubkey, members, bytesToHex(random32()), 5000);
    expect(rumors.length).toBe(3);
    const tags = rumors.map((r) => r.tags.find((t) => t[0] === "snap")!);
    expect(new Set(tags.map((t) => t[1])).size).toBe(1); // one snapshot id
    expect(tags.map((t) => t[2])).toEqual(["1", "2", "3"]);
    expect(tags.every((t) => t[3] === "3")).toBe(true);
  });
});

describe("complete memberlist", () => {
  it("guestbook ∪ observed − banned, with observation counting only forward", async () => {
    const alice = signer();
    const bob = signer();
    const carol = signer();
    const wraps = [
      await sealGuestbook(buildJoinRumor(alice.pubkey, 1000), gb, alice),
      await sealGuestbook(buildLeaveRumor(bob.pubkey, 5000), gb, bob),
    ];
    const coalesced = coalesceGuestbook(openGuestbookWraps(wraps, [gb]), { nowMs: 10_000, canKick: denyAllKicks });

    // Bob's OLD activity (before his leave) can't resurrect him; carol was
    // never in the guestbook but is observably present.
    const observed = new Map<string, number>([
      [bob.pubkey, 4000],
      [carol.pubkey, 8000],
      [alice.pubkey, 2000],
    ]);
    const members = completeMemberlist(coalesced, observed, new Set([carol.pubkey]));
    expect(members.has(alice.pubkey)).toBe(true);
    expect(members.has(bob.pubkey)).toBe(false);
    expect(members.has(carol.pubkey)).toBe(false); // banned

    // Bob speaks AFTER his leave → observably present again.
    const rejoined = completeMemberlist(coalesced, new Map([[bob.pubkey, 6000]]), new Set());
    expect(rejoined.has(bob.pubkey)).toBe(true);
  });
});
