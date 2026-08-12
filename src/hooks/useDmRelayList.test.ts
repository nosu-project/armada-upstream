import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { describe, expect, it, vi } from "vitest";

import {
  discoverDmRelaysFor,
  KIND_DM_RELAYS,
} from "@/hooks/useDmRelayList";
import { KIND_RELAY_LIST } from "@/lib/nip65";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

const peerSk = generateSecretKey();
const peer = getPublicKey(peerSk);

function signedEvent(
  kind: number,
  tags: string[][],
  createdAt: number,
): NostrEvent {
  return finalizeEvent({ kind, content: "", tags, created_at: createdAt }, peerSk);
}

describe("NIP-17 DM relay discovery", () => {
  it("reads a peer inbox from an explicit discovery relay", async () => {
    const inbox = signedEvent(
      KIND_DM_RELAYS,
      [["relay", "WSS://INBOX.EXAMPLE/"]],
      1_000,
    );
    const nostr = {
      relay: () => ({ query: async () => [inbox] }),
    };

    await expect(discoverDmRelaysFor(
      nostr,
      peer,
      ["wss://discovery.example"],
      new AbortController().signal,
      { followPeerRelays: false },
    )).resolves.toEqual(["wss://inbox.example"]);
  });

  it("follows the peer's NIP-65 write relays to find kind 10050", async () => {
    const relayList = signedEvent(
      KIND_RELAY_LIST,
      [
        ["r", "wss://read.example", "read"],
        ["r", "wss://private.example", "write"],
      ],
      2_000,
    );
    const inbox = signedEvent(
      KIND_DM_RELAYS,
      [["relay", "wss://dm.example"]],
      2_001,
    );
    const query = vi.fn(async (url: string, filters: NostrFilter[]) => {
      if (url === "wss://discovery.example") return [relayList];
      if (url === "wss://private.example" && filters[0]?.kinds?.includes(KIND_DM_RELAYS)) {
        return [inbox];
      }
      return [] as NostrEvent[];
    });
    const nostr = {
      relay: (url: string) => ({
        query: (filters: NostrFilter[]) => query(url, filters),
      }),
    };

    await expect(discoverDmRelaysFor(
      nostr,
      peer,
      ["wss://discovery.example"],
      new AbortController().signal,
      { followPeerRelays: true },
    )).resolves.toEqual(["wss://dm.example"]);
    expect(query).toHaveBeenCalledWith(
      "wss://private.example",
      [{ kinds: [KIND_DM_RELAYS], authors: [peer], limit: 1 }],
    );
    expect(query.mock.calls.some(([url]) => url === "wss://read.example")).toBe(false);
  });

  it("never dials a peer-named relay when following is not permitted", async () => {
    const relayList = signedEvent(
      KIND_RELAY_LIST,
      [["r", "wss://private.example", "write"]],
      2_000,
    );
    const query = vi.fn(async (url: string) => (
      url === "wss://discovery.example" ? [relayList] : [] as NostrEvent[]
    ));
    const nostr = {
      relay: (url: string) => ({ query: () => query(url) }),
    };

    // No inbox is found, and — the point of the case — the viewer's client
    // never opens a socket to the relay the PEER named.
    await expect(discoverDmRelaysFor(
      nostr,
      peer,
      ["wss://discovery.example"],
      new AbortController().signal,
      { followPeerRelays: false },
    )).resolves.toEqual([]);
    expect(query.mock.calls.some(([url]) => url === "wss://private.example")).toBe(false);
  });

  it("honors a newer empty inbox list found on the peer's relays", async () => {
    const oldInbox = signedEvent(
      KIND_DM_RELAYS,
      [["relay", "wss://old.example"]],
      3_000,
    );
    const relayList = signedEvent(
      KIND_RELAY_LIST,
      [["r", "wss://private.example", "write"]],
      3_001,
    );
    const clearedInbox = signedEvent(KIND_DM_RELAYS, [], 3_002);
    const nostr = {
      relay: (url: string) => ({
        query: async () => url === "wss://private.example"
          ? [clearedInbox]
          : [oldInbox, relayList],
      }),
    };

    await expect(discoverDmRelaysFor(
      nostr,
      peer,
      ["wss://discovery.example"],
      new AbortController().signal,
      { followPeerRelays: true },
    )).resolves.toEqual([]);
  });
});
