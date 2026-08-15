import { NIndexedDB } from "@nostrify/indexeddb";
import { IDBFactory } from "fake-indexeddb";
import { getPublicKey, generateSecretKey } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";

import {
  DM17_DRAIN_PAGE,
  dm17Store,
  dm17ToStored,
  migrateLegacyDms,
  queryDm17Conversations,
  queryDm17Rumor,
  queryDm17Thread,
  queryDm17Timer,
  readDm17Cursor,
  storedToDm17,
  sweepExpiredDm17Rumors,
  updateDm17Cursor,
  writeDm17Rumors,
} from "@/lib/nip17/dm17Store";
import {
  buildDmEditRumors,
  buildDmRumor,
  dmChatTags,
  dmConvKey,
  dmDeleteTags,
  dmPeersOf,
  dmReactionTags,
  dmTimerTags,
  KIND_DM_CHAT,
  KIND_DM_DELETE,
  KIND_DM_REACTION,
  KIND_DM_TIMER,
  type OpenedDm,
} from "@/lib/nip17/protocol";
import { dmThreadScope, onWireScopes, resetWireBus } from "@/wire/bus";

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
  const tags = opts.tags ?? dmChatTags([opts.author === self ? opts.peer : self]);
  const rumor = buildDmRumor({ kind, content, tags, pubkey: opts.author, createdAt });
  return {
    rumorId: rumor.id,
    author: opts.author,
    kind,
    content,
    tags,
    createdAt,
    peers: [opts.peer],
    wrapId: `wrap-${rumor.id.slice(0, 8)}`,
  };
}

