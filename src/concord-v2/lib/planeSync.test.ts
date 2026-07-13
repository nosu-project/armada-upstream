/**
 * Tests for the plane-sweep discipline (planeSync.ts):
 * batching, single-flight, auth-gating, per-scope cursors, retry.
 */

import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { EventTemplate, NostrEvent } from "nostr-tools/pure";
import { beforeEach, describe, expect, it } from "vitest";

import { controlGroups } from "@/concord-v2/lib/control";
import { bytesToHex, controlGroupKey, guestbookGroupKey } from "@/concord-v2/lib/derive";
import { guestbookGroups } from "@/concord-v2/lib/guestbook";
import { KIND_SEAL_PLAINTEXT } from "@/concord-v2/lib/kinds";
import {
  _configureAuthWaitForTests,
  controlScope,
  guestbookScope,
  sweepControl,
  sweepGuestbook,
  sweepRelayScopes,
} from "@/concord-v2/lib/planeSync";
import {
  _resetStreamAuthRegistry,
  noteAuthResult,
  noteRelayChallenged,
  noteStreamAuthSent,
  registerStreamKeys,
} from "@/concord-v2/lib/streamAuth";
import { buildRumor, sealRumor, wrapSeal, type Rumor } from "@/concord-v2/lib/stream";
import type { CommunityV2 } from "@/concord-v2/lib/types";

// ── Fake relay ───────────────────────────────────────────────────────────────

interface Filter {
  kinds?: number[];
  authors?: string[];
  since?: number;
  limit?: number;
}

class FakeRelay {
  events: NostrEvent[] = [];
  /** Each `.query()` call's filter set, in arrival order. */
  calls: Filter[][] = [];
  /** Artificial answer latency, so concurrent sweeps genuinely overlap. */
  delayMs = 0;
  /** Fail this many queries before answering (socket-swap/timeout stand-in). */
  failNext = 0;

  async query(filters: Filter[]): Promise<NostrEvent[]> {
    this.calls.push(filters);
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("relay round lost");
    }
    const out = new Map<string, NostrEvent>();
    for (const f of filters) {
      // Per-filter matching with a PER-FILTER limit (NIP-01), like a real relay.
      const matched = this.events
        .filter(
          (ev) =>
            (!f.kinds || f.kinds.includes(ev.kind)) &&
            (!f.authors || f.authors.includes(ev.pubkey)) &&
            (f.since === undefined || ev.created_at >= f.since),
        )
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, f.limit);
      for (const ev of matched) out.set(ev.id, ev);
    }
    return [...out.values()];
  }
}

function poolOf(relays: Record<string, FakeRelay>) {
  return { relay: (url: string) => relays[url] };
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const RELAY_A = "wss://relay-a.test";

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
    relays: [RELAY_A],
    name: "test",
  } as CommunityV2;
}

/** A plane wrap (edition-shaped rumor) with a controlled outer created_at. */
async function wrapAt(
  group: ReturnType<typeof controlGroupKey>,
  s: ReturnType<typeof signer>,
  eid: string,
  createdAt: number,
): Promise<{ wrap: NostrEvent; rumor: Rumor }> {
  const rumor = buildRumor({
    kind: 3308,
    content: "{}",
    tags: [["vsk", "0"], ["eid", eid], ["ev", "1"]],
    pubkey: s.pubkey,
    ms: null,
    createdAtSecs: createdAt,
  });
  const seal = await sealRumor(rumor, KIND_SEAL_PLAINTEXT, group, s);
  const w = wrapSeal(seal, group);
  const wrap = finalizeEvent({ kind: w.kind, content: w.content, tags: w.tags, created_at: createdAt }, group.sk);
  return { wrap, rumor };
}

// ── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  _resetStreamAuthRegistry();
  // Most tests exercise the fetch discipline, not the auth gate — let sweeps
  // proceed immediately (maxWaitMs 0 = the cap expires at once).
  _configureAuthWaitForTests({ maxWaitMs: 0 });
});

