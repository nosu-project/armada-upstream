import { describe, expect, it } from "vitest";

import {
  TOPIC_ID_CHARS,
  TRAILER_LEN,
  base32Decode,
  base32Encode,
  decodeNodeAddr,
  deriveTopicId,
  dmPeerSignalContent,
  dmPeerSignalTags,
  encodeNodeAddr,
  foldPeerSignals,
  frame,
  isTopicId,
  mintTopicId,
  parseDmPeerSignal,
  parsePeerSignal,
  peerSignalContent,
  unframe,
} from "@/lib/webxdcRealtime";

/**
 * Fixtures produced by Vector's OWN Rust implementations, not by this file.
 * They are the point of the suite: a passing test here means the two clients
 * agree on the wire, not that this module agrees with itself.
 */
const B32_0_TO_31 = "AAAQEAYEAUDAOCAJBIFQYDIOB4IBCEQTCQKRMFYYDENBWHA5DYPQ";
const B32_FF32 = "777777777777777777777777777777777777777777777777777Q";
const TOPIC_TTT = "OE4PCJOZJEGHXO3XRI3VFSHXVZDQ562TQIJITJUZTU3G6FQP4GXA";

const bytes = (...v: number[]) => new Uint8Array(v);

describe("base32, as Vector spells it", () => {
  it("matches Rust on the vectors that break naive shifting", () => {
    expect(base32Encode(Uint8Array.from({ length: 32 }, (_, i) => i))).toBe(B32_0_TO_31);
    expect(base32Encode(new Uint8Array(32).fill(255))).toBe(B32_FF32);
    expect(base32Encode(new Uint8Array(0))).toBe("");
  });

  it("round-trips every length through the 5-bit boundary", () => {
    for (let n = 0; n <= 40; n++) {
      const src = crypto.getRandomValues(new Uint8Array(n));
      const back = base32Decode(base32Encode(src))!;
      // Exact, not prefix-exact: a trailing zero byte here would append NUL to
      // a decoded node address and break the JSON parse on the other side.
      expect(back, `length ${n}`).toEqual(src);
    }
  });

  it("refuses characters outside the alphabet", () => {
    expect(base32Decode("AAAA!")).toBeUndefined();
    expect(base32Decode("0189")).toBeUndefined(); // 0/1/8/9 are not base32
  });
});

describe("topic ids", () => {
  it("accepts exactly what Vector accepts", () => {
    expect(isTopicId(TOPIC_TTT)).toBe(true);
    expect(TOPIC_TTT).toHaveLength(TOPIC_ID_CHARS);
  });

  it("drops everything Vector drops, silently and on purpose", () => {
    // Vector filters rather than errors, so a bad topic goes nowhere with no
    // diagnostic. The UUID case is the one that matters: it is what Armada
    // used to mint, and it must never be mistaken for a topic.
    expect(isTopicId(crypto.randomUUID())).toBe(false);
    expect(isTopicId(TOPIC_TTT.toLowerCase()), "lowercase").toBe(false);
    expect(isTopicId(TOPIC_TTT.slice(0, 51)), "short").toBe(false);
    expect(isTopicId(TOPIC_TTT + "A"), "long").toBe(false);
    expect(isTopicId(TOPIC_TTT.slice(0, 51) + "="), "padded").toBe(false);
    expect(isTopicId(TOPIC_TTT.slice(0, 51) + "0"), "0 is not base32").toBe(false);
    expect(isTopicId(""), "empty").toBe(false);
    expect(isTopicId(undefined)).toBe(false);
  });

  it("derives the fallback topic exactly as Rust does", async () => {
    // The first input is the manifest NAME: Rust calls the parameter
    // `file_hash`, but both call sites pass the name.
    expect(await deriveTopicId("Tic Tac Toe", "npub1abc", "evt-1")).toBe(TOPIC_TTT);
  });

  it("mints a fresh, valid topic every time", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const t = await mintTopicId("hash", "senderhex");
      expect(isTopicId(t)).toBe(true);
      seen.add(t);
    }
    // Two sends of the same file must be two sessions. Vector needed a process
    // counter for this because its clock did not resolve; ours is random.
    expect(seen.size).toBe(50);
  });
});

