import { describe, expect, it } from "vitest";

import {
  defaultConfig,
  effectiveDmRelays,
  selfStateRelays,
} from "@/contexts/AppContext";
import { DM_RELAYS } from "@/lib/platform";

describe("portable network configuration", () => {
  it("seeds app DM relays from the build only for a fresh config", () => {
    expect(defaultConfig.appDmRelays).toEqual(DM_RELAYS);
  });

  it("uses synchronized app DM relays instead of adding build defaults back", () => {
    const effective = effectiveDmRelays({
      ...defaultConfig,
      appRelays: ["wss://account.example"],
      appDmRelays: ["wss://custom-dm.example"],
      useAppDmRelays: true,
      useOwnDmRelays: false,
    });
    expect(effective).toEqual([
      "wss://account.example",
      "wss://custom-dm.example",
    ]);
  });

  it("keeps NIP-65 write relays in the self-sync set when general use is off", () => {
    const relays = selfStateRelays({
      ...defaultConfig,
      useAppRelays: false,
      useUserRelays: false,
      relayMetadata: {
        pubkey: "a".repeat(64),
        updatedAt: 1,
        relays: [
          { url: "wss://read.example", read: true, write: false },
          { url: "wss://write.example", read: false, write: true },
        ],
      },
    }, "a".repeat(64));
    expect(relays).toEqual(["wss://write.example"]);
  });

  it("does not reuse a previous account's NIP-65 relays", () => {
    const relays = selfStateRelays({
      ...defaultConfig,
      useAppRelays: false,
      relayMetadata: {
        pubkey: "a".repeat(64),
        updatedAt: 1,
        relays: [{ url: "wss://old-account.example", read: true, write: true }],
      },
    }, "b".repeat(64));
    expect(relays).toEqual([]);
  });
});