describe("dm17Store", () => {
  it("round-trips the stored codec without touching the rumor's tags", () => {
    const o = opened({ author: alice, peer: alice, content: "codec" });
    const stored = dm17ToStored(o);
    // Nothing is injected: the tags are the bytes the rumor's id commits to.
    expect(stored.tags).toEqual(o.tags);

    const back = storedToDm17(stored, self);
    // The partner is derived from the rumor (NIP-17 names it in `p`), and the
    // wrap id is transport provenance with no reader on this side of the store,
    // so it is not persisted and comes back empty.
    expect(back).toEqual({ ...o, wrapId: "" });
  });

  it("writes rumors and reads a thread scoped by peer", async () => {
    const fromAlice = opened({ author: alice, peer: alice, content: "hi from alice" });
    const toAlice = opened({ author: self, peer: alice, content: "hi back" });
    const fromBob = opened({ author: bob, peer: bob, content: "unrelated" });
    await writeDm17Rumors(self, [fromAlice, toAlice, fromBob]);

    const thread = await queryDm17Thread(self, [alice], { limit: 50 });
    const ids = thread.map((r) => r.rumorId).sort();
    expect(ids).toEqual([fromAlice.rumorId, toAlice.rumorId].sort());

    // A focused search hit bypasses the newest-first thread window, but remains
    // strictly scoped to the conversation named by the route.
    expect(await queryDm17Rumor(self, [alice], fromAlice.rumorId)).toEqual({
      ...fromAlice,
      wrapId: "",
    });
    expect(await queryDm17Rumor(self, [bob], fromAlice.rumorId)).toBeUndefined();
  });

  it("rings the inbox and each affected thread after a durable write", async () => {
    const scopedSelf = getPublicKey(generateSecretKey());
    const scopedAlice = getPublicKey(generateSecretKey());
    const scopedBob = getPublicKey(generateSecretKey());
    resetWireBus();
    const seen = new Set<string>();
    const unsubscribe = onWireScopes((scopes) => {
      for (const scope of scopes) seen.add(scope);
    });

    try {
      await writeDm17Rumors(scopedSelf, [
        opened({
          author: scopedAlice,
          peer: scopedAlice,
          content: "scope alice",
          tags: dmChatTags([scopedSelf]),
        }),
        opened({
          author: scopedBob,
          peer: scopedBob,
          content: "scope bob",
          tags: dmChatTags([scopedSelf]),
        }),
      ]);
      await new Promise((resolve) => setTimeout(resolve, 75));

      expect(seen).toEqual(
        new Set(["dm", dmThreadScope(scopedAlice), dmThreadScope(scopedBob)]),
      );
    } finally {
      unsubscribe();
      resetWireBus();
    }
  });

  it("groups conversations by peer, newest message first", async () => {
    const convos = await queryDm17Conversations(self);
    expect(convos.map((c) => c.key)).toEqual([bob, alice]);
    expect(convos[1].latest.content).toBe("hi back");
  });

  it("marks conversations the viewer has messaged as `mine`", async () => {
    const convos = await queryDm17Conversations(self);
    const byPeer = new Map(convos.map((c) => [c.key, c]));
    // alice's thread has a self-authored "hi back"; bob only messaged us.
    expect(byPeer.get(alice)?.mine).toBe(true);
    expect(byPeer.get(bob)?.mine).toBe(false);
  });

  it("keeps each account's messages in its own tenant", async () => {
    const other = getPublicKey(generateSecretKey());
    // Everything above was written as `self`. Another logged-in account reads
    // its own tenant, which has none of it — not a filtered view of one store.
    expect(await queryDm17Conversations(other)).toEqual([]);
    expect(await queryDm17Thread(other, [alice], { limit: 50 })).toEqual([]);
  });

  it("applies a kind-5 delete rumor to the author's own target only", async () => {
    const target = opened({ author: alice, peer: alice, content: "to be deleted" });
    const reaction = opened({
      author: alice,
      peer: alice,
      kind: KIND_DM_REACTION,
      content: "👍",
      tags: dmReactionTags([self], target.rumorId, KIND_DM_CHAT),
    });
    await writeDm17Rumors(self, [target, reaction]);

    // A FOREIGN delete (authored by someone else) must not remove it.
    const foreignDelete = opened({
      author: bob,
      peer: bob,
      kind: KIND_DM_DELETE,
      content: "",
      tags: dmDeleteTags([self], target.rumorId, KIND_DM_CHAT),
    });
    await writeDm17Rumors(self, [foreignDelete]);
    let thread = await queryDm17Thread(self, [alice], { limit: 50 });
    expect(thread.some((r) => r.rumorId === target.rumorId)).toBe(true);

    // The author's own delete removes it.
    const ownDelete = opened({
      author: alice,
      peer: alice,
      kind: KIND_DM_DELETE,
      content: "",
      tags: dmDeleteTags([self], target.rumorId, KIND_DM_CHAT),
    });
    await writeDm17Rumors(self, [ownDelete]);
    thread = await queryDm17Thread(self, [alice], { limit: 50 });
    expect(thread.some((r) => r.rumorId === target.rumorId)).toBe(false);
    // The reaction survives (deletes are per-target).
    expect(thread.some((r) => r.rumorId === reaction.rumorId)).toBe(true);
  });

  it("persists an edit as the replacement and removes the old rumor", async () => {
    const editor = getPublicKey(generateSecretKey());
    const original = opened({
      author: self,
      peer: editor,
      content: "uncorrected",
      tags: dmChatTags([editor], { replyTo: "parent" }),
    });
    await writeDm17Rumors(self, [original]);

    const { replacement, deletion } = buildDmEditRumors(
      dm17ToStored(original),
      [editor],
      "corrected",
      original.createdAt + 10,
    );
    await writeDm17Rumors(self, [
      storedToDm17(replacement, self),
      storedToDm17(deletion, self),
    ]);

    const thread = await queryDm17Thread(self, [editor], { limit: 50 });
    expect(thread.some((r) => r.rumorId === original.rumorId)).toBe(false);
    expect(thread).toContainEqual(expect.objectContaining({
      rumorId: replacement.id,
      content: "corrected",
      createdAt: original.createdAt,
      tags: expect.arrayContaining([["e", "parent"], ["edited", String(original.createdAt + 10)]]),
    }));
  });
});

