/**
 * Wiring test: the entire V2 catch-up — every community, both planes — must
 * reach each relay as ONE REQ, and fresh data must invalidate touched queries.
 */

import { QueryClient } from "@tanstack/react-query";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { EventTemplate, NostrEvent } from "nostr-tools/pure";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { bytesToHex, controlGroupKey } from "@/concord-v2/lib/derive";
import { KIND_SEAL_PLAINTEXT } from "@/concord-v2/lib/kinds";
import { _configureAuthWaitForTests } from "@/concord-v2/lib/planeSync";
import { buildRumor, sealRumor, wrapSeal } from "@/concord-v2/lib/stream";
import type { CommunityV2 } from "@/concord-v2/lib/types";

import { syncControlPlane } from "./controlPlaneSync";

beforeEach(() => {
  // The auth gate is planeSync's concern (planeSync.test.ts); let REQs fly.
  _configureAuthWaitForTests({ settleMs: 0, maxWaitMs: 0 });
});

const RELAY_A = "wss://relay-a.test";
const RELAY_B = "wss://relay-b.test";

interface Filter {
  kinds?: number[];
  authors?: string[];
  since?: number;
  limit?: number;
}

class FakeRelay {
  events: NostrEvent[] = [];
  calls: Filter[][] = [];

  async query(filters: Filter[]): Promise<NostrEvent[]> {
    this.calls.push(filters);
    const out = new Map<string, NostrEvent>();
    for (const f of filters) {
      for (const ev of this.events) {
        if (
          (!f.kinds || f.kinds.includes(ev.kind)) &&
          (!f.authors || f.authors.includes(ev.pubkey)) &&
          (f.since === undefined || ev.created_at >= f.since)
        ) {
          out.set(ev.id, ev);
        }
      }
    }
    return [...out.values()];
  }
}

function signer(sk = generateSecretKey()) {
  return { sk, pubkey: getPublicKey(sk), signEvent: async (t: EventTemplate) => finalizeEvent(t, sk) };
}

function communityOf(fill: number, owner: string): CommunityV2 {
  const root = new Uint8Array(32).fill(fill);
  const id = new Uint8Array(32).fill(fill + 1);
  return {
    id,
    idHex: bytesToHex(id),
    owner,
    ownerSalt: new Uint8Array(32),
    root,
    rootEpoch: 0n,
    heldRoots: [{ epoch: 0n, key: root }],
    privateChannels: [],
    relays: [RELAY_A, RELAY_B],
    name: "test",
  } as CommunityV2;
}

describe("syncControlPlane — batched V2 sweep", () => {
  it("reaches each relay as ONE REQ covering every community's control + guestbook", async () => {
    const owner = signer();
    const a = communityOf(100, owner.pubkey);
    const b = communityOf(104, owner.pubkey);

    // One control edition for A so a touched community's invalidation fires.
    const control = controlGroupKey(a.root, a.id, 0);
    const rumor = buildRumor({
      kind: 3308,
      content: "{}",
      tags: [["vsk", "0"], ["eid", "ab".repeat(32)], ["ev", "1"]],
      pubkey: owner.pubkey,
      ms: null,
      createdAtSecs: Math.floor(Date.now() / 1000) - 100,
    });
    const seal = await sealRumor(rumor, KIND_SEAL_PLAINTEXT, control, owner);
    const w = wrapSeal(seal, control);
    const wrap = finalizeEvent({ kind: w.kind, content: w.content, tags: w.tags, created_at: rumor.created_at }, control.sk);

    const relayA = new FakeRelay();
    relayA.events = [wrap];
    const relayB = new FakeRelay();
    const nostr = { relay: (url: string) => (url === RELAY_A ? relayA : relayB) };

    const queryClient = new QueryClient();
    const invalidated = vi.spyOn(queryClient, "invalidateQueries");

    const result = await syncControlPlane(nostr, queryClient, [], [a, b]);

    // 2 communities × 2 planes = 4 filters, ONE query call per relay.
    for (const relay of [relayA, relayB]) {
      expect(relay.calls.length, "every relay must be asked exactly once").toBe(1);
      expect(relay.calls[0].length).toBe(4);
    }
    expect(result.v2Touched).toEqual(new Set([a.idHex]));
    expect(invalidated).toHaveBeenCalledWith({ queryKey: ["concord2", "control", a.idHex] });
  });
});
