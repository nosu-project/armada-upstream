/**
 * "Leave community" — how long the button stays disabled, and when the
 * community actually leaves the local list.
 *
 * Bug report: the Leave button stays grayed out after clicking it, the
 * community doesn't leave (and is back after an app restart), and it finally
 * went through about an hour later. Another user reported ~10s.
 *
 * This file drives the REAL `useCommunityManagement().leave` through the REAL
 * `useGuestbookPublisher` and `useUpdateCommunityList` (its read-modify-write,
 * its `concord-list` mutation scope, its fragment publish) against a relay pool
 * mock. Only storage, config and the control plane are stubbed. Each test
 * expects what a user would: the community leaves the local list promptly, no
 * matter what one slow relay, a flaky `navigator.onLine` or another list write
 * is doing.
 */

import { NSecSigner } from "@nostrify/nostrify";
import { onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ReactNode } from "react";

import { mintCommunity } from "@/concord/lib/community";
import { addToList, EMPTY_COMMUNITY_LIST, isLive, type JoinMaterial } from "@/concord/lib/communityList";
import { bytesToHex } from "@/concord/lib/derive";
import { STOCK_RELAYS } from "@/concord/lib/stockRelays";
import type { Community } from "@/concord/lib/types";
import { abortSignalTimeout } from "@/lib/abortSignalPolyfill";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

// ── Module mocks ─────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({
  nostr: undefined as unknown,
  user: undefined as unknown,
  folded: new Map<string, unknown>(),
}));

vi.mock("@nostrify/react", () => ({ useNostr: () => ({ nostr: h.nostr }) }));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: h.user }) }));
vi.mock("@/hooks/useAppContext", () => ({
  useAppContext: () => ({ config: { appRelays: [] }, updateConfig: () => undefined }),
}));
vi.mock("@/contexts/AppContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/contexts/AppContext")>()),
  selfStateRelays: () => [SELF_RELAY],
}));
vi.mock("@/hooks/useEventStore", () => ({
  useEventStore: () => Promise.resolve({ query: async () => [] }),
}));
vi.mock("@/hooks/useRemoveRailKey", () => ({ useRemoveRailKey: () => () => undefined }));
vi.mock("@/hooks/useToast", () => ({ toast: () => undefined }));
vi.mock("@/lib/foldedCache", () => ({
  readFolded: async (key: string) => h.folded.get(key),
  writeFolded: async (key: string, value: unknown) => {
    h.folded.set(key, value);
  },
}));
vi.mock("@/lib/publishOutbox", () => ({
  queueSignedEvent: async () => undefined,
  recordQueuedPublishAttempt: async () => undefined,
}));
vi.mock("@/concord/lib/rumorStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/concord/lib/rumorStore")>()),
  writeOpened: async () => undefined,
}));
vi.mock("@/concord/hooks/useControlPlane", () => ({
  useControlFold: () => ({ data: undefined }),
  useDissolved: () => ({ data: undefined }),
  citationFor: () => undefined,
  invalidateControl: () => undefined,
  publishEdition: async () => undefined,
  markDissolvedLocally: async () => undefined,
  probeCommunityDissolved: async () => undefined,
}));

import { listQueryKey, useUpdateCommunityList, type ListData } from "./useCommunityList";
import { useCommunityManagement } from "./useCommunityActions";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const SELF_RELAY = "wss://self.test/";
const GOOD_RELAY = "wss://good.test/";
const DEAD_RELAY = "wss://dead.test/";

