import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey } from "nostr-tools/pure";
import { getConversationKey, encrypt as nip44Encrypt } from "nostr-tools/nip44";
import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";

import { queryChannelRumors } from "@/concord/lib/rumorStore";
import { queryDm17Thread } from "@/lib/nip17/dm17Store";

import { openConcord, openDm, preparePush } from "./pushRuntime";

import type { SwConcordStream, SwPushConfig } from "@/lib/swPushConfig";

const now = () => Math.floor(Date.now() / 1000);

/** Seal a rumor with the sender's real key (kind 13, nip44 to the recipient). */
function seal(
  rumor: Record<string, unknown>,
  senderSk: Uint8Array,
  recipientPk: string,
  tags: string[][] = [],
) {
  return finalizeEvent(
    {
      kind: 13,
      content: nip44Encrypt(JSON.stringify(rumor), getConversationKey(senderSk, recipientPk)),
      tags,
      created_at: now(),
    },
    senderSk,
  );
}

/** Wrap a seal in a single-use ephemeral gift wrap (kind 1059). */
function wrap(sealEvent: unknown, recipientPk: string, tags: string[][] = [["p", recipientPk]]) {
  const wrapSk = generateSecretKey();
  return finalizeEvent(
    {
      kind: 1059,
      content: nip44Encrypt(JSON.stringify(sealEvent), getConversationKey(wrapSk, recipientPk)),
      tags,
      created_at: now(),
    },
    wrapSk,
  );
}

describe("openDm", () => {
  const senderSk = generateSecretKey();
  const recipientSk = generateSecretKey();
  const senderPk = getPublicKey(senderSk);
  const recipientPk = getPublicKey(recipientSk);
  const sk = bytesToHex(recipientSk);

  const rumor = {
    pubkey: senderPk,
    kind: 14,
    content: "are you coming tonight?",
    tags: [["p", recipientPk]],
    created_at: now(),
  };

  it("returns the real sender, message and rumor timestamp", async () => {
    const opened = await openDm(
      wrap(seal(rumor, senderSk, recipientPk), recipientPk),
      sk,
      recipientPk,
    );
    expect(opened).toMatchObject({
      author: senderPk,
      kind: 14,
      content: "are you coming tonight?",
      createdAt: rumor.created_at,
      peers: [senderPk],
    });
  });

  it("returns undefined for a wrap this key can't open", async () => {
    const strangerPk = getPublicKey(generateSecretKey());
    expect(await openDm(wrap(seal(rumor, senderSk, strangerPk), strangerPk), sk, recipientPk))
      .toBeUndefined();
  });

  it("opens the user's own sent copy too — dropping it is prepareDm's call", async () => {
    // It has to open: the copy is how a message sent from another device
    // reaches this one's store at all. Whether to SHOW it is decided later.
    const selfRumor = { ...rumor, pubkey: recipientPk, tags: [["p", senderPk]] };
    const opened = await openDm(
      wrap(seal(selfRumor, recipientSk, recipientPk), recipientPk),
      sk,
      recipientPk,
    );
    expect(opened?.author).toBe(recipientPk);
  });

  it("rejects an anti-spoofed rumor (rumor.pubkey != seal signer)", async () => {
    const spoofed = { ...rumor, pubkey: getPublicKey(generateSecretKey()) };
    expect(await openDm(wrap(seal(spoofed, senderSk, recipientPk), recipientPk), sk, recipientPk))
      .toBeUndefined();
  });

  it("rejects an already-expired rumor (NIP-40)", async () => {
    const past = String(now() - 60);
    const expiredRumor = { ...rumor, tags: [["p", recipientPk], ["expiration", past]] };
    expect(await openDm(wrap(seal(expiredRumor, senderSk, recipientPk), recipientPk), sk, recipientPk))
      .toBeUndefined();
  });

  it("rejects a wrap whose outer expiration has passed without decrypting", async () => {
    const past = String(now() - 60);
    const w = wrap(seal(rumor, senderSk, recipientPk), recipientPk, [
      ["p", recipientPk],
      ["expiration", past],
    ]);
    expect(await openDm(w, sk, recipientPk)).toBeUndefined();
  });

  it("returns undefined for garbage rather than throwing", async () => {
    const junk = { ...wrap(seal(rumor, senderSk, recipientPk), recipientPk), content: "nope" };
    expect(await openDm(junk, sk, recipientPk)).toBeUndefined();
  });
});

