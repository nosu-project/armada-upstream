/**
 * The pending Guestbook Join's rules: kept until a relay takes it, re-sent as
 * the same wrap, re-sealed only for a new root epoch, backed off between
 * attempts, never published after a Leave forgot it, and a `duplicate:`
 * rejection counts as delivered.
 */
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { EventTemplate, NostrEvent } from "nostr-tools/pure";
import { afterEach, describe, expect, it } from "vitest";

import { mintCommunity } from "@/concord/lib/community";
import { resetKvCaches } from "@/lib/db/kvCache";
import { purgeArmadaDB } from "@/lib/db/armadaDB";

import {
  attemptGuestbookJoin,
  forgetGuestbookJoin,
  getPendingGuestbookJoin,
  pendingGuestbookJoinsReady,
  queueGuestbookJoin,
} from "./pendingGuestbookJoin";

const sk = generateSecretKey();
const viewer = getPublicKey(sk);
const signer = { signEvent: async (t: EventTemplate) => finalizeEvent(t, sk) };
const owner = getPublicKey(generateSecretKey());

/** Relays that all answer the same way, recording what they were sent. */
function relays(answer: () => Promise<void>) {
  const sent: NostrEvent[] = [];
  return { sent, relay: () => ({ event: (ev: NostrEvent) => (sent.push(ev), answer()) }) };
}

async function queued() {
  await pendingGuestbookJoinsReady();
  const { community } = mintCommunity("Fleet", owner, ["wss://a", "wss://b"]);
  queueGuestbookJoin({ viewer, communityIdHex: community.idHex, ms: 1_700_000_000_000 });
  return community;
}

afterEach(async () => {
  await purgeArmadaDB();
  resetKvCaches();
});

describe("pendingGuestbookJoin", () => {
  it("is forgotten once any relay accepts", async () => {
    const community = await queued();
    const net = relays(async () => undefined);
    expect(await attemptGuestbookJoin(net, community, signer, viewer)).toBe(true);
    expect(net.sent).toHaveLength(2);
    expect(getPendingGuestbookJoin(viewer, community.idHex)).toBeUndefined();
  });

  it("counts a `duplicate:` rejection as delivered", async () => {
    const community = await queued();
    const net = relays(async () => {
      throw new Error("duplicate: have this event");
    });
    expect(await attemptGuestbookJoin(net, community, signer, viewer)).toBe(true);
    expect(getPendingGuestbookJoin(viewer, community.idHex)).toBeUndefined();
  });

  it("keeps the sealed wrap with a backoff when nothing accepts, and re-sends that same wrap", async () => {
    const community = await queued();
    const down = relays(async () => {
      throw new Error("blocked");
    });
    const before = Date.now();
    expect(await attemptGuestbookJoin(down, community, signer, viewer)).toBe(false);
    const rec = getPendingGuestbookJoin(viewer, community.idHex)!;
    expect(rec.failures).toBe(1);
    expect(rec.nextAttemptAt).toBeGreaterThanOrEqual(before + 60_000);
    expect(rec.wrap?.id).toBe(down.sent[0].id);

    const up = relays(async () => undefined);
    expect(await attemptGuestbookJoin(up, community, signer, viewer)).toBe(true);
    expect(up.sent.map((e) => e.id)).toEqual([rec.wrap!.id, rec.wrap!.id]);
  });

  it("re-seals for the current root epoch rather than re-sending a stale one", async () => {
    const community = await queued();
    const down = relays(async () => {
      throw new Error("blocked");
    });
    await attemptGuestbookJoin(down, community, signer, viewer);
    const stale = getPendingGuestbookJoin(viewer, community.idHex)!.wrap!;

    const rotated = { ...community, rootEpoch: 1n, root: new Uint8Array(32).fill(9) };
    rotated.heldRoots = [{ epoch: 1n, key: rotated.root }];
    const up = relays(async () => undefined);
    expect(await attemptGuestbookJoin(up, rotated, signer, viewer)).toBe(true);
    expect(up.sent[0].id).not.toBe(stale.id);
    expect(up.sent[0].pubkey).not.toBe(stale.pubkey);
  });

  it("never publishes a Join a Leave forgot while the signer was asked", async () => {
    const community = await queued();
    let release!: () => void;
    const slowSigner = {
      signEvent: async (t: EventTemplate) => {
        await new Promise<void>((r) => (release = r));
        return finalizeEvent(t, sk);
      },
    };
    const net = relays(async () => undefined);
    const attempt = attemptGuestbookJoin(net, community, slowSigner, viewer);
    await new Promise((r) => setTimeout(r, 0));
    forgetGuestbookJoin(viewer, community.idHex);
    release();
    expect(await attempt).toBe(false);
    expect(net.sent).toHaveLength(0);
  });

  it("collapses concurrent attempts into one", async () => {
    const community = await queued();
    const net = relays(async () => undefined);
    const [a, b] = await Promise.all([
      attemptGuestbookJoin(net, community, signer, viewer),
      attemptGuestbookJoin(net, community, signer, viewer),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(net.sent).toHaveLength(2);
  });
});