describe("dm17Store disappearing messages", () => {
  const carol = getPublicKey(generateSecretKey());

  /** Put a stored rumor in directly, bypassing writeDm17Rumors' expiry guard. */
  async function forceStore(o: OpenedDm): Promise<void> {
    await dm17Store(self).event(dm17ToStored(o));
  }

  const now = () => Math.floor(Date.now() / 1000);

  it("refuses to persist an already-expired rumor", async () => {
    const expired = opened({
      author: carol,
      peer: carol,
      content: "should never land",
      tags: dmChatTags([self], { expiresAt: now() - 1 }),
    });
    await writeDm17Rumors(self, [expired]);
    const thread = await queryDm17Thread(self, [carol], { limit: 50 });
    expect(thread.some((r) => r.rumorId === expired.rumorId)).toBe(false);
  });

  it("stores and returns a message that has not expired yet", async () => {
    const live = opened({
      author: carol,
      peer: carol,
      content: "still here",
      tags: dmChatTags([self], { expiresAt: now() + 3600 }),
    });
    await writeDm17Rumors(self, [live]);
    const thread = await queryDm17Thread(self, [carol], { limit: 50 });
    expect(thread.some((r) => r.rumorId === live.rumorId)).toBe(true);
  });

  it("hides an expired rumor from reads and sweeps it off disk", async () => {
    const stale = opened({
      author: carol,
      peer: carol,
      content: "expired in storage",
      tags: dmChatTags([self], { expiresAt: now() - 1 }),
    });
    await forceStore(stale);

    // Present in the raw store...
    expect((await dm17Store(self).query([{ ids: [stale.rumorId] }])).length).toBe(1);
    // ...but never handed to a reader.
    const thread = await queryDm17Thread(self, [carol], { limit: 50 });
    expect(thread.some((r) => r.rumorId === stale.rumorId)).toBe(false);
    const convos = await queryDm17Conversations(self);
    expect(convos.find((c) => c.key === carol)?.latest.rumorId).not.toBe(stale.rumorId);

    // Hiding is not disappearing: the sweep removes the plaintext.
    expect(await sweepExpiredDm17Rumors(self)).toBeGreaterThan(0);
    expect((await dm17Store(self).query([{ ids: [stale.rumorId] }])).length).toBe(0);
  });

  it("reads back the newest timer change, whichever side set it", async () => {
    expect(await queryDm17Timer(self, [carol])).toBeUndefined();

    await writeDm17Rumors(self, [
      opened({ author: self, peer: carol, kind: KIND_DM_TIMER, content: "", tags: dmTimerTags([carol], 86400) }),
    ]);
    expect(await queryDm17Timer(self, [carol])).toBe(86400);

    // The peer turns it off; the newer change wins.
    await writeDm17Rumors(self, [
      opened({ author: carol, peer: carol, kind: KIND_DM_TIMER, content: "", tags: dmTimerTags([self], 0) }),
    ]);
    expect(await queryDm17Timer(self, [carol])).toBe(0);

    // A timer set on one conversation never leaks into another.
    expect(await queryDm17Timer(self, [bob])).toBeUndefined();
  });
});

