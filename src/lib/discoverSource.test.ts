import { nip19 } from "nostr-tools";
import { describe, expect, it } from "vitest";

import {
  ARMADA_FOLLOW_PACK,
  curatedPubkeys,
  curationFilter,
  curationKey,
  isCurationEvent,
  parseDiscoverCuration,
  resolveDiscoverCuration,
  resolveDiscoverRelays,
  type DiscoverCuration,
} from "./discoverSource";

import type { NostrRumor } from "@/lib/nostrRumor";

const PK = "a".repeat(64);
const OTHER = "b".repeat(64);
const SOAPBOX = "932614571afcbad4d17a191ee281e39eebbb41b93fac8fd87829622aeb112f4d";

function rumor(partial: Partial<NostrRumor>): NostrRumor {
  return { id: "0".repeat(64), pubkey: PK, created_at: 1, kind: 1, tags: [], content: "", ...partial };
}

function ok(input: string): DiscoverCuration {
  const parsed = parseDiscoverCuration(input);
  if (!parsed.ok) throw new Error(`expected ${input} to parse: ${parsed.error}`);
  return parsed.curation;
}

describe("parseDiscoverCuration", () => {
  it("reads the Armada follow pack naddr as a kind-39089 list", () => {
    expect(ok(ARMADA_FOLLOW_PACK)).toEqual({
      type: "list",
      kind: 39089,
      pubkey: SOAPBOX,
      identifier: "k4p5w0n22suf",
      relays: [],
    });
  });

  it("keeps an naddr's relay hints, normalized, and drops unusable ones", () => {
    const naddr = nip19.naddrEncode({
      kind: 30000,
      pubkey: PK,
      identifier: "friends",
      relays: ["wss://relay.example.com/", "https://not-a-relay.example", "ws://relay.example.org", "wss://192.168.1.4", "wss://localhost:7777"],
    });
    expect(ok(naddr)).toEqual({
      type: "list",
      kind: 30000,
      pubkey: PK,
      identifier: "friends",
      relays: ["wss://relay.example.com"],
    });
  });

  it("accepts a nostr: prefix and surrounding whitespace", () => {
    expect(ok(`  nostr:${ARMADA_FOLLOW_PACK}\n`)).toMatchObject({ type: "list", kind: 39089 });
  });

  it("reads an npub, an nprofile and a hex pubkey as that person's follow list", () => {
    expect(ok(nip19.npubEncode(PK))).toEqual({ type: "follows", pubkey: PK, relays: [] });
    expect(ok(PK.toUpperCase())).toEqual({ type: "follows", pubkey: PK, relays: [] });
    expect(ok(nip19.nprofileEncode({ pubkey: OTHER, relays: ["relay.example.com"] }))).toEqual({
      type: "follows",
      pubkey: OTHER,
      relays: ["wss://relay.example.com"],
    });
  });

  it("reads none, in any case, as no curated list", () => {
    expect(ok("none")).toEqual({ type: "none" });
    expect(ok(" NONE ")).toEqual({ type: "none" });
  });

  it("rejects an empty value, garbage, short hex and the wrong NIP-19 types", () => {
    for (const input of [
      "",
      "   ",
      "hello",
      "a".repeat(63),
      "wss://relay.example.com",
      nip19.noteEncode(PK),
      nip19.neventEncode({ id: PK }),
    ]) {
      expect(parseDiscoverCuration(input).ok, input).toBe(false);
    }
  });

  it("rejects an naddr of a non-addressable kind", () => {
    const naddr = nip19.naddrEncode({ kind: 10000, pubkey: PK, identifier: "" });
    const parsed = parseDiscoverCuration(naddr);
    expect(parsed.ok).toBe(false);
  });
});

describe("resolveDiscoverCuration", () => {
  it("uses the build default when there is no override", () => {
    expect(resolveDiscoverCuration("", ARMADA_FOLLOW_PACK)).toMatchObject({ type: "list", pubkey: SOAPBOX });
    expect(resolveDiscoverCuration("   ", ARMADA_FOLLOW_PACK)).toMatchObject({ type: "list", pubkey: SOAPBOX });
  });

  it("uses the override over the build default", () => {
    expect(resolveDiscoverCuration(nip19.npubEncode(PK), ARMADA_FOLLOW_PACK)).toEqual({
      type: "follows",
      pubkey: PK,
      relays: [],
    });
    expect(resolveDiscoverCuration("none", ARMADA_FOLLOW_PACK)).toEqual({ type: "none" });
  });

  it("resolves an unparseable override to no list, never back to the build default", () => {
    expect(resolveDiscoverCuration("garbage", ARMADA_FOLLOW_PACK)).toEqual({ type: "none" });
  });

  it("honours a build that sets no list, or one it can't parse", () => {
    expect(resolveDiscoverCuration("", "none")).toEqual({ type: "none" });
    expect(resolveDiscoverCuration("", "garbage")).toEqual({ type: "none" });
    expect(resolveDiscoverCuration(PK, "none")).toMatchObject({ type: "follows", pubkey: PK });
  });
});

describe("resolveDiscoverRelays", () => {
  it("uses the app relays when the user has none of their own", () => {
    expect(resolveDiscoverRelays(["wss://app.example/", "wss://app.example"])).toEqual(["wss://app.example"]);
  });

  it("adds the user's own relays after the app relays, normalized and de-duplicated", () => {
    expect(
      resolveDiscoverRelays(["wss://app.example"], ["mine.example", "wss://mine.example/", "wss://app.example/"]),
    ).toEqual(["wss://app.example", "wss://mine.example"]);
  });

  it("drops relays that aren't relay URLs", () => {
    expect(resolveDiscoverRelays(["wss://app.example"], ["https://nope.example"])).toEqual(["wss://app.example"]);
  });
});

describe("reading a source's list", () => {
  const pack = ok(ARMADA_FOLLOW_PACK);
  const follows = ok(PK);

  it("builds a filter per source type", () => {
    expect(curationFilter(pack)).toEqual({
      kinds: [39089],
      authors: [SOAPBOX],
      "#d": ["k4p5w0n22suf"],
      limit: 1,
    });
    expect(curationFilter(follows)).toEqual({ kinds: [3], authors: [PK], limit: 1 });
    expect(curationFilter({ type: "none" })).toBeNull();
  });

  it("keys sources distinctly", () => {
    expect(new Set([curationKey(pack), curationKey(follows), curationKey({ type: "none" })]).size).toBe(3);
  });

  it("matches only the source's own list event", () => {
    const packEvent = rumor({ kind: 39089, pubkey: SOAPBOX, tags: [["d", "k4p5w0n22suf"]] });
    expect(isCurationEvent(pack, packEvent)).toBe(true);
    expect(isCurationEvent(pack, { ...packEvent, tags: [["d", "other"]] })).toBe(false);
    expect(isCurationEvent(pack, { ...packEvent, pubkey: PK })).toBe(false);
    expect(isCurationEvent(follows, rumor({ kind: 3 }))).toBe(true);
    expect(isCurationEvent(follows, rumor({ kind: 3, pubkey: OTHER }))).toBe(false);
  });

  it("takes only valid hex p tags as members", () => {
    const event = rumor({ tags: [["p", PK], ["p", "nope"], ["e", OTHER], ["p", OTHER]] });
    expect(curatedPubkeys(event)).toEqual([PK, OTHER]);
    expect(curatedPubkeys(undefined)).toEqual([]);
  });
});