describe("openConcord", () => {
  const CHANNEL = "aa".repeat(32);
  const EPOCH = "3";
  const streamSk = generateSecretKey();
  const streamPk = getPublicKey(streamSk);
  const convKey = getConversationKey(streamSk, streamPk); // self-ECDH, per CORD-01
  const authorSk = generateSecretKey();
  const authorPk = getPublicKey(authorSk);

  const stream: SwConcordStream = {
    pk: streamPk,
    convKey: bytesToHex(convKey),
    epoch: EPOCH,
    communityId: "bb".repeat(32),
    channelId: CHANNEL,
  };

  /**
   * A chat rumor bound to the channel + epoch (CORD-02 §5).
   *
   * `id` is computed rather than omitted: `openWrap` requires a rumor to carry
   * its own correct event hash and rejects one that doesn't — unlike NIP-17's
   * `openDmWrap`, which fills a missing id in.
   */
  function chatRumor(over: Partial<Record<string, unknown>> = {}) {
    const rumor = {
      pubkey: authorPk,
      kind: 9,
      content: "shipped it",
      tags: [["channel", CHANNEL], ["epoch", EPOCH]],
      created_at: now(),
      ...over,
    };
    return { ...rumor, id: getEventHash(rumor as Parameters<typeof getEventHash>[0]) };
  }

  /** Seal (20013 encrypted) + wrap under the stream key. */
  function streamWrap(rumor: Record<string, unknown>, sealKind = 20013) {
    const sealed = finalizeEvent(
      {
        kind: sealKind,
        content: sealKind === 20013
          ? nip44Encrypt(JSON.stringify(rumor), convKey)
          : JSON.stringify(rumor),
        tags: [],
        created_at: rumor.created_at as number,
      },
      authorSk,
    );
    return finalizeEvent(
      {
        kind: 1059,
        content: nip44Encrypt(JSON.stringify(sealed), convKey),
        tags: [["p", getPublicKey(generateSecretKey())]],
        created_at: now(),
      },
      streamSk,
    );
  }

  it("opens a chat wrap routed by the stream address", () => {
    const result = openConcord(streamWrap(chatRumor()), [stream]);
    expect(result?.opened).toMatchObject({
      author: authorPk,
      kind: 9,
      content: "shipped it",
      channelIdHex: CHANNEL,
      epoch: BigInt(EPOCH),
    });
    expect(result?.stream).toBe(stream);
  });

  it("drops only the Concord plane while its config snapshot is explicitly unready", async () => {
    const prepared = await preparePush({
      scope: "c2",
      event: streamWrap(chatRumor()),
    }, {
      policy: "generic",
      self: getPublicKey(generateSecretKey()),
      knownPeers: [],
      dmReady: true,
      concordReady: false,
      concord: [stream],
    });
    expect(prepared?.drop).toBe(true);
  });

  it("treats an undefined Concord readiness flag as legacy-ready", async () => {
    const prepared = await preparePush({
      scope: "c2",
      event: streamWrap(chatRumor()),
    }, {
      policy: "generic",
      self: getPublicKey(generateSecretKey()),
      knownPeers: [],
      concordReady: undefined,
      concord: [stream],
    });
    expect(prepared?.drop).not.toBe(true);
    expect(prepared?.line).toContain("shipped it");
  });

  it("holds a future-dated message: stored, but not announced", async () => {
    const prepared = await preparePush({
      scope: "c2",
      event: streamWrap(chatRumor({ created_at: now() + 3600 })),
    }, {
      policy: "generic",
      self: getPublicKey(generateSecretKey()),
      knownPeers: [],
      concord: [stream],
    });
    // The timeline HOLDS it until its time comes (FUTURE_HOLD_MS); buzzing now
    // would notify about a message the reader can't yet see.
    expect(prepared?.drop).toBe(true);
  });

  it("announces a message within the future grace window", async () => {
    const prepared = await preparePush({
      scope: "c2",
      event: streamWrap(chatRumor({ created_at: now() + 1 })),
    }, {
      policy: "generic",
      self: getPublicKey(generateSecretKey()),
      knownPeers: [],
      concord: [stream],
    });
    expect(prepared?.drop).not.toBe(true);
    expect(prepared?.line).toContain("shipped it");
  });

  it("returns undefined when no configured stream authored the wrap", () => {
    expect(openConcord(streamWrap(chatRumor()), [{ ...stream, pk: "cc".repeat(32) }]))
      .toBeUndefined();
  });

  it("refuses a plaintext seal, which chat forbids (CORD-02 §5)", () => {
    // Android's service accepts 20014 here; the web rule is stricter, and a
    // plaintext seal would make the message a standalone signed artifact.
    expect(openConcord(streamWrap(chatRumor(), 20014), [stream])).toBeUndefined();
  });

  it("refuses a rumor spliced in from another channel", () => {
    const spliced = chatRumor({ tags: [["channel", "dd".repeat(32)], ["epoch", EPOCH]] });
    expect(openConcord(streamWrap(spliced), [stream])).toBeUndefined();
  });

  it("refuses a rumor bound to another epoch", () => {
    const spliced = chatRumor({ tags: [["channel", CHANNEL], ["epoch", "2"]] });
    expect(openConcord(streamWrap(spliced), [stream])).toBeUndefined();
  });

  it("refuses a rumor whose author isn't the seal's signer", () => {
    const spoofed = chatRumor({ pubkey: getPublicKey(generateSecretKey()) });
    expect(openConcord(streamWrap(spoofed), [stream])).toBeUndefined();
  });

  it("ignores non-chat kinds carried on the chat plane", () => {
    // A control edition re-sealed onto a chat stream must not become a message.
    expect(openConcord(streamWrap(chatRumor({ kind: 20000 })), [stream])).toBeUndefined();
  });

  it("returns undefined for garbage rather than throwing", () => {
    const junk = { ...streamWrap(chatRumor()), content: "not-ciphertext" };
    expect(openConcord(junk, [stream])).toBeUndefined();
  });
});