describe("dm17Store relay cursors", () => {
  it("advances each successful relay independently and preserves the others", async () => {
    const viewer = getPublicKey(generateSecretKey());
    await updateDm17Cursor(viewer, {
      newest: 200,
      oldest: 100,
      exhausted: false,
      relayNewest: { "wss://fast.example": 200 },
    });
    await updateDm17Cursor(viewer, {
      newest: 180,
      relayNewest: {
        "wss://fast.example": 150,
        "wss://slow.example": 180,
      },
    });

    expect(await readDm17Cursor(viewer)).toEqual({
      newest: 200,
      oldest: 100,
      exhausted: false,
      relayNewest: {
        "wss://fast.example": 200,
        "wss://slow.example": 180,
      },
    });
  });

  it("drops watermarks for relays outside pruneRelaysTo and keeps the rest advancing", async () => {
    const viewer = getPublicKey(generateSecretKey());
    await updateDm17Cursor(viewer, {
      newest: 200,
      oldest: 100,
      exhausted: false,
      relayNewest: { "wss://kept.example": 200, "wss://removed.example": 150 },
    });
    await updateDm17Cursor(
      viewer,
      { relayNewest: { "wss://kept.example": 210 } },
      { pruneRelaysTo: ["wss://kept.example"] },
    );

    expect((await readDm17Cursor(viewer))?.relayNewest).toEqual({
      "wss://kept.example": 210,
    });
  });

  it("leaves legacy global progress unattributed so every relay gets a recovery scan", async () => {
    const viewer = getPublicKey(generateSecretKey());
    await updateDm17Cursor(viewer, {
      newest: 300,
      oldest: 100,
      exhausted: true,
    });

    const cursor = await readDm17Cursor(viewer);
    expect(cursor?.newest).toBe(300);
    expect(cursor?.relayNewest).toBeUndefined();
  });
});

describe("dm17Store note to self", () => {
  // Its own account: the conversation with yourself is read with `peer ===
  // self`, and the shared fixtures above would make "only the notes" trivially
  // true by having nothing else to leak in.
  const me = getPublicKey(generateSecretKey());
  const friend = getPublicKey(generateSecretKey());

  it("reads back the notes addressed to yourself, and nothing else you sent", async () => {
    const note = opened({ author: me, peer: me, tags: dmChatTags([me]), content: "milk, eggs" });
    const toFriend = opened({ author: me, peer: friend, tags: dmChatTags([friend]), content: "sent to a person" });
    const fromFriend = opened({ author: friend, peer: friend, tags: dmChatTags([me]), content: "received" });
    await writeDm17Rumors(me, [note, toFriend, fromFriend]);

    // The general two-direction filter pair degenerates for a self thread: its
    // incoming half is `authors: [me]` unqualified, which is every DM this
    // account has ever SENT. Only the `p`-scoped half may run.
    const thread = await queryDm17Thread(me, [me], { limit: 50 });
    expect(thread.map((r) => r.content)).toEqual(["milk, eggs"]);
  });

  it("lists the notes as an ordinary conversation the viewer authored", async () => {
    const convos = await queryDm17Conversations(me);
    const notes = convos.find((c) => c.key === me);
    expect(notes?.latest.content).toBe("milk, eggs");
    // `mine` is what keeps it out of the request tier.
    expect(notes?.mine).toBe(true);
  });

  it("keeps a timer set with a person out of the notes", async () => {
    await writeDm17Rumors(me, [
      opened({ author: me, peer: friend, kind: KIND_DM_TIMER, content: "", tags: dmTimerTags([friend], 3600) }),
    ]);
    expect(await queryDm17Timer(me, [friend])).toBe(3600);
    expect(await queryDm17Timer(me, [me])).toBeUndefined();
  });
});

