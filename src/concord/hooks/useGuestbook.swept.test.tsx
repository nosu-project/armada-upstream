/**
 * `swept` — whether this guestbook has been read over the NETWORK — as opposed
 * to the query's own `isLoading`/`isFetching`, which cover the STORE read the
 * sweep runs behind (see useGuestbook.liveKick.test.tsx for why they are
 * separate in the first place).
 *
 * The distinction is the invite preview's member count. That screen describes a
 * community the viewer is NOT in, so `queryPlane` answers with nothing and the
 * query settles on an empty guestbook within a tick of mount — seconds before
 * the sweep that will actually produce the members. Gated on `isLoading`, the
 * consent surface therefore read "0 members" for the whole of that window: not
 * merely an early number but a false one, about the very room the user is
 * deciding whether to join.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { EventTemplate, NostrEvent } from "nostr-tools/pure";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReactNode } from "react";

import { bytesToHex, guestbookGroupKey } from "@/concord/lib/derive";
import { buildJoinRumor, sealGuestbook } from "@/concord/lib/guestbook";
import type { Community } from "@/concord/lib/types";
import {
  _configureAuthWaitForTests,
  _resetPlaneSweepMemoForTests,
} from "@/concord/lib/planeSync";

import { useGuestbook } from "./useGuestbook";

// ── Module mocks ─────────────────────────────────────────────────────────────

/** The sweep's one relay read, held open until the test answers it. */
let answerSweep: ((events: NostrEvent[]) => void) | undefined;

const nostr = {
  relay: () => ({
    query: async (_filters: unknown, opts?: { signal?: AbortSignal }): Promise<NostrEvent[]> =>
      new Promise<NostrEvent[]>((resolve) => {
        answerSweep = resolve;
        opts?.signal?.addEventListener("abort", () => resolve([]), { once: true });
      }),
    // eslint-disable-next-line require-yield
    async *req() {
      return;
    },
    event: async () => undefined,
  }),
};

vi.mock("@nostrify/react", () => ({ useNostr: () => ({ nostr }) }));
vi.mock("@/concord/hooks/useControlPlane", () => ({
  useControlFold: () => ({ data: undefined }),
  useDissolved: () => ({ data: undefined }),
}));

// ── Fixtures ─────────────────────────────────────────────────────────────────

const root = new Uint8Array(32).fill(7);

function signer(sk = generateSecretKey()) {
  return { sk, pubkey: getPublicKey(sk), signEvent: async (t: EventTemplate) => finalizeEvent(t, sk) };
}

function communityOf(fill: number, owner: string): Community {
  const id = new Uint8Array(32).fill(fill);
  return {
    id,
    idHex: bytesToHex(id),
    owner,
    ownerSalt: new Uint8Array(32),
    root,
    rootEpoch: 0n,
    heldRoots: [{ epoch: 0n, key: root }],
    privateChannels: [],
    relays: ["wss://relay.test"],
    name: "test",
  } as unknown as Community;
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  _configureAuthWaitForTests({ maxWaitMs: 0 });
  _resetPlaneSweepMemoForTests();
  answerSweep = undefined;
});

// ── Test ─────────────────────────────────────────────────────────────────────

describe("useGuestbook swept", () => {
  it("stays unswept while the sweep is out, though the store read has settled", async () => {
    const owner = signer();
    const member = signer();
    // A fill of its own: `swept` is deliberately sticky per (community, epoch)
    // for the session, so a community another test has already swept would
    // start out answered.
    const community = communityOf(221, owner.pubkey);

    const gb = guestbookGroupKey(community.root, community.id, 0);
    const joinWrap = (await sealGuestbook(
      buildJoinRumor(member.pubkey, Date.now()),
      gb,
      member,
    )) as NostrEvent;

    const { result } = renderHook(() => useGuestbook(community), { wrapper });

    // The store read settles promptly and finds nobody — this community has
    // never been joined, so nothing of its guestbook is on disk.
    await waitFor(() => expect(result.current.isFetching).toBe(false));
    expect(result.current.coalesced.size).toBe(0);
    // …which is not an answer about the room. The sweep that will produce the
    // members is still out, and this is the flag that says so.
    expect(result.current.swept).toBe(false);

    // The relay answers with one Join: the member and the flag land together,
    // so nothing ever renders a settled count of zero.
    await waitFor(() => expect(answerSweep).toBeDefined());
    answerSweep!([joinWrap]);
    await waitFor(() => expect(result.current.swept).toBe(true));
    expect(result.current.coalesced.get(member.pubkey)?.state).toBe("join");
  });

  it("settles a sweep that answers nothing, so the wait is bounded", async () => {
    // The flag is SETTLED, not succeeded. A community whose guestbook really is
    // empty — or whose relays all failed — must stop the caller waiting, or the
    // spinner it gates never comes down. Telling those two apart is what stops
    // the caller printing a number for either.
    const owner = signer();
    const community = communityOf(222, owner.pubkey);

    const { result } = renderHook(() => useGuestbook(community), { wrapper });

    await waitFor(() => expect(answerSweep).toBeDefined());
    answerSweep!([]);
    await waitFor(() => expect(result.current.swept).toBe(true));
    expect(result.current.coalesced.size).toBe(0);
  });
});