describe("preparePush — relay-scoped NIP-29 identity", () => {
  it("uses a one-relay gateway spec as exact room authority without cached metadata", async () => {
    const event = finalizeEvent({
      kind: 9,
      content: "hello",
      tags: [["h", "general"]],
      created_at: now(),
    }, generateSecretKey());

    const prepared = await preparePush({
      scope: "group",
      relays: ["wss://relay-a.example"],
      event,
    }, null);

    expect(prepared?.roomKey).toBe("h:wss://relay-a.example|general");
    expect(prepared?.url).toContain("relay-a.example");
  });
});

describe("preparePush — DM request gating", () => {
  const senderSk = generateSecretKey();
  const recipientSk = generateSecretKey();
  const senderPk = getPublicKey(senderSk);
  const recipientPk = getPublicKey(recipientSk);
  const sk = bytesToHex(recipientSk);

  function dmWrap(over: Partial<Record<string, unknown>> = {}) {
    const rumor = {
      pubkey: senderPk,
      kind: 14,
      content: "meet at 8 by the pier",
      tags: [["p", recipientPk]],
      created_at: now(),
      ...over,
    };
    return wrap(seal(rumor, senderSk, recipientPk), recipientPk);
  }

  const cfg = (over: Partial<SwPushConfig> = {}): SwPushConfig => ({
    policy: "generic",
    self: recipientPk,
    knownPeers: [],
    sk,
    ...over,
  });

  const push = (event: unknown, config: SwPushConfig | null) =>
    preparePush({ scope: "dm", event: event as never }, config);

  it("shows the message for a known sender", async () => {
    const p = await push(dmWrap(), cfg({ knownPeers: [senderPk] }));
    expect(p?.line).toContain("meet at 8");
    expect(p?.tag).toBe(`dm-${senderPk}`);
    expect(p?.roomKey).toBe(`dm:${senderPk}`);
    expect(p?.eventId).toMatch(/^[0-9a-f]{64}$/);
    expect(p?.url).toBe(`/dm/${senderPk}`);
    expect(p?.accumulate).toBe(true);
  });

  it("drops only the DM plane while its config snapshot is explicitly unready", async () => {
    const p = await push(dmWrap(), cfg({
      dmReady: false,
      concordReady: true,
      policy: "full",
      knownPeers: [senderPk],
    }));
    expect(p?.drop).toBe(true);
  });

  it("treats an undefined DM readiness flag as legacy-ready", async () => {
    const p = await push(dmWrap(), cfg({
      dmReady: undefined,
      policy: "full",
      knownPeers: [senderPk],
    }));
    expect(p?.drop).not.toBe(true);
    expect(p?.line).toContain("meet at 8");
  });

  it("enforces the exact DM conversation's Nothing level after decrypting", async () => {
    const p = await push(dmWrap(), cfg({
      policy: "full",
      knownPeers: [senderPk],
      dmLevels: { [senderPk]: "nothing" },
    }));
    expect(p?.drop).toBe(true);
  });

  it("uses the global DM fallback when the conversation has no explicit level", async () => {
    const p = await push(dmWrap(), cfg({
      policy: "full",
      knownPeers: [senderPk],
      directMessages: false,
    }));
    expect(p?.drop).toBe(true);
  });

  it("lets an exact All level override the disabled global DM fallback", async () => {
    const p = await push(dmWrap(), cfg({
      policy: "full",
      knownPeers: [senderPk],
      directMessages: false,
      dmLevels: { [senderPk]: "all" },
    }));
    expect(p?.drop).not.toBe(true);
    expect(p?.line).toContain("meet at 8");
  });

  it("treats a DM as directed under an exact Mentions level", async () => {
    const p = await push(dmWrap(), cfg({
      policy: "full",
      knownPeers: [senderPk],
      dmLevels: { [senderPk]: "mentions" },
    }));
    expect(p?.drop).not.toBe(true);
    expect(p?.line).toContain("meet at 8");
  });

  it("routes an authored group by its exact conversation without trusting its members 1:1", async () => {
    const otherPeer = getPublicKey(generateSecretKey());
    const conversation = [senderPk, otherPeer].sort().join(",");
    const group = dmWrap({ tags: [["p", recipientPk], ["p", otherPeer]] });
    const config = cfg({ knownConversations: [conversation] });

    const p = await push(group, config);
    expect(p?.line).toContain("meet at 8");
    expect(p?.tag).toBe(`dm-${conversation}`);
    expect(p?.url).toBe(`/dm/${conversation}`);

    // Exact group participation must not promote the group's author into the
    // global sender allow-list for an unrelated pairwise message.
    const oneToOne = await push(dmWrap(), config);
    expect(oneToOne?.title).toBe("Message requests");
  });

  it("suppresses a trusted group when any participant is muted", async () => {
    const otherPeer = getPublicKey(generateSecretKey());
    const conversation = [senderPk, otherPeer].sort().join(",");
    const p = await push(
      dmWrap({ tags: [["p", recipientPk], ["p", otherPeer]] }),
      cfg({
        policy: "full",
        knownConversations: [conversation],
        mutedPeers: [otherPeer],
      }),
    );
    expect(p?.drop).toBe(true);
  });

  it("shows a content-blind request for an unknown sender under `generic`", async () => {
    const p = await push(dmWrap({ content: "vile slur from a random" }), cfg());
    expect(p?.title).toBe("Message requests");
    expect(p?.accumulate).toBe(false);
    // Nothing the sender controls reaches the notification.
    expect(JSON.stringify(p)).not.toContain("slur");
  });

  it("still shows, quietly, for an unknown sender under `off`", async () => {
    // Never nothing: iOS revokes a subscription that displays nothing.
    const p = await push(dmWrap(), cfg({ policy: "off" }));
    expect(p?.title).toBe("Message requests");
    expect(p?.quiet).toBe(true);
  });

  it("shows full content for an unknown sender under `full`", async () => {
    const p = await push(dmWrap(), cfg({ policy: "full" }));
    expect(p?.line).toContain("meet at 8");
  });

  it("treats a non-message rumor (reaction/delete) as a quiet request", async () => {
    const p = await push(dmWrap({ kind: 7, content: "+" }), cfg({ knownPeers: [senderPk] }));
    expect(p?.title).toBe("Message requests");
    expect(p?.quiet).toBe(true);
  });

  it("declines a login the worker has no key for (bunker / NIP-07)", async () => {
    const { sk: _sk, ...noKey } = cfg();
    expect(await push(dmWrap(), noKey as SwPushConfig)).toBeUndefined();
  });

  it("declines when no event was inlined", async () => {
    expect(await preparePush({ scope: "dm" }, cfg())).toBeUndefined();
  });

  it("declines a wrap it cannot open", async () => {
    const strangerPk = getPublicKey(generateSecretKey());
    const foreign = wrap(seal({ pubkey: senderPk, kind: 14, content: "x", tags: [], created_at: now() }, senderSk, strangerPk), strangerPk);
    expect(await push(foreign, cfg({ policy: "full" }))).toBeUndefined();
  });

  it("declines an unknown scope", async () => {
    expect(await preparePush({ scope: "zap", event: dmWrap() as never }, cfg())).toBeUndefined();
  });
});

