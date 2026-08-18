import { describe, expect, it } from "vitest";

import {
  TOPIC_ID_CHARS,
  TRAILER_LEN,
  base32Decode,
  base32Encode,
  deriveTopicId,
  frame,
  isTopicId,
  mintTopicId,
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
      // Encoding pads the final group with zero bits, so the decode can carry
      // one extra byte; the payload prefix is what must survive.
      expect(back.slice(0, n), `length ${n}`).toEqual(src);
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