/** A relay call that never answers, but — like NRelay1 — honors its abort signal. */
function silent(signal?: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

interface Pool {
  /** Every relay URL an EVENT was sent to, in order. */
  sent: string[];
}

/**
 * A pool where `dead` relays never answer (EVENT or REQ) until the caller's
 * timeout aborts them, and every other relay answers at once — reads with an
 * empty vault, writes with OK.
 */
function pool(dead: Set<string>): Pool {
  const p: Pool = { sent: [] };
  h.nostr = {
    query: async () => [],
    relay: (url: string) => ({
      query: (_f: NostrFilter[], opts?: { signal?: AbortSignal }) =>
        dead.has(url) ? silent(opts?.signal) : Promise.resolve([]),
      event: (_e: NostrEvent, opts?: { signal?: AbortSignal }) => {
        p.sent.push(url);
        return dead.has(url) ? silent(opts?.signal) : Promise.resolve();
      },
    }),
  };
  return p;
}

function setup(communityRelays: string[]) {
  const sk = generateSecretKey();
  const pubkey = getPublicKey(sk);
  h.user = { pubkey, signer: new NSecSigner(sk) };
  const { community } = mintCommunity("Fleet", getPublicKey(generateSecretKey()), communityRelays);

  const material = {
    community_id: community.idHex,
    owner: community.owner,
    owner_salt: bytesToHex(community.ownerSalt),
    community_root: bytesToHex(community.root),
    root_epoch: 0,
    channels: [],
    relays: communityRelays,
    name: "Fleet",
  } as unknown as JoinMaterial;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, networkMode: "always" } },
  });
  client.setQueryData<ListData>(listQueryKey(pubkey), {
    event: null,
    list: addToList(EMPTY_COMMUNITY_LIST, {
      community_id: community.idHex,
      seed: material,
      current: material,
      added_at: 1_000,
    }),
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, community, pubkey, wrapper };
}

function liveInCache(client: QueryClient, pubkey: string, community: Community): boolean {
  const data = client.getQueryData<ListData>(listQueryKey(pubkey));
  return data ? isLive(data.list, community.idHex) : false;
}

function liveInFold(pubkey: string, community: Community): boolean | undefined {
  const persisted = h.folded.get(`concord2-list:${pubkey}`) as { list: ListData["list"] } | undefined;
  return persisted ? isLive(persisted.list, community.idHex) : undefined;
}

beforeEach(() => {
  h.folded = new Map();
  onlineManager.setOnline(true);
});

