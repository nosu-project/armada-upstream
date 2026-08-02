import { nip19 } from "nostr-tools";
import { describe, expect, it } from "vitest";

import { parseNip05Address } from "@/lib/nip05Address";
import { resolvePubkey } from "@/lib/resolvePubkey";

const HEX = "0".repeat(63) + "1";
const NPUB = nip19.npubEncode(HEX);

describe("parseNip05Address", () => {
  it("splits a full address", () => {
    expect(parseNip05Address("mk@ditto.pub")).toEqual({
      name: "mk",
      domain: "ditto.pub",
      address: "mk@ditto.pub",
      display: "mk@ditto.pub",
    });
  });

  it("expands a bare domain to the root user and shows it bare", () => {
    expect(parseNip05Address("ditto.pub")).toEqual({
      name: "_",
      domain: "ditto.pub",
      address: "_@ditto.pub",
      display: "ditto.pub",
    });
  });

  it("accepts the leading @ people write handles with", () => {
    expect(parseNip05Address("@mk@ditto.pub")?.address).toBe("mk@ditto.pub");
  });

  it("lowercases the domain but leaves the name alone", () => {
    expect(parseNip05Address("MK@Ditto.PUB")?.address).toBe("MK@ditto.pub");
  });

  it("rejects a segment with no dot in the domain, so unrouted paths 404", () => {
    expect(parseNip05Address("settings")).toBeUndefined();
    expect(parseNip05Address("setttings")).toBeUndefined();
    expect(parseNip05Address("mk@localhost")).toBeUndefined();
  });

  it("rejects malformed input", () => {
    expect(parseNip05Address("")).toBeUndefined();
    expect(parseNip05Address("  ")).toBeUndefined();
    expect(parseNip05Address("a@b@ditto.pub")).toBeUndefined();
    expect(parseNip05Address("mk@ditto.pub/extra")).toBeUndefined();
    expect(parseNip05Address("mk @ditto.pub")).toBeUndefined();
  });

  it("does not mistake a bech32 identifier for an address", () => {
    expect(parseNip05Address(NPUB)).toBeUndefined();
  });
});

describe("resolvePubkey", () => {
  it("passes hex through, lowercased", () => {
    expect(resolvePubkey(HEX.toUpperCase())).toBe(HEX);
  });

  it("decodes an npub", () => {
    expect(resolvePubkey(NPUB)).toBe(HEX);
  });

  it("decodes an nprofile to its pubkey", () => {
    expect(resolvePubkey(nip19.nprofileEncode({ pubkey: HEX }))).toBe(HEX);
  });

  it("returns undefined instead of throwing on junk", () => {
    expect(resolvePubkey("npub1notreallybech32")).toBeUndefined();
    expect(resolvePubkey("ditto.pub")).toBeUndefined();
    expect(resolvePubkey("")).toBeUndefined();
  });
});
