import { nip19 } from "nostr-tools";
import { describe, expect, it } from "vitest";

import { getReplyToId } from "@/components/chat/messageHelpers";

import type { ChatMsg } from "@/components/chat/transport";

const PARENT = "a".repeat(64);
const OTHER = "b".repeat(64);
const AUTHOR = "c".repeat(64);

function msg(tags: string[][], content = "teste"): ChatMsg {
  return { id: "d".repeat(64), kind: 9, pubkey: AUTHOR, created_at: 0, content, tags, sig: "" } as ChatMsg;
}

describe("getReplyToId (NIP-29)", () => {
  it("reads a NIP-C7 q reply, bare or with relay and pubkey", () => {
    expect(getReplyToId(msg([["h", "g"], ["q", PARENT], ["p", AUTHOR]]))).toBe(PARENT);
    expect(getReplyToId(msg([["q", PARENT, "wss://relay.example/", AUTHOR], ["h", "g"], ["p", AUTHOR]]))).toBe(PARENT);
  });

  it("skips an embed q to find the reply q", () => {
    const content = `look nostr:${nip19.noteEncode(OTHER)}`;
    expect(getReplyToId(msg([["q", OTHER], ["q", PARENT]], content))).toBe(PARENT);
    expect(getReplyToId(msg([["q", OTHER]], content))).toBeUndefined();
  });

  it("falls back to NIP-10 marked e tags", () => {
    expect(getReplyToId(msg([["e", PARENT, "", "root", AUTHOR]]))).toBe(PARENT);
    expect(getReplyToId(msg([["e", OTHER, "", "root"], ["e", PARENT, "", "reply"]]))).toBe(PARENT);
    expect(getReplyToId(msg([["e", PARENT]]))).toBeUndefined();
  });
});
