/**
 * Bug report: "I joined one server & every time the app closes the server's
 * gone like I never joined it."
 *
 * Joining from Discover routes to the invite page, whose Accept calls
 * `join({ invite, bundle })` WITH the preview's bundle — the optimistic path.
 * That path records a pending entry (pendingJoins.ts) and answers at once; the
 * page toasts "Joined" and opens the community. The membership records — the
 * folded list in KV and the kind-33302 vault — are written only at the END of
 * a background chain of relay round trips (bundle re-resolve, dissolution
 * probe, ban check, fragment read, fragment publish). The pending entry used
 * to live in memory only, so closing the app inside that chain lost the join.
 *
 * This drives the real hooks: a join whose background chain has not finished
 * when the app is closed (relays slow to answer), then a cold start from what
 * is on disk. A community the user was told they joined must still be there —
 * the pending join is persisted at click time and resumed on the next launch.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ReactNode } from "react";

import type { NUser } from "@nostrify/react/login";

const SELF = "ab".repeat(32);
const OWNER = "86184109eae937d8d6f980b4a0b46da4ef0d983eade403ee1b4c0b6bde238b47";
const LINK_SIGNER = "cd".repeat(32);

type Relay = {
  query: (...args: unknown[]) => Promise<unknown[]>;
  event: (...args: unknown[]) => Promise<unknown>;
};

/** A relay that is slow: it hasn't answered by the time the user closes the app. */
const pendingRelay: Relay = {
  query: () => new Promise(() => undefined),
  event: () => new Promise(() => undefined),
};
/** A relay that answers promptly and holds nothing (nothing was ever published). */
const emptyRelay: Relay = {
  query: async () => [],
  event: async () => undefined,
};

const h = vi.hoisted(() => ({
  relay: undefined as unknown as { query: (...a: unknown[]) => Promise<unknown[]>; event: (...a: unknown[]) => Promise<unknown> },
  user: undefined as unknown,
  store: Promise.resolve({ query: async () => [], event: async () => undefined }),
}));

vi.mock("@nostrify/react", () => ({
  useNostr: () => ({
    nostr: {
      relay: () => h.relay,
      query: (...a: unknown[]) => h.relay.query(...a),
      event: (...a: unknown[]) => h.relay.event(...a),
      group: () => h.relay,
    },
  }),
}));
vi.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ user: h.user }),
}));
vi.mock("@/hooks/useAppContext", () => ({
  useAppContext: () => ({ config: { appRelays: ["wss://relay.test"], communityRelays: [] } }),
}));
vi.mock("@/contexts/AppContext", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  selfStateRelays: () => ["wss://self.example"],
}));
vi.mock("@/hooks/useEventStore", () => ({
  useEventStore: () => h.store,
}));
vi.mock("@/hooks/useRemoveRailKey", () => ({
  useRemoveRailKey: () => () => undefined,
}));

/** Reversible fake NIP-44 + signer. */
h.user = {
  pubkey: SELF,
  signer: {
    nip44: {
      encrypt: async (_pk: string, plaintext: string) => `enc:${plaintext}`,
      decrypt: async (_pk: string, ciphertext: string) => ciphertext.slice(4),
    },
    signEvent: async (t: Record<string, unknown>) => ({ ...t, id: "e".repeat(64), pubkey: SELF, sig: "f".repeat(128) }),
  },
} as unknown as NUser;

function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

afterEach(() => {
  vi.resetModules();
});