describe("the frame", () => {
  it("appends seq little-endian and the sender key", () => {
    const key = new Uint8Array(32).fill(0xab);
    const f = frame(bytes(1, 2, 3), 258, key);
    expect(f).toHaveLength(3 + TRAILER_LEN);
    expect([...f.slice(3, 7)]).toEqual([2, 1, 0, 0]); // 258 = 0x0102, LE
    expect([...f.slice(7)]).toEqual([...key]);
  });

  it("round-trips through unframe", () => {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const payload = crypto.getRandomValues(new Uint8Array(200));
    const got = unframe(frame(payload, 7, key))!;
    expect(got.payload).toEqual(payload);
    expect(got.seq).toBe(7);
    expect(got.sender).toBe([...key].map((b) => b.toString(16).padStart(2, "0")).join(""));
  });

  it("carries an empty payload, which is a trailer and nothing else", () => {
    const f = frame(new Uint8Array(0), 1, new Uint8Array(32));
    expect(f).toHaveLength(TRAILER_LEN);
    expect(unframe(f)!.payload).toHaveLength(0);
  });

  it("drops anything shorter than the trailer", () => {
    for (const n of [0, 1, 35]) expect(unframe(new Uint8Array(n)), `${n} bytes`).toBeUndefined();
    expect(unframe(new Uint8Array(TRAILER_LEN))).toBeDefined();
  });

  it("reads a frame that is a view into a larger buffer", () => {
    // Gossip hands over slices; a DataView built on the wrong offset silently
    // reads someone else's bytes as the sequence number.
    const backing = new Uint8Array(100);
    const f = frame(bytes(9, 9), 5, new Uint8Array(32).fill(1));
    backing.set(f, 20);
    expect(unframe(backing.subarray(20, 20 + f.length))!.seq).toBe(5);
  });
});

describe("the Concord peer signal", () => {
  it("emits exactly the JSON Vector emits", () => {
    expect(peerSignalContent(TOPIC_TTT, "addr-blob")).toBe(
      JSON.stringify({ op: "ad", topic: TOPIC_TTT, addr: "addr-blob" }),
    );
    expect(peerSignalContent(TOPIC_TTT)).toBe(JSON.stringify({ op: "left", topic: TOPIC_TTT }));
  });

  it("round-trips both operations", () => {
    expect(parsePeerSignal(peerSignalContent(TOPIC_TTT, "a"))).toEqual({ op: "ad", topic: TOPIC_TTT, addr: "a" });
    expect(parsePeerSignal(peerSignalContent(TOPIC_TTT))).toEqual({ op: "left", topic: TOPIC_TTT });
  });

  it("drops a malformed signal instead of throwing", () => {
    // Any channel member can publish one of these; a bad body must not take
    // down the ingest loop carrying everyone else's.
    for (const bad of [
      "",
      "not json",
      "null",
      "[]",
      JSON.stringify({ op: "ad", topic: TOPIC_TTT }), // no addr
      JSON.stringify({ op: "ad", topic: TOPIC_TTT, addr: "" }), // empty addr
      JSON.stringify({ op: "ad", topic: crypto.randomUUID(), addr: "a" }), // UUID topic
      JSON.stringify({ op: "shrug", topic: TOPIC_TTT }),
      JSON.stringify({ topic: TOPIC_TTT }),
    ]) {
      expect(() => parsePeerSignal(bad)).not.toThrow();
      expect(parsePeerSignal(bad), bad.slice(0, 40)).toBeUndefined();
    }
  });
});

describe("folding peer signals into who is playing", () => {
  const T1 = "OE4PCJOZJEGHXO3XRI3VFSHXVZDQ562TQIJITJUZTU3G6FQP4GXA";
  const T2 = "AAAQEAYEAUDAOCAJBIFQYDIOB4IBCEQTCQKRMFYYDENBWHA5DYPQ";
  const ad = (author: string, ms: number, topic = T1, addr = `addr-${author}`) => ({
    author,
    ms,
    content: peerSignalContent(topic, addr),
  });
  const left = (author: string, ms: number, topic = T1) => ({ author, ms, content: peerSignalContent(topic) });

  it("lists everyone currently advertising, newest first", () => {
    const peers = foldPeerSignals([ad("alice", 100), ad("bob", 200)], T1);
    expect(peers.map((p) => p.pubkey)).toEqual(["bob", "alice"]);
    expect(peers[0].addr).toBe("addr-bob");
  });

  it("removes a peer who left", () => {
    expect(foldPeerSignals([ad("alice", 100), left("alice", 200)], T1)).toEqual([]);
  });

  it("keeps a peer who left and came back", () => {
    const peers = foldPeerSignals([ad("alice", 100), left("alice", 200), ad("alice", 300)], T1);
    expect(peers).toHaveLength(1);
  });

  it("resolves by timestamp, not arrival order", () => {
    // The signals are durable, so a backfill hands us an old ad AFTER a newer
    // departure. Reacting to arrival order would resurrect a peer who is gone.
    expect(foldPeerSignals([left("alice", 200), ad("alice", 100)], T1)).toEqual([]);
  });

  it("treats a same-millisecond ad and departure as departed", () => {
    // Dialling a peer that is already gone hangs until the timeout, so the
    // tie goes to the answer that costs nothing.
    expect(foldPeerSignals([ad("alice", 100), left("alice", 100)], T1)).toEqual([]);
    expect(foldPeerSignals([left("alice", 100), ad("alice", 100)], T1)).toEqual([]);
  });

  it("keeps games on one channel apart", () => {
    const peers = foldPeerSignals([ad("alice", 100, T1), ad("bob", 200, T2)], T1);
    expect(peers.map((p) => p.pubkey)).toEqual(["alice"]);
  });

  it("never lists ourselves", () => {
    expect(foldPeerSignals([ad("me", 100), ad("alice", 90)], T1, "me").map((p) => p.pubkey)).toEqual(["alice"]);
  });

  it("ignores anything that is not a peer signal", () => {
    // The 3310 plane also carries app state updates, which are base64 blobs.
    const noise = [
      { author: "alice", ms: 100, content: "eyJmb28iOiJiYXIifQ==" },
      { author: "bob", ms: 110, content: "" },
      { author: "carol", ms: 120, content: '{"op":"ad","topic":"nope","addr":"x"}' },
    ];
    expect(foldPeerSignals(noise, T1)).toEqual([]);
  });
});

