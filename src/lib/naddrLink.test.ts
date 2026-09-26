import { nip19 } from "nostr-tools";
import { describe, expect, it } from "vitest";

import { eventNaddr, naddrPath, naddrShareUrl, parseNaddr } from "@/lib/naddrLink";

import type { NostrRumor } from "@/lib/nostrRumor";

const PK = "a".repeat(64);

function addressable(overrides: Partial<NostrRumor> = {}): NostrRumor {
  return {
    id: "b".repeat(64),
    pubkey: PK,
    kind: 36767,
    created_at: 1,
    content: "",
    tags: [["d", "dusk-x1"], ["title", "Dusk"]],
    ...overrides,
  } as NostrRumor;
}

describe("naddrLink", () => {
  it("round-trips an addressable event through its naddr", () => {
    const naddr = eventNaddr(addressable(), ["wss://a.example/", "wss://b.example/"]);
    expect(naddr).toMatch(/^naddr1/);
    expect(parseNaddr(naddr)).toEqual({
      addr: { kind: 36767, pubkey: PK, identifier: "dusk-x1" },
      relays: ["wss://a.example/", "wss://b.example/"],
    });
  });

  it("works for emoji packs too", () => {
    const naddr = eventNaddr(addressable({ kind: 30030, tags: [["d", "cats"]] }));
    expect(parseNaddr(naddr)?.addr).toEqual({ kind: 30030, pubkey: PK, identifier: "cats" });
  });

  it("caps the relay hints", () => {
    const relays = ["wss://1.example/", "wss://2.example/", "wss://3.example/", "wss://4.example/"];
    expect(parseNaddr(eventNaddr(addressable(), relays))?.relays).toHaveLength(3);
  });

  it("links to the bare /<naddr> path", () => {
    const naddr = eventNaddr(addressable())!;
    expect(naddrPath(naddr)).toBe(`/${naddr}`);
    expect(naddrShareUrl(naddr).endsWith(`/${naddr}`)).toBe(true);
  });

  it("refuses non-addressable events and non-naddr segments", () => {
    expect(eventNaddr(addressable({ kind: 1 }))).toBeUndefined();
    expect(eventNaddr(addressable({ kind: 10030 }))).toBeUndefined();
    expect(parseNaddr(undefined)).toBeNull();
    expect(parseNaddr("naddr1garbage")).toBeNull();
    expect(parseNaddr(nip19.npubEncode(PK))).toBeNull();
  });
});