describe("a Concord community joined from Discover", () => {
  it("is still on the rail after the app is closed and reopened", { timeout: 30000 }, async () => {
    // ── Session 1: the user taps Join on the invite page ──────────────────
    h.relay = pendingRelay;
    const { mintCommunity } = await import("@/concord/lib/community");
    const { toJoinMaterial } = await import("@/concord/lib/communityList");
    const { bundleNaddr } = await import("@/concord/lib/invite");
    const { useCommunityActions } = await import("@/concord/hooks/useCommunityActions");
    const { useLiveCommunities } = await import("@/concord/hooks/useCommunityList");

    const { community } = mintCommunity("Fleet", OWNER, ["wss://home.example"]);
    const jm = toJoinMaterial(community, { relays: community.relays });
    const bundle = { ...jm, channels: [], relays: community.relays, name: "Fleet" };
    const invite = {
      linkSigner: LINK_SIGNER,
      token: new Uint8Array(16).fill(7),
      bootstrapRelays: ["wss://bootstrap.example"],
      naddr: bundleNaddr(LINK_SIGNER),
    };

    const session1 = renderHook(
      () => ({ actions: useCommunityActions(), live: useLiveCommunities() }),
      { wrapper: wrapperFor(new QueryClient({ defaultOptions: { queries: { retry: false } } })) },
    );
    const joined = await session1.result.current.actions.join({ invite, bundle });
    expect(joined.communityId).toBe(jm.community_id);

    // The UI now says "Joined" and the rail shows the community.
    await waitFor(() =>
      expect(session1.result.current.live.map((e) => e.community_id)).toContain(jm.community_id),
    );

    // The user browses for a moment, then closes the app.
    await new Promise((r) => setTimeout(r, 250));
    session1.unmount();
    vi.resetModules(); // process death: every module-level memory is gone

    // ── Session 2: cold start from what is on disk ────────────────────────
    h.relay = emptyRelay;
    const fresh = await import("@/concord/hooks/useCommunityList");
    const session2 = renderHook(() => fresh.useLiveCommunities(), {
      wrapper: wrapperFor(new QueryClient({ defaultOptions: { queries: { retry: false } } })),
    });
    const listQuery = renderHook(() => fresh.useCommunityList(), {
      wrapper: wrapperFor(new QueryClient({ defaultOptions: { queries: { retry: false } } })),
    });
    await waitFor(() => expect(listQuery.result.current.isFetched).toBe(true));

    // Also inspect the durable record directly. The join's chain never reached
    // the vault write, so it is the persisted pending join — not the folded
    // list, which only ever holds what the ban check has let through.
    const { readFolded } = await import("@/lib/foldedCache");
    const { pendingJoinsKey } = await import("@/concord/lib/pendingJoins");
    const persisted = await readFolded<Array<{ community_id: string }>>(pendingJoinsKey(SELF));

    expect(persisted?.map((e) => e.community_id) ?? []).toContain(jm.community_id);
    await waitFor(() =>
      expect(session2.result.current.map((e) => e.community_id)).toContain(jm.community_id),
    );
  });

  // Control: the restart harness does see a membership once the durable list
  // write has completed, so the failure above is the join's, not the harness's.
  it("control: survives the restart when the vault write completed before close", async () => {
    h.relay = emptyRelay;
    const { mintCommunity } = await import("@/concord/lib/community");
    const { toJoinMaterial } = await import("@/concord/lib/communityList");
    const { useUpdateCommunityList } = await import("@/concord/hooks/useCommunityList");

    const { community } = mintCommunity("Harbor", OWNER, ["wss://home.example"]);
    const jm = toJoinMaterial(community, { relays: community.relays });

    const session1 = renderHook(() => useUpdateCommunityList(), {
      wrapper: wrapperFor(new QueryClient({ defaultOptions: { queries: { retry: false } } })),
    });
    await session1.result.current.mutateAsync({
      type: "add",
      entry: { community_id: jm.community_id, seed: jm, current: jm, added_at: Date.now() },
    });
    await new Promise((r) => setTimeout(r, 250)); // let the un-awaited folded write land
    session1.unmount();
    vi.resetModules();

    const fresh = await import("@/concord/hooks/useCommunityList");
    const session2 = renderHook(() => fresh.useLiveCommunities(), {
      wrapper: wrapperFor(new QueryClient({ defaultOptions: { queries: { retry: false } } })),
    });
    await waitFor(() =>
      expect(session2.result.current.map((e) => e.community_id)).toContain(jm.community_id),
    );
  });
});