describe("the DM peer signal (Vector's NIP-17 shape)", () => {
  const T = "OE4PCJOZJEGHXO3XRI3VFSHXVZDQ562TQIJITJUZTU3G6FQP4GXA";

  it("builds the tags Vector builds", () => {
    expect(dmPeerSignalTags(T, "addr")).toEqual([
      ["d", "vector-webxdc-peer"],
      ["webxdc-topic", T],
      ["webxdc-node-addr", "addr"],
    ]);
    // A departure carries no address: there is nothing to reach.
    expect(dmPeerSignalTags(T)).toEqual([["d", "vector-webxdc-peer"], ["webxdc-topic", T]]);
  });

  it("puts the operation in the content, unlike the Concord form", () => {
    expect(dmPeerSignalContent("addr")).toBe("peer-advertisement");
    expect(dmPeerSignalContent()).toBe("peer-left");
  });

  it("round-trips both operations", () => {
    expect(parseDmPeerSignal(dmPeerSignalContent("a"), dmPeerSignalTags(T, "a"))).toEqual({
      op: "ad", topic: T, addr: "a",
    });
    expect(parseDmPeerSignal(dmPeerSignalContent(), dmPeerSignalTags(T))).toEqual({ op: "left", topic: T });
  });

  it("drops an advertisement missing either half", () => {
    // Vector requires both tags and drops the rumor otherwise.
    expect(parseDmPeerSignal("peer-advertisement", [["webxdc-topic", T]])).toBeUndefined();
    expect(parseDmPeerSignal("peer-advertisement", [["webxdc-node-addr", "a"]])).toBeUndefined();
    expect(parseDmPeerSignal("peer-advertisement", dmPeerSignalTags(crypto.randomUUID(), "a"))).toBeUndefined();
    expect(parseDmPeerSignal("something-else", dmPeerSignalTags(T, "a"))).toBeUndefined();
  });
});

describe("the node address on the wire", () => {
  const ADDR = JSON.stringify({
    id: "ef6a0bd56fdc55509db2678bd533ae5bd9baf5e6b48b48d1db2d010c98e90897",
    addrs: [{ Relay: "https://euc1-1.relay.n0.iroh.link./" }],
  });

  it("travels as base32, never as raw JSON", () => {
    // The regression this exists for: Armada published the JSON unencoded
    // while decoding base32 on receipt. Vector's decoder base32-decodes first,
    // so it hit `{`, `"` and `:`, failed, and dropped the advertisement BEFORE
    // recording it — the peer never appeared in its lobby, while the game
    // played fine because whoever could read an address dialled first.
    const wire = encodeNodeAddr(ADDR);
    expect(wire).not.toBe(ADDR);
    expect(wire).toMatch(/^[A-Z2-7]+$/);
  });

  it("round-trips", () => {
    expect(decodeNodeAddr(encodeNodeAddr(ADDR))).toBe(ADDR);
  });

  it("refuses raw JSON handed to the decoder", () => {
    expect(decodeNodeAddr(ADDR)).toBeUndefined();
  });

  it("refuses base32 that is not JSON, rather than passing junk to the transport", () => {
    expect(decodeNodeAddr(base32Encode(new TextEncoder().encode("not json")))).toBeUndefined();
    expect(decodeNodeAddr("!!!!")).toBeUndefined();
    expect(decodeNodeAddr("")).toBeUndefined();
  });
});