describe("dm17Store legacy drain", () => {
  // The pre-tenant database was global: it recorded `peer`, never which
  // account opened the rumor. So the drain has to attribute each record from
  // the rumor itself, or it hands one profile another's messages.
  const ana = getPublicKey(generateSecretKey());
  const ben = getPublicKey(generateSecretKey());
  const carla = getPublicKey(generateSecretKey());

  it("moves only the reading account's messages out of the global store", async () => {
    const legacy = new NIndexedDB("armada-dm17-rumors");

    // Ana ↔ Carla, both directions.
    const anaSent = opened({ author: ana, peer: carla, content: "ana to carla", tags: dmChatTags([carla]) });
    const anaGot = opened({ author: carla, peer: carla, content: "carla to ana", tags: dmChatTags([ana]) });
    // Ben ↔ Carla, from the same device. Ana must never see these.
    const benSent = opened({ author: ben, peer: carla, content: "ben to carla", tags: dmChatTags([carla]) });
    const anaReacted = opened({
      author: ana,
      peer: carla,
      kind: KIND_DM_REACTION,
      content: "👍",
      tags: dmReactionTags([carla], anaGot.rumorId, KIND_DM_CHAT),
    });
    for (const o of [anaSent, anaGot, benSent, anaReacted]) {
      await legacy.event({ ...dm17ToStored(o), sig: "" });
    }
    await legacy.close();

    const drained = await queryDm17Thread(ana, [carla], { limit: 50 });
    const ids = new Set(drained.map((r) => r.rumorId));
    expect(ids.has(anaSent.rumorId)).toBe(true);
    expect(ids.has(anaGot.rumorId)).toBe(true);
    expect(ids.has(anaReacted.rumorId)).toBe(true);
    expect(ids.has(benSent.rumorId)).toBe(false);
  });

  it("pages past the scan window instead of copying only the newest slice", async () => {
    // The drain used to read the store with one `limit`-capped query. Anything
    // past the cap was left behind — and then deleted with the database, since
    // the drain resolved either way. Re-decrypting is not a recovery path: it
    // needs gift wraps the relays have long since dropped.
    const dana = getPublicKey(generateSecretKey());
    const total = DM17_DRAIN_PAGE + 50;

    const legacy = new NIndexedDB("armada-dm17-rumors");
    for (let i = 0; i < total; i++) {
      const o = opened({ author: dana, peer: carla, content: `msg-${i}`, tags: dmChatTags([carla]) });
      await legacy.event({ ...dm17ToStored(o), sig: "" });
    }
    await legacy.close();

    await migrateLegacyDms(dana);
    expect((await dm17Store(dana).count([{ kinds: [KIND_DM_CHAT] }])).count).toBe(total);
  }, 60_000);
});

