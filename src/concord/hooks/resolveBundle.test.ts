/**
 * resolveBundle — the invite-bundle fetch the Discover cards and every join
 * ride on (CORD-05 §2/§4).
 *
 * Covers the latency-shaping behaviors added for Discover:
 * - a relay that never answers can't hold the resolve once another relay has
 *   produced a valid copy (the straggler grace window);
 * - the blocking home-relay second hop still adopts a newer copy;
 * - with `onSecondHop`, the first-hop bundle returns immediately and the
 *   newer copy (or a revocation) arrives through the callback instead.
 */
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveBundle } from "./useCommunityActions";
import { bytesToHex, random32 } from "@/concord/lib/derive";
import { mintCommunity } from "@/concord/lib/community";
import {
  buildBundleEvent,
  buildRevocationEvent,
  mintLinkSigner,
  mintToken,
  type InviteBundle,
  type ParsedInviteLink,
} from "@/concord/lib/invite";

import type { NostrEvent } from "@nostrify/nostrify";

const BOOT = "wss://boot.test";
const HOME = "wss://home.test";

/** One relay: answers `query` with its fixed events (or never, when hung). */
class FakeRelay {
  constructor(public events: NostrEvent[] = [], public hung = false) {}
  query(): Promise<NostrEvent[]> {
    if (this.hung) return new Promise<NostrEvent[]>(() => undefined);
    return Promise.resolve(this.events);
  }
}

function makePool(relays: Record<string, FakeRelay>) {
  return {
    relay: (url: string) => relays[url] ?? new FakeRelay(),
  } as unknown as Parameters<typeof resolveBundle>[0];
}

/** A link + two bundle generations at its coordinate (the newer renamed). */
function setup() {
  const owner = getPublicKey(generateSecretKey());
  const { community } = mintCommunity("Fleet", owner, [HOME]);
  const link = mintLinkSigner();
  const token = mintToken();
  const bundle: InviteBundle = {
    community_id: community.idHex,
    owner: community.owner,
    owner_salt: bytesToHex(community.ownerSalt),
    community_root: bytesToHex(random32()),
    root_epoch: 0,
    channels: [],
    relays: [HOME],
    name: "Old",
  };
  // Two generations with distinct timestamps, then back to real time (the
  // straggler grace runs on real setTimeout).
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
  const oldEvent = buildBundleEvent(bundle, token, link.sk);
  vi.setSystemTime(1_700_000_600_000);
  const freshEvent = buildBundleEvent({ ...bundle, name: "Fresh" }, token, link.sk);
  const tombstone = buildRevocationEvent(link.sk);
  vi.useRealTimers();

  const invite: ParsedInviteLink = {
    linkSigner: link.pk,
    token,
    bootstrapRelays: [BOOT],
    naddr: "naddr1test",
  };
  return { invite, oldEvent, freshEvent, tombstone };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("resolveBundle", () => {
  it("settles shortly after the first valid copy even when another relay hangs", async () => {
    const { invite, freshEvent } = setup();
    const pool = makePool({
      [BOOT]: new FakeRelay([freshEvent]),
      "wss://dead.test": new FakeRelay([], true),
      [HOME]: new FakeRelay([freshEvent]),
    });

    const started = performance.now();
    const bundle = await resolveBundle(
      pool,
      { ...invite, bootstrapRelays: [BOOT, "wss://dead.test"] },
      [],
    );
    // Well under the 8s per-relay timeout the hung relay would otherwise cost
    // (two hops of grace at most; generous bound for slow CI).
    expect(performance.now() - started).toBeLessThan(4000);
    expect(bundle.name).toBe("Fresh");
  });

  it("blocking mode adopts the newer copy the home relays vend", async () => {
    const { invite, oldEvent, freshEvent } = setup();
    const pool = makePool({
      [BOOT]: new FakeRelay([oldEvent]),
      [HOME]: new FakeRelay([freshEvent]),
    });

    const bundle = await resolveBundle(pool, invite, []);
    expect(bundle.name).toBe("Fresh");
  });

  it("onSecondHop returns the first-hop bundle now and the newer copy via the callback", async () => {
    const { invite, oldEvent, freshEvent } = setup();
    const pool = makePool({
      [BOOT]: new FakeRelay([oldEvent]),
      [HOME]: new FakeRelay([freshEvent]),
    });

    const onSecondHop = vi.fn();
    const bundle = await resolveBundle(pool, invite, [], { onSecondHop });
    expect(bundle.name).toBe("Old");
    await vi.waitFor(() =>
      expect(onSecondHop).toHaveBeenCalledWith({ bundle: expect.objectContaining({ name: "Fresh" }) }),
    );
  });

  it("onSecondHop reports a newer revocation tombstone, and the floor makes it stick", async () => {
    const { invite, oldEvent, tombstone } = setup();
    const pool = makePool({
      [BOOT]: new FakeRelay([oldEvent]),
      [HOME]: new FakeRelay([tombstone]),
    });

    const onSecondHop = vi.fn();
    const bundle = await resolveBundle(pool, invite, [], { onSecondHop });
    expect(bundle.name).toBe("Old"); // the first hop had a live copy
    await vi.waitFor(() => expect(onSecondHop).toHaveBeenCalledWith({ revoked: true }));

    // The tombstone is now the persisted floor: the next resolve terminates
    // even if every relay serves only the stale live copy.
    await expect(resolveBundle(pool, invite, [])).rejects.toMatchObject({ code: "revoked" });
  });
});
