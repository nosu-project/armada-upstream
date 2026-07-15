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
import { queryByStreams } from "@/concord-v2/lib/rumorStore";
import { buildRumor, sealRumor, wrapSeal } from "@/concord-v2/lib/stream";
import type { CommunityV2 } from "@/concord-v2/lib/types";

import { syncControlPlane } from "./controlPlaneSync";

beforeEach(() => {
  // The auth gate is planeSync's concern (planeSync.test.ts); let REQs fly.
  _configureAuthWaitForTests({ maxWaitMs: 0 });
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
  online = true;

  async query(filters: Filter[]): Promise<NostrEvent[]> {
    this.calls.push(filters);
    if (!this.online) throw new Error("relay offline");
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

  it(
    "issue #19: a late older edition from a relay that was down is picked up by a later sweep",
    { timeout: 30_000 },
    async () => {
      // The end-to-end heal that used to live in useControlPlane2.test.tsx,
      // now owned by the sweep layer. Per-relay cursors (control:<id>|<url>)
      // mean a relay that was down during the first sweep is re-asked from its
      // OWN (unadvanced) cursor — so an edition with an OLDER created_at that
      // only becomes visible after the community-wide cursor "moved past" it is
      // still fetched, rather than skipped forever by a shared `since` floor.
      const owner = signer();
      const community = communityOf(200, owner.pubkey);
      const control = controlGroupKey(community.root, community.id, 0);

      const editionAt = async (eid: string, createdAt: number) => {
        const rumor = buildRumor({
          kind: 3308,
          content: "{}",
          tags: [["vsk", "0"], ["eid", eid], ["ev", "1"]],
          pubkey: owner.pubkey,
          ms: null,
          createdAtSecs: createdAt,
        });
        const seal = await sealRumor(rumor, KIND_SEAL_PLAINTEXT, control, owner);
        const w = wrapSeal(seal, control);
        const wrap = finalizeEvent(
          { kind: w.kind, content: w.content, tags: w.tags, created_at: createdAt },
          control.sk,
        );
        return { wrap, rumorId: rumor.id };
      };

      const now = Math.floor(Date.now() / 1000);
      // E1 is OLDER and lives only on relay B (down during the first sweep).
      const e1 = await editionAt("ab".repeat(32), now - 5000);
      // E2 is newer and lives on relay A.
      const e2 = await editionAt("cd".repeat(32), now - 1000);

      const relayA = new FakeRelay();
      relayA.events = [e2.wrap];
      const relayB = new FakeRelay();
      relayB.online = false; // down for the first round
      relayB.events = [e1.wrap];
      const nostr = { relay: (url: string) => (url === RELAY_A ? relayA : relayB) };

      const queryClient = new QueryClient();

      // First sweep: E2 lands from relay A; relay B fails (its cursor stays put).
      const first = await syncControlPlane(nostr, queryClient, [], [community]);
      expect(first.v2Touched).toEqual(new Set([community.idHex]));
      let stored = await queryByStreams([control.pk]);
      expect(stored.map((e) => e.rumorId)).toContain(e2.rumorId);
      expect(stored.map((e) => e.rumorId)).not.toContain(e1.rumorId);

      // Relay B comes back with the OLDER edition E1.
      relayB.online = true;

      // A later sweep must pick E1 up — relay B is asked from its own cursor
      // (never advanced), not the newer A-driven one, so the older edition is
      // not skipped.
      const second = await syncControlPlane(nostr, queryClient, [], [community]);
      expect(second.v2Touched).toEqual(new Set([community.idHex]));
      stored = await queryByStreams([control.pk]);
      expect(stored.map((e) => e.rumorId), "the late older edition E1 must eventually land").toContain(
        e1.rumorId,
      );
    },
  );
});
