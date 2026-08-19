import { nip19 } from "nostr-tools";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";

import {
  dmConversationName,
  dmConversationSearchText,
  dmParticipantNames,
  dmRouteParam,
  parseDmRouteParam,
} from "@/lib/dmConversation";
import { dmConvKey } from "@/lib/nip17/protocol";
import { chatRoute, parseChatRoute } from "@/lib/routes";

const alice = getPublicKey(generateSecretKey());
const bob = getPublicKey(generateSecretKey());
const carol = getPublicKey(generateSecretKey());

describe("dm route params", () => {
  it("keeps a 1:1 link byte-identical to what it always was", () => {
    // Every /dm/<npub> link already in a notification, a push subscription or
    // someone's clipboard has to keep resolving.
    expect(dmRouteParam(alice)).toBe(nip19.npubEncode(alice));
    expect(parseDmRouteParam(nip19.npubEncode(alice))).toBe(alice);
    expect(parseDmRouteParam(alice)).toBe(alice);
  });

  it("round-trips a group through the router", () => {
    const key = dmConvKey([alice, bob, carol].sort());
    const path = chatRoute({ kind: "dm", peer: dmRouteParam(key) });
    const parsed = parseChatRoute(path);
    expect(parsed).toMatchObject({ kind: "dm" });
    expect(parseDmRouteParam((parsed as { peer?: string }).peer)).toBe(key);
  });

  it("canonicalizes a hand-ordered link to one conversation", () => {
    // Two orderings of the same people must not become two conversations.
    const a = parseDmRouteParam(`${nip19.npubEncode(bob)},${nip19.npubEncode(alice)}`);
    const b = parseDmRouteParam(`${nip19.npubEncode(alice)},${nip19.npubEncode(bob)}`);
    expect(a).toBe(b);
    expect(a).toBe(dmConvKey([alice, bob].sort()));
  });

  it("de-duplicates a repeated participant", () => {
    expect(parseDmRouteParam(`${alice},${alice},${bob}`)).toBe(dmConvKey([alice, bob].sort()));
  });

  it("rejects a param that isn't all pubkeys", () => {
    expect(parseDmRouteParam("not-a-key")).toBeUndefined();
    expect(parseDmRouteParam(`${alice},not-a-key`)).toBeUndefined();
    expect(parseDmRouteParam(undefined)).toBeUndefined();
    expect(parseDmRouteParam("")).toBeUndefined();
  });

  it("keeps the message-permalink shape under a group", () => {
    const key = dmConvKey([alice, bob].sort());
    const path = chatRoute({ kind: "dm", peer: dmRouteParam(key), messageId: "abc" });
    expect(parseChatRoute(path)).toMatchObject({ messageId: "abc" });
  });
});

describe("dm conversation names", () => {
  const names = new Map([
    [alice, { name: "Derek Ross" }],
    [bob, { name: "Mary Kate Fain" }],
    [carol, { name: "chad" }],
  ]);

  it("names a group by every participant, in the conversation's own order", () => {
    const peers = [alice, bob, carol];
    expect(dmConversationName(dmParticipantNames(peers, (pk) => names.get(pk)))).toBe(
      "Derek Ross, Mary Kate Fain, chad",
    );
  });

  it("names a 1:1 with just that person", () => {
    expect(dmConversationName(dmParticipantNames([alice], (pk) => names.get(pk)))).toBe(
      "Derek Ross",
    );
  });

  it("falls back to a readable stand-in for a participant with no profile", () => {
    // getDisplayName's own fallback; the point here is that one unresolved
    // profile doesn't blank the whole title.
    const composed = dmConversationName(dmParticipantNames([alice, bob], (pk) =>
      pk === alice ? names.get(pk) : undefined,
    ));
    expect(composed.startsWith("Derek Ross, ")).toBe(true);
    expect(composed.length).toBeGreaterThan("Derek Ross, ".length);
  });

  it("indexes every participant alias, handle and pubkey spelling", () => {
    const profiles = new Map([
      [alice, { name: "alice", display_name: "Alice Cooper", nip05: "alice@example.com" }],
      [bob, { name: "bobby", display_name: "Robert" }],
    ]);
    const text = dmConversationSearchText([alice, bob], (peer) => profiles.get(peer));

    expect(text).toContain("alice");
    expect(text).toContain("Alice Cooper");
    expect(text).toContain("alice@example.com");
    expect(text).toContain("Robert");
    expect(text).toContain(alice);
    expect(text).toContain(nip19.npubEncode(bob));
  });
});
