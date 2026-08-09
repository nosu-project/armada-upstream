/**
 * The Invite List read (CORD-05 §4). The spec's merge law — entries immutable,
 * tombstones union, a tombstone beats an entry TERMINALLY — is what makes a
 * read safe against a stale copy: a 13303 that predates another device's
 * revocation must never let the revoked link resurface (it would get refreshed
 * with fresh keys after a Refounding otherwise).
 *
 * Two layers, because they fail differently. `fetchInviteList` merges every
 * copy IT is handed; but `NPool.query` collects into an `NSet`, which applies
 * replaceable semantics of its own and hands it at most ONE 13303 — so the
 * function's merge cannot see a copy the pool already dropped, and a pool
 * answered only by relays that haven't indexed our latest write returns a list
 * that is simply behind. `useInviteList` is the layer that has to survive
 * that, by merging the read into the cache rather than assigning over it.
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getConversationKey } from "nostr-tools/nip44";
import { encrypt as nip44Encrypt } from "nostr-tools/nip44";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { NostrEvent } from "nostr-tools/pure";
import { createElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { fetchInviteList, useInviteList } from "@/concord/hooks/useInvites";
import type { InviteList } from "@/concord/lib/invite";
import { KIND_INVITE_LIST } from "@/concord/lib/kinds";

import type { NUser } from "@nostrify/react/login";

/** Swappable per test; read at call time by the two hook mocks below. */
const mocks = vi.hoisted(() => ({
  nostr: { query: async () => [] } as { query: () => Promise<unknown[]> },
  user: undefined as unknown,
}));

vi.mock("@nostrify/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@nostrify/react")>()),
  useNostr: () => ({ nostr: mocks.nostr }),
}));

vi.mock("@/hooks/useCurrentUser", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useCurrentUser")>()),
  useCurrentUser: () => ({ user: mocks.user }),
}));



function fakeUser(sk = generateSecretKey()) {
  const pubkey = getPublicKey(sk);
  const conv = (pk: string) => getConversationKey(sk, pk);
  return {
    sk,
    user: {
      pubkey,
      signer: {
        signEvent: async () => {
          throw new Error("unused");
        },
        nip44: {
          encrypt: async (pk: string, pt: string) => nip44Encrypt(pt, conv(pk)),
          decrypt: async (pk: string, ct: string) => {
            const { decrypt } = await import("nostr-tools/nip44");
            return decrypt(ct, conv(pk));
          },
        },
      },
    } as unknown as NUser,
  };
}

/** A kind-13303 replaceable copy, NIP-44-encrypted to self, at `createdAt`. */
function listCopy(sk: Uint8Array, list: InviteList, createdAt: number): NostrEvent {
  const pubkey = getPublicKey(sk);
  const content = nip44Encrypt(JSON.stringify(list), getConversationKey(sk, pubkey));
  return finalizeEvent({ kind: KIND_INVITE_LIST, content, tags: [], created_at: createdAt }, sk);
}

const entry = (token: string, communityId: string) => ({
  token,
  signer_sk: "aa".repeat(32),
  community_id: communityId,
  url: "https://example.com/invite/naddr1xyz#frag",
  created_at: 1000,
});

function poolReturning(events: NostrEvent[]) {
  return { query: async () => events } as unknown as Parameters<typeof fetchInviteList>[0];
}