describe("sweepRelayScopes — stream-auth gate", () => {
  it("holds every caller's REQ until the stream keys register, then fires", async () => {
    _configureAuthWaitForTests({ maxWaitMs: 5_000 });
    const owner = signer();
    const community = communityOf(20, owner.pubkey);
    const control = controlGroupKey(community.root, community.id, 0);
    const now = Math.floor(Date.now() / 1000);
    const e1 = await wrapAt(control, owner, "ab".repeat(32), now - 100);

    const relay = new FakeRelay();
    relay.events = [e1.wrap];
    const nostr = poolOf({ [RELAY_A]: relay });

    // The hook fires before useRegisterAllStreamKeys2 has registered the keys.
    const sweep = sweepControl(nostr, community);
    await new Promise((r) => setTimeout(r, 250));
    expect(relay.calls.length, "an unauthenticatable REQ must never leave the client").toBe(0);

    // Keys register (an unchallenged relay needs no AUTH acks)…
    registerStreamKeys(controlGroups(community), community.relays);
    const fresh = await sweep;

    // …and only then does the REQ go out.
    expect(relay.calls.length).toBe(1);
    expect(fresh.map((e) => e.rumorId)).toContain(e1.rumor.id);
  });

  it("on a CHALLENGED relay, holds the REQ until the relay ACKS the stream AUTHs", async () => {
    _configureAuthWaitForTests({ maxWaitMs: 5_000 });
    const owner = signer();
    const community = communityOf(22, owner.pubkey);
    const control = controlGroupKey(community.root, community.id, 0);
    const now = Math.floor(Date.now() / 1000);
    const e1 = await wrapAt(control, owner, "ab".repeat(32), now - 100);

    const relay = new FakeRelay();
    relay.events = [e1.wrap];
    const nostr = poolOf({ [RELAY_A]: relay });

    // The relay issued a NIP-42 challenge on the live socket; AUTH frames for
    // the community's groups are in flight but not yet acked.
    noteRelayChallenged(RELAY_A);
    const groups = controlGroups(community);
    registerStreamKeys(groups, community.relays);
    groups.forEach((g, i) => noteStreamAuthSent(RELAY_A, `auth-ev-${i}`, g.pk));

    const sweep = sweepControl(nostr, community);
    await new Promise((r) => setTimeout(r, 250));
    expect(relay.calls.length, "a REQ must wait for the relay's AUTH acks").toBe(0);

    // The relay acks each AUTH (["OK", id, true]) — the gate opens.
    groups.forEach((_, i) => noteAuthResult(RELAY_A, `auth-ev-${i}`, true));
    const fresh = await sweep;

    expect(relay.calls.length).toBe(1);
    expect(fresh.map((e) => e.rumorId)).toContain(e1.rumor.id);
  });

  it("proceeds after the wait cap even if keys never register (cursor discipline still heals)", async () => {
    _configureAuthWaitForTests({ maxWaitMs: 300 });
    const owner = signer();
    const community = communityOf(24, owner.pubkey);
    const relay = new FakeRelay();
    const nostr = poolOf({ [RELAY_A]: relay });

    const fresh = await sweepControl(nostr, community);

    expect(relay.calls.length, "the cap must not let a sweep hang forever").toBe(1);
    expect(fresh).toEqual([]);
  });

  it("sweeps arriving while the gate is closed coalesce into ONE REQ when it opens", async () => {
    _configureAuthWaitForTests({ maxWaitMs: 5_000 });
    const owner = signer();
    const a = communityOf(28, owner.pubkey);
    const b = communityOf(32, owner.pubkey);
    const now = Math.floor(Date.now() / 1000);
    const aCtl = await wrapAt(controlGroupKey(a.root, a.id, 0), owner, "ab".repeat(32), now - 100);

    const relay = new FakeRelay();
    relay.events = [aCtl.wrap];
    const nostr = poolOf({ [RELAY_A]: relay });

    // Two communities' hooks fire independently pre-registration.
    const sweeps = Promise.all([
      sweepControl(nostr, a),
      sweepGuestbook(nostr, a),
      sweepControl(nostr, b),
      sweepGuestbook(nostr, b),
    ]);
    registerStreamKeys(
      [...controlGroups(a), ...guestbookGroups(a), ...controlGroups(b), ...guestbookGroups(b)],
      [RELAY_A],
    );
    const [aFresh] = await sweeps;

    expect(relay.calls.length, "held sweeps must merge into one REQ per relay").toBe(1);
    expect(relay.calls[0].length, "one filter per scope").toBe(4);
    expect(aFresh.map((e) => e.rumorId)).toContain(aCtl.rumor.id);
  });
  it("registrations irrelevant to the batch's scopes never hold its gate", { timeout: 15_000 }, async () => {
    _configureAuthWaitForTests({ maxWaitMs: 3_000 });
    const owner = signer();
    const community = communityOf(36, owner.pubkey);
    const control = controlGroupKey(community.root, community.id, 0);
    const now = Math.floor(Date.now() / 1000);
    const e1 = await wrapAt(control, owner, "ab".repeat(32), now - 100);

    const relay = new FakeRelay();
    relay.events = [e1.wrap];
    const nostr = poolOf({ [RELAY_A]: relay });

    // Keep the registry PERMANENTLY noisy with keys foreign to this batch.
    const churn = setInterval(() => {
      registerStreamKeys([
        {
          pk: bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
          sk: new Uint8Array(32),
          convKey: new Uint8Array(32),
        },
      ]);
    }, 100);
    try {
      registerStreamKeys(controlGroups(community), community.relays);
      const started = Date.now();
      const fresh = await sweepControl(nostr, community);
      const took = Date.now() - started;

      expect(relay.calls.length).toBe(1);
      expect(fresh.map((e) => e.rumorId)).toContain(e1.rumor.id);
      // The gate tracks the batch's own keys, so foreign churn (other
      // communities registering) must not delay the sweep toward the cap.
      expect(took, "the gate must track the batch's own keys, not global churn").toBeLessThan(2_000);
    } finally {
      clearInterval(churn);
    }
  });
});