afterEach(() => {
  onlineManager.setOnline(true);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Leave community", () => {
  it("sanity: with every relay healthy, leave removes the community", async () => {
    pool(new Set());
    const { client, community, pubkey, wrapper } = setup([GOOD_RELAY]);
    const { result } = renderHook(() => useCommunityManagement(community), { wrapper });

    await act(() => result.current.leave());

    expect(liveInCache(client, pubkey, community)).toBe(false);
    expect(liveInFold(pubkey, community)).toBe(false);
  });

  it(
    "one unresponsive relay does not hold the button disabled and the community in the list",
    async () => {
      // Virtual clock: AbortSignal.timeout rides Node's internal timers, which
      // fake timers can't reach, so route it through the setTimeout polyfill.
      vi.useFakeTimers();
      vi.spyOn(AbortSignal, "timeout").mockImplementation(abortSignalTimeout);
      // One dead relay in the community's set AND one of the stock rescue
      // relays the vault RMW also reads/writes.
      pool(new Set([DEAD_RELAY, STOCK_RELAYS[0]!]));
      const { client, community, pubkey, wrapper } = setup([GOOD_RELAY, DEAD_RELAY]);
      const { result } = renderHook(() => useCommunityManagement(community), { wrapper });

      let settled = false;
      act(() => {
        void result.current.leave().finally(() => {
          settled = true;
        });
      });

      // Step the virtual clock and record when (a) the community left the
      // local list and (b) the mutation settled (the button re-enables).
      let removedAt: number | undefined;
      let elapsed = 0;
      while (!settled && elapsed < 120_000) {
        await act(() => vi.advanceTimersByTimeAsync(250));
        elapsed += 250;
        if (removedAt === undefined && !liveInCache(client, pubkey, community)) removedAt = elapsed;
      }
      console.info(
        `[leave/dead-relay] community left the list at ${removedAt ?? "never"} ms; ` +
          `leave() settled at ${settled ? elapsed : "never"} ms (virtual)`,
      );

      expect(settled, "leave() settled within 2 minutes of virtual time").toBe(true);
      // A user expects the community gone right away. Anything past a couple
      // of seconds is the "button stays grayed out" report.
      expect(removedAt, "community left the local list promptly").toBeLessThanOrEqual(2_000);
      expect(elapsed, "leave() re-enabled the button promptly").toBeLessThanOrEqual(2_000);
    },
    30_000,
  );

  it(
    "leaving while react-query believes the device is offline still leaves",
    async () => {
      const sent = pool(new Set());
      const { client, community, pubkey, wrapper } = setup([GOOD_RELAY]);
      const { result } = renderHook(() => useCommunityManagement(community), { wrapper });

      // What a WebView `offline` event does (network hand-off, Doze, a flaky
      // `navigator.onLine`). This client keeps react-query's default
      // `networkMode: "online"` for mutations, which App.tsx overrides — the
      // leave itself must not depend on that override.
      act(() => {
        window.dispatchEvent(new Event("offline"));
      });
      expect(onlineManager.isOnline()).toBe(false);

      act(() => {
        void result.current.leave().catch(() => undefined);
      });
      // Give it far longer than a healthy leave takes (the sanity test is ms).
      await new Promise((r) => setTimeout(r, 1_500));

      const paused = client.getMutationCache().getAll().filter((m) => m.state.isPaused).length;
      console.info(
        `[leave/offline] after 1.5s: isLeaving=${result.current.isLeaving}, paused mutations=${paused}, ` +
          `relay EVENTs sent=${sent.sent.length}`,
      );

      try {
        expect(result.current.isLeaving, "button no longer disabled").toBe(false);
        expect(liveInCache(client, pubkey, community), "community gone from the list").toBe(false);
        expect(liveInFold(pubkey, community), "leave persisted locally, so a restart keeps it").toBe(false);
      } finally {
        // Informational: the 'online' event is what finally lets it run —
        // the "it finally did it an hour later".
        act(() => {
          window.dispatchEvent(new Event("online"));
        });
        await waitFor(() => expect(liveInCache(client, pubkey, community)).toBe(false), { timeout: 5_000 });
      }
    },
    15_000,
  );

  it(
    "an earlier list write that is stuck on the signer does not hold the leave hostage",
    async () => {
      pool(new Set());
      const { client, community, pubkey, wrapper } = setup([GOOD_RELAY]);
      const signer = (h.user as { signer: NSecSigner }).signer;

      // Any other `concord-list` write already in flight — here one whose
      // signer call is waiting on a remote signer / signer app (in the app
      // each such op is bounded only by signerWithNudge's 65s hard timeout,
      // and a write makes several of them).
      let releaseSigner!: () => void;
      const gate = new Promise<void>((r) => {
        releaseSigner = r;
      });
      const realEncrypt = signer.nip44.encrypt.bind(signer.nip44);
      let firstEncrypt = true;
      vi.spyOn(signer.nip44, "encrypt").mockImplementation(async (pk, text) => {
        if (firstEncrypt) {
          firstEncrypt = false;
          await gate;
        }
        return realEncrypt(pk, text);
      });

      const { result } = renderHook(
        () => ({ manage: useCommunityManagement(community), list: useUpdateCommunityList() }),
        { wrapper },
      );
      act(() => {
        void result.current.list
          .mutateAsync({ type: "refresh-relays", communityId: community.idHex, relays: [GOOD_RELAY] })
          .catch(() => undefined);
      });
      await waitFor(() => expect(firstEncrypt).toBe(false));

      act(() => {
        void result.current.manage.leave().catch(() => undefined);
      });
      await new Promise((r) => setTimeout(r, 1_500));
      const leftWhileBlocked = !liveInCache(client, pubkey, community);
      const leavingWhileBlocked = result.current.manage.isLeaving;
      console.info(
        `[leave/scope] while the earlier list write is stuck: isLeaving=${leavingWhileBlocked}, ` +
          `community left list=${leftWhileBlocked}`,
      );

      releaseSigner();
      await waitFor(() => expect(result.current.manage.isLeaving).toBe(false), { timeout: 5_000 });

      expect(leavingWhileBlocked, "button not held disabled by an unrelated list write").toBe(false);
      expect(leftWhileBlocked, "community left the list without waiting for it").toBe(true);
    },
    15_000,
  );
});