describe("preparePush — ingest", () => {
  // The point of inlining the event is not just a better-looking notification:
  // the message is WRITTEN to the tenant the app reads it from, so one received
  // while no tab was open is simply there on the next open. That is what the
  // Android background service does with the shared SQLite file.

  it("stores a DM rumor where the app reads it", async () => {
    const senderSk = generateSecretKey();
    const recipientSk = generateSecretKey();
    const senderPk = getPublicKey(senderSk);
    const recipientPk = getPublicKey(recipientSk);
    const rumor = {
      pubkey: senderPk,
      kind: 14,
      content: "stored while the tab was closed",
      tags: [["p", recipientPk]],
      created_at: now(),
    };

    await preparePush(
      { scope: "dm", event: wrap(seal(rumor, senderSk, recipientPk), recipientPk) as never },
      { policy: "full", self: recipientPk, knownPeers: [], sk: bytesToHex(recipientSk) },
    );

    const thread = await queryDm17Thread(recipientPk, [senderPk], { limit: 10 });
    expect(thread.map((m) => m.content)).toContain("stored while the tab was closed");
  });

  it("stores a Concord chat rumor in the community's tenant", async () => {
    const CHANNEL = "ee".repeat(32);
    const COMMUNITY = "ff".repeat(32);
    const streamSk = generateSecretKey();
    const streamPk = getPublicKey(streamSk);
    const convKey = getConversationKey(streamSk, streamPk);
    const authorSk = generateSecretKey();
    const authorPk = getPublicKey(authorSk);

    const rumor = {
      pubkey: authorPk,
      kind: 9,
      content: "landed while offline",
      tags: [["channel", CHANNEL], ["epoch", "1"]],
      created_at: now(),
    };
    const withId = { ...rumor, id: getEventHash(rumor as Parameters<typeof getEventHash>[0]) };
    const sealed = finalizeEvent(
      { kind: 20013, content: nip44Encrypt(JSON.stringify(withId), convKey), tags: [], created_at: rumor.created_at },
      authorSk,
    );
    const streamed = finalizeEvent(
      {
        kind: 1059,
        content: nip44Encrypt(JSON.stringify(sealed), convKey),
        tags: [["p", getPublicKey(generateSecretKey())]],
        created_at: now(),
      },
      streamSk,
    );

    await preparePush({ scope: "c2", event: streamed as never }, {
      policy: "generic",
      self: getPublicKey(generateSecretKey()),
      knownPeers: [],
      concord: [{
        pk: streamPk,
        convKey: bytesToHex(convKey),
        epoch: "1",
        communityId: COMMUNITY,
        channelId: CHANNEL,
      }],
    });

    const rows = await queryChannelRumors(COMMUNITY, CHANNEL, { limit: 10 });
    expect(rows.map((r) => r.content)).toContain("landed while offline");
  });
});

