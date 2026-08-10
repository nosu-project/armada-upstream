/**
 * Which tagged pubkeys are worth resolving a profile for.
 *
 * `useMentionNameMap` exists to turn literal `@alias` text in a message body
 * back into a pubkey. Its regex can only match text containing `@`, and
 * `applyTextMentions` returns its input untouched when no regex is built — so
 * a message with no `@` in the body has nothing to resolve however many
 * pubkeys it tags.
 *
 * That matters because each tagged pubkey costs a kind-0 fetch through the
 * profile sync topic: a REQ, a Schnorr verify, a zod parse, a store write and
 * a render. A live client measured 952 distinct profiles in nine minutes, with
 * kind 0 at 46% of all signature verification — and a message that `p`-tags
 * many pubkeys while carrying no mention text is the shape spam takes.
 */
import { describe, expect, it } from "vitest";
import type { NostrRumor } from "@/lib/nostrRumor";

import { mentionTagPubkeys } from "./useMentionNameMap";

const A = "a".repeat(64);
const B = "b".repeat(64);

function rumor(content: string, tags: string[][]): NostrRumor {
  return {
    id: "f".repeat(64),
    pubkey: "e".repeat(64),
    created_at: 1_700_000_000,
    kind: 9,
    tags,
    content,
  } as NostrRumor;
}

describe("mentionTagPubkeys", () => {
  it("resolves p-tagged pubkeys when the body carries an @ mention", () => {
    expect(mentionTagPubkeys(rumor("hey @alice", [["p", A]]))).toEqual([A]);
  });

  it("returns nothing when the body has no @ at all", () => {
    // The whole point: tags without mention text cost nothing.
    expect(mentionTagPubkeys(rumor("buy my coin now", [["p", A], ["p", B]]))).toEqual([]);
  });

  it("returns nothing for a heavily p-tagged message with no mention text", () => {
    const tags = Array.from({ length: 50 }, (_, i) => ["p", i.toString(16).padStart(64, "0")]);
    expect(mentionTagPubkeys(rumor("spam", tags))).toEqual([]);
  });

  it("still resolves when the @ appears anywhere in the body", () => {
    // Conservative on purpose: presence of `@` is the only gate, so an address
    // or a handle keeps the old behavior rather than risking a missed mention.
    expect(mentionTagPubkeys(rumor("mail me at bob@example.com", [["p", A]]))).toEqual([A]);
  });

  it("includes the non-notifying mention tag", () => {
    expect(mentionTagPubkeys(rumor("@bob", [["mention", B]]))).toEqual([B]);
  });

  it("lowercases and dedupes", () => {
    const upper = A.toUpperCase();
    expect(mentionTagPubkeys(rumor("@a", [["p", A], ["p", upper]]))).toEqual([A]);
  });

  it("ignores malformed tag values", () => {
    expect(mentionTagPubkeys(rumor("@a", [["p", "nope"], ["p", ""], ["p", A]]))).toEqual([A]);
  });

  it("ignores tags that are not mentions", () => {
    expect(mentionTagPubkeys(rumor("@a", [["e", A], ["channel", B]]))).toEqual([]);
  });
});
