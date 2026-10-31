import { describe, expect, it } from "vitest";

import { buildNip29ThreadReplyTags, isNip29ThreadOnly, nip29ThreadRootOf } from "@/lib/nip29Threads";

const ROOT = "a".repeat(64);
const PARENT = "b".repeat(64);
const AUTHOR = "c".repeat(64);
const RELAY = "wss://groups.example";

const chat = (...tags: string[][]) => ({ kind: 9, tags: [["h", "g"], ...tags] });

describe("nip29ThreadRootOf", () => {
  it("roots a Buzz-style kind 9 at its marked tags", () => {
    expect(nip29ThreadRootOf(chat(["e", ROOT, "", "reply"]))).toBe(ROOT);
    expect(nip29ThreadRootOf(chat(["e", ROOT, "", "root"], ["e", PARENT, "", "reply"]))).toBe(ROOT);
  });

  it("reads a legacy kind-1111 comment's uppercase E", () => {
    expect(nip29ThreadRootOf({ kind: 1111, tags: [["h", "g"], ["E", ROOT, "", AUTHOR], ["e", ROOT]] })).toBe(ROOT);
  });

  it("leaves NIP-C7 quote replies and unmarked e tags on the timeline", () => {
    expect(nip29ThreadRootOf(chat(["q", ROOT, RELAY, AUTHOR]))).toBeUndefined();
    expect(nip29ThreadRootOf(chat(["e", ROOT]))).toBeUndefined();
    expect(nip29ThreadRootOf(chat(["e", ROOT, "", "root"]))).toBeUndefined();
    expect(nip29ThreadRootOf(chat(["e", "", "", "reply"]))).toBeUndefined();
  });
});

describe("isNip29ThreadOnly", () => {
  it("keeps a broadcast reply on the timeline", () => {
    expect(isNip29ThreadOnly(chat(["e", ROOT, "", "reply"]))).toBe(true);
    expect(isNip29ThreadOnly(chat(["e", ROOT, "", "reply"], ["broadcast", "1"]))).toBe(false);
    expect(isNip29ThreadOnly(chat())).toBe(false);
  });
});

describe("buildNip29ThreadReplyTags", () => {
  it("is Buzz's direct reply shape plus a NIP-C7 quote", () => {
    const root = { id: ROOT, kind: 9, pubkey: AUTHOR, tags: [["h", "g"]] };
    expect(buildNip29ThreadReplyTags(root, "g", RELAY)).toEqual([
      ["h", "g"],
      ["e", ROOT, "", "reply"],
      ["q", ROOT, RELAY, AUTHOR],
      ["p", AUTHOR],
    ]);
  });

  it("round-trips: what it builds is read back as a reply in that thread", () => {
    const root = { id: ROOT, kind: 9, pubkey: AUTHOR, tags: [["h", "g"]] };
    const reply = { kind: 9, tags: buildNip29ThreadReplyTags(root, "g", RELAY) };
    expect(nip29ThreadRootOf(reply)).toBe(ROOT);
    expect(isNip29ThreadOnly(reply)).toBe(true);
  });

  it("hands on the root of a root that is itself a broadcast reply", () => {
    const root = { id: PARENT, kind: 9, pubkey: AUTHOR, tags: [["h", "g"], ["e", ROOT, "", "reply"], ["broadcast", "1"]] };
    const tags = buildNip29ThreadReplyTags(root, "g", RELAY);
    expect(tags).toContainEqual(["e", ROOT, "", "root"]);
    expect(tags).toContainEqual(["e", PARENT, "", "reply"]);
  });
});