describe("sweepRelayScopes — resilience", () => {
  it("retries a lost relay round once, in place", async () => {
    const owner = signer();
    const community = communityOf(72, owner.pubkey);
    const control = controlGroupKey(community.root, community.id, 0);
    const now = Math.floor(Date.now() / 1000);
    const e1 = await wrapAt(control, owner, "ab".repeat(32), now - 100);

    const relay = new FakeRelay();
    relay.events = [e1.wrap];
    relay.failNext = 1; // the swap eats the first round
    const nostr = poolOf({ [RELAY_A]: relay });

    const fresh = await sweepControl(nostr, community);

    expect(relay.calls.length, "one retry after the lost round").toBe(2);
    expect(fresh.map((e) => e.rumorId)).toContain(e1.rumor.id);
  });

  it("gives up after the retry — cursors stay put so the next sweep re-asks in full", async () => {
    const owner = signer();
    const community = communityOf(76, owner.pubkey);
    const control = controlGroupKey(community.root, community.id, 0);
    const now = Math.floor(Date.now() / 1000);
    const e1 = await wrapAt(control, owner, "ab".repeat(32), now - 100);

    const relay = new FakeRelay();
    relay.events = [e1.wrap];
    relay.failNext = 2; // both rounds lost
    const nostr = poolOf({ [RELAY_A]: relay });

    const fresh = await sweepControl(nostr, community);
    expect(relay.calls.length).toBe(2);
    expect(fresh).toEqual([]);

    // The next sweep must re-ask from scratch — no cursor advanced.
    const healed = await sweepControl(nostr, community);
    expect(relay.calls[2][0].since).toBeUndefined();
    expect(healed.map((e) => e.rumorId)).toContain(e1.rumor.id);
  });
});

