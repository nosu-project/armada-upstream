import { describe, expect, it } from "vitest";

import { isBuzzRelayInfo } from "@/buzz/detect";
import type { RelayInfoDocument } from "@/hooks/useRelayInfo";

describe("isBuzzRelayInfo", () => {
  it("is false without a document", () => {
    expect(isBuzzRelayInfo(undefined)).toBe(false);
    expect(isBuzzRelayInfo({})).toBe(false);
  });

  it("recognizes the reference block/buzz relay by software", () => {
    expect(isBuzzRelayInfo({ software: "https://github.com/block/buzz" })).toBe(true);
  });

  it("recognizes a Buzz relay by a non-empty supported_extensions", () => {
    expect(isBuzzRelayInfo({ supported_extensions: ["nip-er"] })).toBe(true);
    expect(isBuzzRelayInfo({ supported_extensions: [] })).toBe(false);
  });

  it("recognizes newlay in Buzz mode (software newlay + pairing_relay_url)", () => {
    // The denimroad.feeds.relay.tools shape: newlay run under `[buzz]`.
    const info: RelayInfoDocument = {
      software: "newlay",
      version: "0.3.43",
      supported_nips: [1, 9, 11, 29, 34, 40, 42, 43, 45, 50, 70, 77, 86, 65535],
      pairing_relay_url: "wss://denimroad.feeds.relay.tools/pair",
    };
    expect(isBuzzRelayInfo(info)).toBe(true);
  });

  it("leaves a plain newlay relay as standard NIP-29", () => {
    // No pairing URL → not Buzz mode → standard NIP-29 (kind-9 NIP-10 reply is
    // an inline quote, not a thread).
    expect(
      isBuzzRelayInfo({
        software: "newlay",
        version: "0.3.43",
        supported_nips: [1, 9, 11, 29, 40, 42, 43, 45, 50, 77, 86, 65535],
      }),
    ).toBe(false);
  });

  it("does not treat a non-newlay relay's pairing URL as Buzz", () => {
    // pairing_relay_url alone is a NIP-AB field, not a Buzz marker: it only
    // implies Buzz mode on newlay.
    expect(
      isBuzzRelayInfo({ software: "strfry", pairing_relay_url: "wss://example.com/pair" }),
    ).toBe(false);
  });

  it("ignores an empty pairing_relay_url on newlay", () => {
    expect(isBuzzRelayInfo({ software: "newlay", pairing_relay_url: "" })).toBe(false);
  });
});