describe("fetchInviteList (CORD-05 §4 merge on read)", () => {
  const cid = "cd".repeat(32);

  it("merges every returned copy: a tombstone in an OLDER copy still kills the entry a NEWER copy carries live", async () => {
    const { sk, user } = fakeUser();
    // Device 1 revoked link B at t=1000. Device 2, offline since before the
    // revocation, wrote its own copy at t=2000 with B still live. Newest-only
    // reading would resurrect B; the merge must not.
    const older = listCopy(
      sk,
      { entries: [entry("0a".repeat(16), cid)], tombstones: [{ token: "0b".repeat(16), community_id: cid }] },
      1000,
    );
    const newer = listCopy(
      sk,
      { entries: [entry("0a".repeat(16), cid), entry("0b".repeat(16), cid)], tombstones: [] },
      2000,
    );

    const { list, newestCreatedAt } = await fetchInviteList(poolReturning([newer, older]), user);

    expect(list.entries.map((e) => e.token)).toEqual(["0a".repeat(16)]); // B is gone, terminally
    expect(list.tombstones.map((t) => t.token)).toEqual(["0b".repeat(16)]); // and stays tombstoned
    expect(newestCreatedAt).toBe(2000); // replaceable-write monotonicity anchor
  });

  it("unions entries across copies (two devices' mints both survive)", async () => {
    const { sk, user } = fakeUser();
    const device1 = listCopy(sk, { entries: [entry("0a".repeat(16), cid)], tombstones: [] }, 1000);
    const device2 = listCopy(sk, { entries: [entry("0b".repeat(16), cid)], tombstones: [] }, 1001);

    const { list } = await fetchInviteList(poolReturning([device1, device2]), user);
    expect(list.entries.map((e) => e.token).sort()).toEqual(["0a".repeat(16), "0b".repeat(16)]);
  });

  it("an undecryptable copy is skipped for content but still anchors write monotonicity", async () => {
    const { sk, user } = fakeUser();
    const good = listCopy(sk, { entries: [entry("0a".repeat(16), cid)], tombstones: [] }, 1000);
    const garbage = { ...listCopy(sk, { entries: [], tombstones: [] }, 2000), content: "not-nip44" };

    const { list, newestCreatedAt } = await fetchInviteList(poolReturning([garbage, good]), user);
    expect(list.entries.map((e) => e.token)).toEqual(["0a".repeat(16)]);
    // A relay keeps only the newest replaceable per author — a rewrite must
    // outbid the garbage copy sitting there, or it would be shadowed forever.
    expect(newestCreatedAt).toBe(2000);
  });
});

describe("useInviteList (a network read may only widen the local list)", () => {
  const cid = "ce".repeat(32);
  const token = "0a".repeat(16);

  function harness() {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);
    return { queryClient, wrapper };
  }

  it("keeps a locally tombstoned entry when the pool still answers from the pre-revocation copy", async () => {
    const { sk, user } = fakeUser();
    mocks.user = user;
    // Every relay that answers inside the pool's ~300ms EOSE window is still
    // serving the list as it was BEFORE the revoke — the link live, no
    // tombstone. This is the ordinary case right after a write, not a fault.
    mocks.nostr = {
      query: async () => [listCopy(sk, { entries: [entry(token, cid)], tombstones: [] }, 1000)],
    };

    const { queryClient, wrapper } = harness();
    // What `revokeLink`'s optimistic write leaves in the cache.
    queryClient.setQueryData(["concord", "invite-list", user.pubkey], {
      entries: [],
      tombstones: [{ token, community_id: cid }],
    } satisfies InviteList);

    const { result } = renderHook(() => useInviteList(), { wrapper });

    // Publishing the 13303 echoes it back on the self-sync sub, which
    // invalidates this query — the refetch that used to resurrect the link.
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["concord", "invite-list"] });
    });
    await waitFor(() => expect(result.current.isFetching).toBe(false));

    expect(result.current.data?.entries).toEqual([]);
    expect(result.current.data?.tombstones.map((t) => t.token)).toEqual([token]);
  });

  it("still adopts what the read adds (a mint from another device)", async () => {
    const { sk, user } = fakeUser();
    mocks.user = user;
    const other = "0b".repeat(16);
    mocks.nostr = {
      query: async () => [listCopy(sk, { entries: [entry(other, cid)], tombstones: [] }, 2000)],
    };

    const { queryClient, wrapper } = harness();
    queryClient.setQueryData(["concord", "invite-list", user.pubkey], {
      entries: [entry(token, cid)],
      tombstones: [],
    } satisfies InviteList);

    const { result } = renderHook(() => useInviteList(), { wrapper });
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["concord", "invite-list"] });
    });
    await waitFor(() => expect(result.current.isFetching).toBe(false));

    expect(result.current.data?.entries.map((e) => e.token).sort()).toEqual([token, other].sort());
  });
});
