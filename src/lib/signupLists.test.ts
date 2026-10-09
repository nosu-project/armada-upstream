import { generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools";
import { describe, expect, it } from "vitest";

import { APP_BLOSSOM_SERVERS } from "@/lib/blossom";
import { APP_RELAYS, DM_INBOX_RELAYS, RELAY_LIST_DISCOVERY_RELAYS } from "@/lib/platform";
import { buildSignupLists, defaultSignupSetup, type SignupSetup } from "@/lib/signupLists";

const HOME = ["wss://home.example"];
const CONFIG = {
  searchRelays: ["wss://search.example"],
  communityRelays: ["wss://community.example"],
  broadcastRelays: ["wss://broadcast.example"],
};

function byKind(lists: ReturnType<typeof buildSignupLists>, kind: number) {
  const found = lists.events.find(({ event }) => event.kind === kind);
  if (!found) throw new Error(`no kind ${kind}`);
  return found;
}

const setup = (over: Partial<SignupSetup> = {}): SignupSetup => ({
  ...defaultSignupSetup(HOME, CONFIG),
  ...over,
});

describe("defaultSignupSetup", () => {
  it("fills every list from the home relays and the app defaults", () => {
    expect(defaultSignupSetup(HOME, CONFIG)).toEqual({
      home: HOME,
      dm: [...HOME, ...DM_INBOX_RELAYS],
      search: CONFIG.searchRelays,
      blossom: APP_BLOSSOM_SERVERS,
      community: CONFIG.communityRelays,
      broadcast: CONFIG.broadcastRelays,
    });
  });

  it("falls back to the app relays for no home relays and no search relays", () => {
    const defaults = defaultSignupSetup([], { ...CONFIG, searchRelays: [] });
    expect(defaults.home).toEqual(APP_RELAYS);
    expect(defaults.search).toEqual(APP_RELAYS);
  });
});

describe("buildSignupLists", () => {
  it("signs the four list events with the new key", () => {
    const sk = generateSecretKey();
    const lists = buildSignupLists(sk, setup());
    expect(lists.events.map(({ event }) => event.kind)).toEqual([10002, 10050, 10007, 10063]);
    for (const { event } of lists.events) {
      expect(event.pubkey).toBe(getPublicKey(sk));
      expect(verifyEvent(event)).toBe(true);
      expect(event.content).toBe("");
    }
  });

  it("names exactly the lists the user chose", () => {
    const lists = buildSignupLists(generateSecretKey(), setup({
      dm: ["wss://dm.example"],
      search: ["wss://find.example"],
      blossom: ["https://media.example"],
    }));
    expect(byKind(lists, 10002).event.tags).toEqual([["r", HOME[0]]]);
    expect(byKind(lists, 10050).event.tags).toEqual([["relay", "wss://dm.example"]]);
    expect(byKind(lists, 10007).event.tags).toEqual([["relay", "wss://find.example"]]);
    expect(byKind(lists, 10063).event.tags).toEqual([["server", "https://media.example/"]]);
  });

  it("publishes the lists other clients look up to the indexers too", () => {
    const lists = buildSignupLists(generateSecretKey(), setup());
    const discoverable = [...HOME, ...RELAY_LIST_DISCOVERY_RELAYS];
    expect(byKind(lists, 10002).relays).toEqual(discoverable);
    expect(byKind(lists, 10050).relays).toEqual(discoverable);
    expect(byKind(lists, 10007).relays).toEqual(HOME);
    expect(byKind(lists, 10063).relays).toEqual(HOME);
  });

  it("seeds every list into config", () => {
    const chosen = setup();
    const lists = buildSignupLists(generateSecretKey(), chosen);
    const relayList = byKind(lists, 10002).event;
    const blossomList = byKind(lists, 10063).event;
    expect(lists.configSeed).toEqual({
      appRelays: HOME,
      relayMetadata: {
        relays: [{ url: HOME[0], read: true, write: true }],
        updatedAt: relayList.created_at,
        eventId: relayList.id,
        pubkey: relayList.pubkey,
      },
      dmRelays: chosen.dm,
      searchRelays: chosen.search,
      communityRelays: chosen.community,
      broadcastRelays: chosen.broadcast,
      blossomServerMetadata: {
        servers: APP_BLOSSOM_SERVERS,
        updatedAt: blossomList.created_at,
        eventId: blossomList.id,
      },
    });
  });

  it("honours an emptied list by publishing nothing for it", () => {
    const lists = buildSignupLists(generateSecretKey(), setup({ dm: [], search: [], blossom: [], broadcast: [] }));
    expect(lists.events.map(({ event }) => event.kind)).toEqual([10002]);
    expect(lists.configSeed.dmRelays).toEqual([]);
    expect(lists.configSeed.broadcastRelays).toEqual([]);
    expect(lists.configSeed.blossomServerMetadata).toBeUndefined();
  });

  it("falls back to the app relays when the home list is emptied", () => {
    const lists = buildSignupLists(generateSecretKey(), setup({ home: [] }));
    expect(lists.configSeed.appRelays).toEqual(APP_RELAYS);
    expect(byKind(lists, 10002).event.tags).toEqual(APP_RELAYS.map((url) => ["r", url]));
  });
});