describe("sweepRelayScopes — one REQ per relay, per-scope filters", () => {
  it("sweeps many communities' planes through ONE relay REQ, demuxed per scope", async () => {
    const owner = signer();
    const a = communityOf(40, owner.pubkey);
    const b = communityOf(44, owner.pubkey);
    const now = Math.floor(Date.now() / 1000);
    const aCtl = await wrapAt(controlGroupKey(a.root, a.id, 0), owner, "ab".repeat(32), now - 100);
    const bGb = await wrapAt(guestbookGroupKey(b.root, b.id, 0), owner, "cd".repeat(32), now - 90);

    const relay = new FakeRelay();
    relay.events = [aCtl.wrap, bGb.wrap];
    const nostr = poolOf({ [RELAY_A]: relay });

    const scopes = [
      controlScope(a, RELAY_A),
      guestbookScope(a, RELAY_A),
      controlScope(b, RELAY_A),
      guestbookScope(b, RELAY_A),
    ];
    const result = await sweepRelayScopes(nostr, RELAY_A, scopes);

    expect(relay.calls.length, "the whole catch-up must be one REQ").toBe(1);
    expect(relay.calls[0].length, "one filter per community-plane").toBe(4);
    expect(result.get(scopes[0].scope)?.map((e) => e.rumorId)).toContain(aCtl.rumor.id);
    expect(result.get(scopes[3].scope)?.map((e) => e.rumorId)).toContain(bGb.rumor.id);
    expect(result.get(scopes[1].scope)).toEqual([]);
    expect(result.get(scopes[2].scope)).toEqual([]);
  });

  it("advances each scope's cursor independently inside one batch (issue #19 isolation)", async () => {
    const owner = signer();
    const a = communityOf(48, owner.pubkey);
    const b = communityOf(52, owner.pubkey);
    const now = Math.floor(Date.now() / 1000);
    // Only community A has an edition; B's plane is still empty on this relay.
    const aCtl = await wrapAt(controlGroupKey(a.root, a.id, 0), owner, "ab".repeat(32), now - 100);

    const relay = new FakeRelay();
    relay.events = [aCtl.wrap];
    const nostr = poolOf({ [RELAY_A]: relay });

    const scopesOf = () => [controlScope(a, RELAY_A), controlScope(b, RELAY_A)];
    await sweepRelayScopes(nostr, RELAY_A, scopesOf());
    await sweepRelayScopes(nostr, RELAY_A, scopesOf());

    expect(relay.calls.length).toBe(2);
    const [aFilter, bFilter] = relay.calls[1];
    expect(aFilter.since, "A saw an edition — its cursor advances").toBe(aCtl.wrap.created_at);
    // B must be re-asked from the start: A's newer edition must NEVER move
    // B's cursor past editions B hasn't seen (the issue-#19 skip).
    expect(bFilter.since, "B saw nothing — its cursor must not move").toBeUndefined();
  });

  it("a community hook's sweep joins a batched sweep already in flight (no duplicate fetch)", async () => {
    const owner = signer();
    const a = communityOf(56, owner.pubkey);
    const b = communityOf(60, owner.pubkey);
    const now = Math.floor(Date.now() / 1000);
    const aCtl = await wrapAt(controlGroupKey(a.root, a.id, 0), owner, "ab".repeat(32), now - 100);

    const relay = new FakeRelay();
    relay.events = [aCtl.wrap];
    relay.delayMs = 150; // the hook's sweep starts while the batch is mid-flight
    const nostr = poolOf({ [RELAY_A]: relay });

    // The global background sweep and useControlEvents2's queryFn fire together.
    const [batch, hook] = await Promise.all([
      sweepRelayScopes(nostr, RELAY_A, [controlScope(a, RELAY_A), controlScope(b, RELAY_A)]),
      sweepControl(nostr, a),
    ]);

    expect(relay.calls.length, "the hook must join the in-flight batch, not re-fetch").toBe(1);
    expect(batch.get(controlScope(a, RELAY_A).scope)?.map((e) => e.rumorId)).toContain(aCtl.rumor.id);
    expect(hook.map((e) => e.rumorId), "the joining sweep must receive the shared result").toContain(
      aCtl.rumor.id,
    );
  });

  it("different planes of the same community are NOT deduped against each other", async () => {
    const owner = signer();
    const community = communityOf(64, owner.pubkey);
    const now = Math.floor(Date.now() / 1000);
    const ctl = await wrapAt(controlGroupKey(community.root, community.id, 0), owner, "ab".repeat(32), now - 100);
    const gb = await wrapAt(guestbookGroupKey(community.root, community.id, 0), owner, "cd".repeat(32), now - 90);

    const relay = new FakeRelay();
    relay.events = [ctl.wrap, gb.wrap];
    relay.delayMs = 100;
    const nostr = poolOf({ [RELAY_A]: relay });

    const [c, g] = await Promise.all([
      sweepControl(nostr, community),
      sweepGuestbook(nostr, community),
    ]);

    expect(c.map((e) => e.rumorId)).toContain(ctl.rumor.id);
    expect(g.map((e) => e.rumorId)).toContain(gb.rumor.id);
  });

  it("sequential sweeps advance the per-relay cursor (the second asks `since`, not full history)", async () => {
    const owner = signer();
    const community = communityOf(68, owner.pubkey);
    const control = controlGroupKey(community.root, community.id, 0);
    const now = Math.floor(Date.now() / 1000);
    const e1 = await wrapAt(control, owner, "ab".repeat(32), now - 100);

    const relay = new FakeRelay();
    relay.events = [e1.wrap];
    const nostr = poolOf({ [RELAY_A]: relay });

    await sweepControl(nostr, community);
    await sweepControl(nostr, community);

    expect(relay.calls.length).toBe(2);
    expect(relay.calls[0][0].since, "first sweep is a full read").toBeUndefined();
    expect(relay.calls[1][0].since, "second sweep must be cursor-gated").toBe(e1.wrap.created_at);
  });
});
