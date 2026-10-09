import { describe, expect, it } from "vitest";

import {
  accountDataRelays,
  broadcastWriteRelays,
  defaultConfig,
  effectiveDmRelays,
  selfStateRelays,
} from "@/contexts/AppContext";
import { BROADCAST_RELAYS } from "@/lib/platform";

describe("portable network configuration", () => {
  it("enables automatic settings sync only as a fresh device-local default", () => {
    expect(defaultConfig.automaticSettingsSync).toBe(true);
  });

  it("receives DMs on the published inbox plus the app relays", () => {
    const effective = effectiveDmRelays({
      ...defaultConfig,
      appRelays: ["wss://account.example"],
      dmRelays: ["wss://inbox.example"],
    });
    expect(effective).toEqual(["wss://inbox.example", "wss://account.example"]);
  });

  it("drops the app relays from the DM set when they are switched off", () => {
    const effective = effectiveDmRelays({
      ...defaultConfig,
      useAppRelays: false,
      appRelays: ["wss://account.example"],
      dmRelays: ["wss://inbox.example"],
    });
    expect(effective).toEqual(["wss://inbox.example"]);
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

  it("does not adopt an unattributed cached relay list", () => {
    const relays = selfStateRelays({
      ...defaultConfig,
      useAppRelays: false,
      relayMetadata: {
        updatedAt: 1,
        relays: [{ url: "wss://legacy.example", read: true, write: true }],
      },
    }, "a".repeat(64));
    expect(relays).toEqual([]);
  });

  it("ships the build's write-only relays as the default broadcast set", () => {
    expect(defaultConfig.broadcastRelays).toEqual(BROADCAST_RELAYS);
    expect(BROADCAST_RELAYS).toContain("wss://relay.primal.net");
  });

  it("drops broadcast relays when the app relays are switched off", () => {
    expect(broadcastWriteRelays({ ...defaultConfig, useAppRelays: false })).toEqual([]);
  });

  it("normalizes and dedupes the broadcast set", () => {
    const relays = broadcastWriteRelays({
      ...defaultConfig,
      broadcastRelays: [
        "wss://broadcast.example/",
        "wss://broadcast.example",
        "not a relay",
        "  ",
      ],
    });
    expect(relays).toEqual(["wss://broadcast.example"]);
  });

  it("keeps broadcast relays out of every set that is ever read from", () => {
    const config = {
      ...defaultConfig,
      appRelays: ["wss://account.example"],
      broadcastRelays: ["wss://broadcast.example"],
      relayMetadata: {
        pubkey: "a".repeat(64),
        updatedAt: 1,
        relays: [{ url: "wss://write.example", read: false, write: true }],
      },
    };
    const pubkey = "a".repeat(64);
    expect(broadcastWriteRelays(config)).toEqual(["wss://broadcast.example"]);
    expect(accountDataRelays(config, pubkey)).not.toContain("wss://broadcast.example");
    expect(selfStateRelays(config, pubkey)).not.toContain("wss://broadcast.example");
    expect(effectiveDmRelays(config)).not.toContain("wss://broadcast.example");
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
