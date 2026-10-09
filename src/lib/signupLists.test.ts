import { generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools";
import { describe, expect, it } from "vitest";

import { APP_BLOSSOM_SERVERS } from "@/lib/blossom";
import { APP_RELAYS, DM_INBOX_RELAYS, RELAY_LIST_DISCOVERY_RELAYS } from "@/lib/platform";
import { buildSignupLists } from "@/lib/signupLists";

const HOME = ["wss://home.example"];

function byKind(lists: ReturnType<typeof buildSignupLists>, kind: number) {
  const found = lists.events.find(({ event }) => event.kind === kind);
  if (!found) throw new Error(`no kind ${kind}`);
  return found;
}

describe("buildSignupLists", () => {
  it("signs the four default lists with the new key", () => {
    const sk = generateSecretKey();
    const lists = buildSignupLists(sk, HOME);
    expect(lists.events.map(({ event }) => event.kind)).toEqual([10002, 10050, 10007, 10063]);
    for (const { event } of lists.events) {
      expect(event.pubkey).toBe(getPublicKey(sk));
      expect(verifyEvent(event)).toBe(true);
      expect(event.content).toBe("");
    }
  });

  it("names the home relays everywhere they are an account's own", () => {
    const lists = buildSignupLists(generateSecretKey(), HOME);
    expect(byKind(lists, 10002).event.tags).toEqual([["r", HOME[0]]]);
    expect(byKind(lists, 10050).event.tags).toEqual(
      [...HOME, ...DM_INBOX_RELAYS].map((url) => ["relay", url]),
    );
    expect(byKind(lists, 10007).event.tags).toEqual(APP_RELAYS.map((url) => ["relay", url]));
    expect(byKind(lists, 10063).event.tags).toEqual(
      APP_BLOSSOM_SERVERS.map((url) => ["server", url]),
    );
  });

  it("publishes the lists other clients look up to the indexers too", () => {
    const lists = buildSignupLists(generateSecretKey(), HOME);
    const discoverable = [...HOME, ...RELAY_LIST_DISCOVERY_RELAYS];
    expect(byKind(lists, 10002).relays).toEqual(discoverable);
    expect(byKind(lists, 10050).relays).toEqual(discoverable);
    expect(byKind(lists, 10007).relays).toEqual(HOME);
    expect(byKind(lists, 10063).relays).toEqual(HOME);
  });

  it("seeds config mirroring the signed lists", () => {
    const lists = buildSignupLists(generateSecretKey(), HOME);
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
      dmRelays: [...HOME, ...DM_INBOX_RELAYS],
      searchRelays: APP_RELAYS,
      blossomServerMetadata: {
        servers: APP_BLOSSOM_SERVERS,
        updatedAt: blossomList.created_at,
        eventId: blossomList.id,
      },
    });
  });

  it("skips the NIP-65 list when there are no home relays", () => {
    const lists = buildSignupLists(generateSecretKey(), []);
    expect(lists.events.map(({ event }) => event.kind)).not.toContain(10002);
    expect(lists.configSeed.relayMetadata).toBeUndefined();
  });
});
