import { finalizeEvent } from "nostr-tools";

import { APP_BLOSSOM_SERVERS } from "@/lib/blossom";
import { KIND_RELAY_LIST, uniqueRelayUrls } from "@/lib/nip65";
import { APP_RELAYS, DM_INBOX_RELAYS, RELAY_LIST_DISCOVERY_RELAYS } from "@/lib/platform";
import { KIND_BLOSSOM_SERVERS, KIND_DM_RELAYS, KIND_SEARCH_RELAYS } from "@/lib/selfSyncKinds";

import type { NostrEvent } from "@nostrify/nostrify";

/** One signed list and the relays it is published to. */
export interface SignupListEvent {
  event: NostrEvent;
  relays: string[];
}

export interface SignupLists {
  events: SignupListEvent[];
  /** The new account's scoped config, mirroring the lists so they apply before any relay read. */
  configSeed: Record<string, unknown>;
}

/**
 * The relay and media lists every new account starts with: NIP-65 (10002),
 * NIP-17 DM inbox (10050), NIP-50 search (10007) and BUD-03 Blossom (10063).
 * Only for a key the signup flow generated itself — such a key provably has no
 * list anywhere to overwrite, which is the whole of why publishing is allowed.
 */
export function buildSignupLists(sk: Uint8Array, homeRelays: string[]): SignupLists {
  const home = uniqueRelayUrls(homeRelays);
  const dm = uniqueRelayUrls([...home, ...DM_INBOX_RELAYS]);
  const search = uniqueRelayUrls(APP_RELAYS);
  const blossom = [...APP_BLOSSOM_SERVERS];
  const created_at = Math.floor(Date.now() / 1000);
  const sign = (kind: number, tags: string[][]) =>
    finalizeEvent({ kind, created_at, tags, content: "" }, sk);

  // Indexers too, for the two lists another client must find to reach us.
  const discoverable = uniqueRelayUrls([...home, ...RELAY_LIST_DISCOVERY_RELAYS]);

  const events: SignupListEvent[] = [];
  const configSeed: Record<string, unknown> = { appRelays: home };

  if (home.length > 0) {
    const relayList = sign(KIND_RELAY_LIST, home.map((url) => ["r", url]));
    events.push({ event: relayList, relays: discoverable });
    configSeed.relayMetadata = {
      relays: home.map((url) => ({ url, read: true, write: true })),
      updatedAt: created_at,
      eventId: relayList.id,
      pubkey: relayList.pubkey,
    };
  }
  if (dm.length > 0) {
    events.push({ event: sign(KIND_DM_RELAYS, dm.map((url) => ["relay", url])), relays: discoverable });
    configSeed.dmRelays = dm;
  }
  if (search.length > 0) {
    events.push({ event: sign(KIND_SEARCH_RELAYS, search.map((url) => ["relay", url])), relays: home });
    configSeed.searchRelays = search;
  }
  if (blossom.length > 0) {
    const blossomList = sign(KIND_BLOSSOM_SERVERS, blossom.map((url) => ["server", url]));
    events.push({ event: blossomList, relays: home });
    configSeed.blossomServerMetadata = {
      servers: blossom,
      updatedAt: created_at,
      eventId: blossomList.id,
    };
  }
  return { events, configSeed };
}
