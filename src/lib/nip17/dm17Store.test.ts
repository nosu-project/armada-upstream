import { IDBFactory } from "fake-indexeddb";
import { getPublicKey, generateSecretKey } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";

import {
  dm17Store,
  dm17ToStored,
  queryDm17Conversations,
  queryDm17Thread,
  queryDm17Timer,
  storedToDm17,
  sweepExpiredDm17Rumors,
  writeDm17Rumors,
} from "@/lib/nip17/dm17Store";
import {
  buildDmRumor,
  dmChatTags,
  dmDeleteTags,
  dmReactionTags,
  dmTimerTags,
  KIND_DM_CHAT,
  KIND_DM_DELETE,
  KIND_DM_REACTION,
  KIND_DM_TIMER,
  type OpenedDm,
} from "@/lib/nip17/protocol";

// A clean IndexedDB for the suite (the store singleton opens against it lazily).
(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();

const self = getPublicKey(generateSecretKey());
const alice = getPublicKey(generateSecretKey());
const bob = getPublicKey(generateSecretKey());

let clock = 1_700_000_000;

function opened(opts: { author: string; peer: string; kind?: number; content?: string; tags?: string[][] }): OpenedDm {
  const createdAt = ++clock;
  const kind = opts.kind ?? KIND_DM_CHAT;
  const content = opts.content ?? "hello";
  const tags = opts.tags ?? dmChatTags(opts.author === self ? opts.peer : self);
  const rumor = buildDmRumor({ kind, content, tags, pubkey: opts.author, createdAt });
  return {
    rumorId: rumor.id,
    author: opts.author,
    kind,
    content,
    tags,
    createdAt,
    peer: opts.peer,
    wrapId: `wrap-${rumor.id.slice(0, 8)}`,
  };
}

describe("dm17Store", () => {
  it("round-trips the stored codec, stripping provenance tags", () => {
    const o = opened({ author: alice, peer: alice, content: "codec" });
    const back = storedToDm17(dm17ToStored(o));
    expect(back).toEqual(o);
  });

  it("writes rumors and reads a thread scoped by peer", async () => {
    const fromAlice = opened({ author: alice, peer: alice, content: "hi from alice" });
    const toAlice = opened({ author: self, peer: alice, content: "hi back" });
    const fromBob = opened({ author: bob, peer: bob, content: "unrelated" });
    await writeDm17Rumors([fromAlice, toAlice, fromBob]);

    const thread = await queryDm17Thread(alice, { limit: 50 });
    const ids = thread.map((r) => r.rumorId).sort();
    expect(ids).toEqual([fromAlice.rumorId, toAlice.rumorId].sort());
  });

  it("groups conversations by peer, newest message first", async () => {
    const convos = await queryDm17Conversations();
    expect(convos.map((c) => c.peer)).toEqual([bob, alice]);
    expect(convos[1].latest.content).toBe("hi back");
  });

  it("marks conversations the viewer has messaged as `mine`", async () => {
    const convos = await queryDm17Conversations({ self });
    const byPeer = new Map(convos.map((c) => [c.peer, c]));
    // alice's thread has a self-authored "hi back"; bob only messaged us.
    expect(byPeer.get(alice)?.mine).toBe(true);
    expect(byPeer.get(bob)?.mine).toBe(false);
    // Without `self`, participation can't be determined — always false.
    const anon = await queryDm17Conversations();
    expect(anon.every((c) => c.mine === false)).toBe(true);
  });

  it("applies a kind-5 delete rumor to the author's own target only", async () => {
    const target = opened({ author: alice, peer: alice, content: "to be deleted" });
    const reaction = opened({
      author: alice,
      peer: alice,
      kind: KIND_DM_REACTION,
      content: "👍",
      tags: dmReactionTags(self, target.rumorId, KIND_DM_CHAT),
    });
    await writeDm17Rumors([target, reaction]);

    // A FOREIGN delete (authored by someone else) must not remove it.
    const foreignDelete = opened({
      author: bob,
      peer: bob,
      kind: KIND_DM_DELETE,
      content: "",
      tags: dmDeleteTags(self, target.rumorId, KIND_DM_CHAT),
    });
    await writeDm17Rumors([foreignDelete]);
    let thread = await queryDm17Thread(alice, { limit: 50 });
    expect(thread.some((r) => r.rumorId === target.rumorId)).toBe(true);

    // The author's own delete removes it.
    const ownDelete = opened({
      author: alice,
      peer: alice,
      kind: KIND_DM_DELETE,
      content: "",
      tags: dmDeleteTags(self, target.rumorId, KIND_DM_CHAT),
    });
    await writeDm17Rumors([ownDelete]);
    thread = await queryDm17Thread(alice, { limit: 50 });
    expect(thread.some((r) => r.rumorId === target.rumorId)).toBe(false);
    // The reaction survives (deletes are per-target).
    expect(thread.some((r) => r.rumorId === reaction.rumorId)).toBe(true);
  });
});

describe("dm17Store disappearing messages", () => {
  const carol = getPublicKey(generateSecretKey());

  /** Put a stored rumor in directly, bypassing writeDm17Rumors' expiry guard. */
  async function forceStore(o: OpenedDm): Promise<void> {
    await dm17Store().event(dm17ToStored(o));
  }

  const now = () => Math.floor(Date.now() / 1000);

  it("refuses to persist an already-expired rumor", async () => {
    const expired = opened({
      author: carol,
      peer: carol,
      content: "should never land",
      tags: dmChatTags(self, { expiresAt: now() - 1 }),
    });
    await writeDm17Rumors([expired]);
    const thread = await queryDm17Thread(carol, { limit: 50 });
    expect(thread.some((r) => r.rumorId === expired.rumorId)).toBe(false);
  });

  it("stores and returns a message that has not expired yet", async () => {
    const live = opened({
      author: carol,
      peer: carol,
      content: "still here",
      tags: dmChatTags(self, { expiresAt: now() + 3600 }),
    });
    await writeDm17Rumors([live]);
    const thread = await queryDm17Thread(carol, { limit: 50 });
    expect(thread.some((r) => r.rumorId === live.rumorId)).toBe(true);
  });

  it("hides an expired rumor from reads and sweeps it off disk", async () => {
    const stale = opened({
      author: carol,
      peer: carol,
      content: "expired in storage",
      tags: dmChatTags(self, { expiresAt: now() - 1 }),
    });
    await forceStore(stale);

    // Present in the raw store...
    expect((await dm17Store().query([{ ids: [stale.rumorId] }])).length).toBe(1);
    // ...but never handed to a reader.
    const thread = await queryDm17Thread(carol, { limit: 50 });
    expect(thread.some((r) => r.rumorId === stale.rumorId)).toBe(false);
    const convos = await queryDm17Conversations({ self });
    expect(convos.find((c) => c.peer === carol)?.latest.rumorId).not.toBe(stale.rumorId);

    // Hiding is not disappearing: the sweep removes the plaintext.
    expect(await sweepExpiredDm17Rumors()).toBeGreaterThan(0);
    expect((await dm17Store().query([{ ids: [stale.rumorId] }])).length).toBe(0);
  });

  it("reads back the newest timer change, whichever side set it", async () => {
    expect(await queryDm17Timer(carol)).toBeUndefined();

    await writeDm17Rumors([
      opened({ author: self, peer: carol, kind: KIND_DM_TIMER, content: "", tags: dmTimerTags(carol, 86400) }),
    ]);
    expect(await queryDm17Timer(carol)).toBe(86400);

    // The peer turns it off; the newer change wins.
    await writeDm17Rumors([
      opened({ author: carol, peer: carol, kind: KIND_DM_TIMER, content: "", tags: dmTimerTags(self, 0) }),
    ]);
    expect(await queryDm17Timer(carol)).toBe(0);

    // A timer set on one conversation never leaks into another.
    expect(await queryDm17Timer(bob)).toBeUndefined();
  });
});