describe("preparePush — showing nothing on purpose", () => {
  // `drop` exists because the alternative to a notification is the gateway's
  // static wake-up, which is itself visible. Only the DECRYPTED rumor can say
  // "this is your own message" or "this reaction isn't about you", so by the
  // time the worker knows, silence has to be something it can ask for.

  it("drops the user's own DM sent from another device", async () => {
    const selfSk = generateSecretKey();
    const selfPk = getPublicKey(selfSk);
    const peerPk = getPublicKey(generateSecretKey());
    const rumor = {
      pubkey: selfPk,
      kind: 14,
      content: "sent from my laptop",
      tags: [["p", peerPk]],
      created_at: now(),
    };
    const p = await preparePush(
      { scope: "dm", event: wrap(seal(rumor, selfSk, selfPk), selfPk) as never },
      { policy: "full", self: selfPk, knownPeers: [], sk: bytesToHex(selfSk) },
    );
    expect(p?.drop).toBe(true);
    // Still stored — that copy is how the other device's half of the
    // conversation gets here.
    const thread = await queryDm17Thread(selfPk, [peerPk], { limit: 10 });
    expect(thread.map((m) => m.content)).toContain("sent from my laptop");
  });

  it("drops a Concord reaction aimed at somebody else's message", async () => {
    const CHANNEL = "12".repeat(32);
    const streamSk = generateSecretKey();
    const streamPk = getPublicKey(streamSk);
    const convKey = getConversationKey(streamSk, streamPk);
    const authorSk = generateSecretKey();
    const rumor = {
      pubkey: getPublicKey(authorSk),
      kind: 7,
      content: "+",
      // p-tags a third party, not us.
      tags: [["channel", CHANNEL], ["epoch", "1"], ["p", getPublicKey(generateSecretKey())]],
      created_at: now(),
    };
    const withId = { ...rumor, id: getEventHash(rumor as Parameters<typeof getEventHash>[0]) };
    const sealed = finalizeEvent(
      { kind: 20013, content: nip44Encrypt(JSON.stringify(withId), convKey), tags: [], created_at: rumor.created_at },
      authorSk,
    );
    const streamed = finalizeEvent(
      {
        kind: 1059,
        content: nip44Encrypt(JSON.stringify(sealed), convKey),
        tags: [["p", getPublicKey(generateSecretKey())]],
        created_at: now(),
      },
      streamSk,
    );

    const p = await preparePush({ scope: "c2", event: streamed as never }, {
      policy: "generic",
      self: getPublicKey(generateSecretKey()),
      knownPeers: [],
      concord: [{
        pk: streamPk,
        convKey: bytesToHex(convKey),
        epoch: "1",
        communityId: "34".repeat(32),
        channelId: CHANNEL,
      }],
    });
    expect(p?.drop).toBe(true);
  });

  it("enforces a Concord stream's Mentions level after decrypting", async () => {
    const CHANNEL = "91".repeat(32);
    const streamSk = generateSecretKey();
    const streamPk = getPublicKey(streamSk);
    const convKey = getConversationKey(streamSk, streamPk);
    const authorSk = generateSecretKey();
    const selfPk = getPublicKey(generateSecretKey());

    const streamed = (mentionsSelf: boolean) => {
      const rumor = {
        pubkey: getPublicKey(authorSk),
        kind: 9,
        content: mentionsSelf ? "hey, you" : "general chatter",
        tags: [
          ["channel", CHANNEL],
          ["epoch", "1"],
          ...(mentionsSelf ? [["p", selfPk]] : []),
        ],
        created_at: now(),
      };
      const withId = {
        ...rumor,
        id: getEventHash(rumor as Parameters<typeof getEventHash>[0]),
      };
      const sealed = finalizeEvent(
        {
          kind: 20013,
          content: nip44Encrypt(JSON.stringify(withId), convKey),
          tags: [],
          created_at: rumor.created_at,
        },
        authorSk,
      );
      return finalizeEvent(
        {
          kind: 1059,
          content: nip44Encrypt(JSON.stringify(sealed), convKey),
          tags: [["p", getPublicKey(generateSecretKey())]],
          created_at: now(),
        },
        streamSk,
      );
    };

    const config: SwPushConfig = {
      policy: "generic",
      self: selfPk,
      knownPeers: [],
      concord: [{
        pk: streamPk,
        convKey: bytesToHex(convKey),
        epoch: "1",
        communityId: "92".repeat(32),
        channelId: CHANNEL,
        mentionOnly: true,
      }],
    };

    expect((await preparePush({ scope: "c2", event: streamed(false) as never }, config))?.drop)
      .toBe(true);
    const mention = await preparePush({ scope: "c2", event: streamed(true) as never }, config);
    expect(mention?.drop).not.toBe(true);
    expect(mention?.roomKey).toBe(`c2:${CHANNEL}`);
  });

  it("drops a banned member's Concord message but still stores it", async () => {
    const CHANNEL = "56".repeat(32);
    const COMMUNITY = "78".repeat(32);
    const streamSk = generateSecretKey();
    const streamPk = getPublicKey(streamSk);
    const convKey = getConversationKey(streamSk, streamPk);
    const authorSk = generateSecretKey();
    const authorPk = getPublicKey(authorSk);
    const rumor = {
      pubkey: authorPk,
      kind: 9,
      content: "message from a banned member",
      tags: [["channel", CHANNEL], ["epoch", "1"]],
      created_at: now(),
    };
    const withId = { ...rumor, id: getEventHash(rumor as Parameters<typeof getEventHash>[0]) };
    const sealed = finalizeEvent(
      { kind: 20013, content: nip44Encrypt(JSON.stringify(withId), convKey), tags: [], created_at: rumor.created_at },
      authorSk,
    );
    const streamed = finalizeEvent(
      {
        kind: 1059,
        content: nip44Encrypt(JSON.stringify(sealed), convKey),
        tags: [["p", getPublicKey(generateSecretKey())]],
        created_at: now(),
      },
      streamSk,
    );

    const p = await preparePush({ scope: "c2", event: streamed as never }, {
      policy: "generic",
      self: getPublicKey(generateSecretKey()),
      knownPeers: [],
      concord: [{
        pk: streamPk,
        convKey: bytesToHex(convKey),
        epoch: "1",
        communityId: COMMUNITY,
        channelId: CHANNEL,
        banned: [authorPk],
      }],
    });
    expect(p?.drop).toBe(true);
    // Stored regardless — the timeline folds the ban away on read, so the row
    // still has to be there for that surface.
    const rows = await queryChannelRumors(COMMUNITY, CHANNEL, { limit: 10 });
    expect(rows.map((r) => r.content)).toContain("message from a banned member");
  });
});