// Slower than the unit tests above on purpose: these are IndexedDB round-trips
// against the store the rest of this file has been filling, so they carry an
// explicit timeout rather than flaking at vitest's 5s default under a loaded
// full-suite run.
describe("group conversations", () => {
  const me = getPublicKey(generateSecretKey());
  const ana = getPublicKey(generateSecretKey());
  const ben = getPublicKey(generateSecretKey());
  const cy = getPublicKey(generateSecretKey());

  /**
   * An opened rumor addressed to an explicit room (`recipients` are its `p`
   * tags). `peers` comes from the real derivation rather than being asserted
   * here, so these rows are exactly what `openDmWrap` would have produced.
   */
  function room(
    author: string,
    recipients: string[],
    content: string,
    kind = KIND_DM_CHAT,
    tags?: string[][],
  ): OpenedDm {
    const createdAt = ++clock;
    const rumorTags = tags ?? dmChatTags(recipients);
    return {
      rumorId: `${author.slice(0, 4)}-${content}-${createdAt}`,
      author,
      kind,
      content,
      tags: rumorTags,
      createdAt,
      peers: dmPeersOf({ pubkey: author, tags: rumorTags }, me)!,
      wrapId: "",
    };
  }

  it("keeps a group thread separate from its members' 1:1s", async () => {
    // The three conversations that share people: Ana alone, Ben alone, and the
    // room with both. A NIP-01 filter cannot distinguish them at all, so what
    // is under test is the derived term index the read seeks instead (see
    // conversationFilters).
    const oneToOneAna = room(ana, [me], "just ana");
    const oneToOneBen = room(ben, [me], "just ben");
    const groupFromAna = room(ana, [me, ben], "ana to the group");
    const groupFromMe = room(me, [ana, ben], "me to the group");
    await writeDm17Rumors(me, [oneToOneAna, oneToOneBen, groupFromAna, groupFromMe]);

    expect((await queryDm17Thread(me, [ana], { limit: 50 })).map((m) => m.content))
      .toEqual(["just ana"]);
    expect((await queryDm17Thread(me, [ben], { limit: 50 })).map((m) => m.content))
      .toEqual(["just ben"]);
    expect(
      (await queryDm17Thread(me, [ana, ben].sort(), { limit: 50 })).map((m) => m.content).sort(),
    ).toEqual(["ana to the group", "me to the group"]);

    // Exact search hydration is scoped to the whole participant set too: a
    // shared member must not let a group hit leak into their 1:1, or vice versa.
    expect(await queryDm17Rumor(me, [ana, ben].sort(), groupFromAna.rumorId))
      .toEqual(expect.objectContaining({ content: "ana to the group" }));
    expect(await queryDm17Rumor(me, [ana], groupFromAna.rumorId)).toBeUndefined();
    expect(await queryDm17Rumor(me, [ana, ben].sort(), oneToOneAna.rumorId)).toBeUndefined();
  }, 30_000);

  it("lists a group as ONE conversation, not one row per member", async () => {
    const convos = await queryDm17Conversations(me);
    const keys = convos.map((c) => c.key);
    expect(keys).toContain(dmConvKey([ana, ben].sort()));
    expect(keys.filter((k) => k === dmConvKey([ana, ben].sort()))).toHaveLength(1);
    const group = convos.find((c) => c.key === dmConvKey([ana, ben].sort()))!;
    expect(group.peers).toEqual([ana, ben].sort());
    // We authored one of its messages, so it is ours.
    expect(group.mine).toBe(true);
  }, 30_000);

  it("does not let a superset room answer for a subset room", async () => {
    const bigger = room(ana, [me, ben, cy], "all three");
    await writeDm17Rumors(me, [bigger]);
    expect((await queryDm17Thread(me, [ana, ben].sort(), { limit: 50 })).map((m) => m.content))
      .not.toContain("all three");
    expect(
      (await queryDm17Thread(me, [ana, ben, cy].sort(), { limit: 50 })).map((m) => m.content),
    ).toEqual(["all three"]);
  }, 30_000);

  it("rings the group's own wire scope, not its members'", async () => {
    resetWireBus();
    const seen = new Set<string>();
    const off = onWireScopes((scopes) => {
      for (const scope of scopes) seen.add(scope);
    });
    try {
      await writeDm17Rumors(me, [room(ben, [me, ana], "ring")]);
      // The bus debounces, so the ring lands a tick later (see the scoped-write
      // test above).
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(seen).toEqual(new Set(["dm", dmThreadScope(dmConvKey([ana, ben].sort()))]));
    } finally {
      off();
      resetWireBus();
    }
  }, 30_000);

  it("scopes the disappearing timer to the group", async () => {
    const groupKey = [ana, ben].sort();
    expect(await queryDm17Timer(me, groupKey)).toBeUndefined();
    await writeDm17Rumors(me, [
      room(me, groupKey, "", KIND_DM_TIMER, dmTimerTags(groupKey, 3600)),
    ]);
    expect(await queryDm17Timer(me, groupKey)).toBe(3600);
    // The members' own 1:1s are untouched by it.
    expect(await queryDm17Timer(me, [ana])).toBeUndefined();
    expect(await queryDm17Timer(me, [ben])).toBeUndefined();
  }, 30_000);

  it("applies a group member's delete inside the group", async () => {
    const groupKey = [ana, ben].sort();
    const target = room(ana, [me, ben], "regrettable");
    await writeDm17Rumors(me, [target]);
    expect((await queryDm17Thread(me, groupKey, { limit: 50 })).map((m) => m.rumorId))
      .toContain(target.rumorId);
    await writeDm17Rumors(me, [
      room(ana, groupKey, "", KIND_DM_DELETE, dmDeleteTags(groupKey, target.rumorId, KIND_DM_CHAT)),
    ]);
    expect((await queryDm17Thread(me, groupKey, { limit: 50 })).map((m) => m.rumorId))
      .not.toContain(target.rumorId);
  }, 30_000);
});
