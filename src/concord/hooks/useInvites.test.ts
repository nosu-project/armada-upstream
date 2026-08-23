// @vitest-environment jsdom
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
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  fetchInviteList,
  inviteListRelays,
  publishInviteListEvent,
  readPersistedInviteList,
  updateInviteList,
  useInviteList,
} from "@/concord/hooks/useInvites";
import type { InviteList } from "@/concord/lib/invite";
import { STOCK_RELAYS } from "@/concord/lib/invite";
import { KIND_INVITE_LIST } from "@/concord/lib/kinds";

import type { NUser } from "@nostrify/react/login";

/** Swappable per test; read at call time by the two hook mocks below. */
const mocks = vi.hoisted(() => ({
  nostr: { query: async () => [] } as { query: () => Promise<unknown[]> },
  user: undefined as unknown,
  folded: new Map<string, unknown>(),
}));

vi.mock("@nostrify/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@nostrify/react")>()),
  useNostr: () => ({
    nostr: {
      ...mocks.nostr,
      relay: (mocks.nostr as { relay?: unknown }).relay ?? (() => ({
        query: (...args: unknown[]) => (mocks.nostr.query as (...args: unknown[]) => Promise<unknown[]>)(...args),
      })),
    },
  }),
}));

vi.mock("@/hooks/useCurrentUser", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useCurrentUser")>()),
  useCurrentUser: () => ({ user: mocks.user }),
}));
vi.mock("@/hooks/useAppContext", () => ({
  useAppContext: () => ({
    config: {
      useAppRelays: false,
      appRelays: [],
      useUserRelays: false,
      relayMetadata: { relays: [], updatedAt: 0 },
    },
  }),
}));
vi.mock("@/lib/foldedCache", () => ({
  readFolded: async (key: string) => mocks.folded.get(key),
  writeFolded: async (key: string, value: unknown) => { mocks.folded.set(key, value); },
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

beforeEach(() => {
  mocks.folded.clear();
});

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

describe("creator invite list relay routing", () => {
  it("uses the self-state set plus every fixed CORD rescue relay", () => {
    const targets = inviteListRelays(["wss://self.example"]);
    expect(targets).toContain("wss://self.example");
    for (const relay of STOCK_RELAYS) expect(targets).toContain(relay);
  });

  it("fans exact bytes independently and reports a partial miss for durable retry", async () => {
    const { sk } = fakeUser();
    const wire = listCopy(sk, { entries: [], tombstones: [] }, 1000);
    const calls: Array<{ url: string; event: NostrEvent }> = [];
    const nostr = {
      relay: (url: string) => ({
        event: async (event: NostrEvent) => {
          calls.push({ url, event });
          if (url === "wss://two.example") throw new Error("offline");
        },
      }),
    };

    const result = await publishInviteListEvent(
      nostr as never,
      wire,
      ["wss://one.example", "wss://two.example"],
    );

    expect(result.accepted).toEqual(["wss://one.example"]);
    expect(result.rejected).toEqual(["wss://two.example"]);
    expect(calls).toEqual([
      { url: "wss://one.example", event: wire },
      { url: "wss://two.example", event: wire },
    ]);
  });

  it("queues a merged rewrite only for relays that completed its base read", async () => {
    const { sk, user } = fakeUser();
    user.signer.signEvent = async (template) => finalizeEvent(template, sk);
    const unavailable = STOCK_RELAYS[0]!;
    const delivered: string[] = [];
    const nostr = {
      relay: (url: string) => ({
        query: async () => {
          if (url === unavailable) throw new Error("offline");
          return [];
        },
        event: async () => { delivered.push(url); },
      }),
    };
    const queryClient = new QueryClient();
    const patch: InviteList = {
      entries: [entry("0a".repeat(16), "cd".repeat(32))],
      tombstones: [],
    };

    await updateInviteList(
      nostr as never,
      user,
      queryClient,
      ["wss://self.example"],
      patch,
    );

    expect(delivered).toContain("wss://self.example");
    expect(delivered).not.toContain(unavailable);
  });

  it("durably keeps a minted signer secret when every source read is offline", async () => {
    const { user } = fakeUser();
    const patch: InviteList = {
      entries: [entry("0c".repeat(16), "ce".repeat(32))],
      tombstones: [],
    };
    const nostr = {
      relay: () => ({
        query: async () => { throw new Error("offline"); },
        event: vi.fn(),
      }),
    };

    await expect(updateInviteList(
      nostr as never,
      user,
      new QueryClient(),
      ["wss://self.example"],
      patch,
    )).rejects.toThrow(/account-state relay/i);

    // Simulate a fresh query cache after reload: the folded record alone still
    // carries the link-signing secret needed to revoke/refresh the URL.
    const reloaded = await readPersistedInviteList(user.pubkey);
    expect(reloaded?.list.entries[0]).toMatchObject({
      token: "0c".repeat(16),
      signer_sk: "aa".repeat(32),
    });
  });

  it("refuses RMW when the newest visible 13303 is unreadable", async () => {
    const { sk, user } = fakeUser();
    const older = listCopy(sk, {
      entries: [entry("0a".repeat(16), "cf".repeat(32))],
      tombstones: [],
    }, 100);
    const unreadableHead = finalizeEvent({
      kind: KIND_INVITE_LIST,
      content: "not-our-ciphertext",
      tags: [],
      created_at: 101,
    }, sk);
    const relayEvent = vi.fn();
    const nostr = {
      relay: () => ({
        query: async () => [older, unreadableHead],
        event: relayEvent,
      }),
    };

    await expect(updateInviteList(
      nostr as never,
      user,
      new QueryClient(),
      ["wss://self.example"],
      { entries: [], tombstones: [] },
    )).rejects.toThrow(/current creator invite list/i);
    expect(relayEvent).not.toHaveBeenCalled();
  });

  it("does not let an unreadable older loser permanently block a readable head", async () => {
    const { sk, user } = fakeUser();
    user.signer.signEvent = async (template) => finalizeEvent(template, sk);
    const unreadableOlder = finalizeEvent({
      kind: KIND_INVITE_LIST,
      content: "not-our-ciphertext",
      tags: [],
      created_at: 100,
    }, sk);
    const readableHead = listCopy(sk, {
      entries: [entry("0a".repeat(16), "cf".repeat(32))],
      tombstones: [],
    }, 101);
    const relayEvent = vi.fn(async () => undefined);
    const nostr = {
      relay: () => ({
        query: async () => [unreadableOlder, readableHead],
        event: relayEvent,
      }),
    };

    await expect(updateInviteList(
      nostr as never,
      user,
      new QueryClient(),
      ["wss://self.example"],
      { entries: [], tombstones: [] },
    )).resolves.toMatchObject({
      entries: [expect.objectContaining({ token: "0a".repeat(16) })],
    });
    expect(relayEvent).toHaveBeenCalled();
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

  it("automatically publishes a durable offline invite patch after a later successful read", async () => {
    const { sk, user } = fakeUser();
    user.signer.signEvent = async (template) => finalizeEvent(template, sk);
    mocks.user = user;
    const local: InviteList = {
      entries: [entry(token, cid)],
      tombstones: [],
    };
    mocks.folded.set(`concord2-invite-list:${user.pubkey}`, {
      list: local,
      newestCreatedAt: 100,
      needsPublish: true,
    });
    const remote = listCopy(sk, { entries: [], tombstones: [] }, 101);
    const published: NostrEvent[] = [];
    mocks.nostr = {
      query: async () => [remote],
      relay: () => ({
        query: async () => [remote],
        event: async (wireEvent: NostrEvent) => { published.push(wireEvent); },
      }),
    } as never;

    const { wrapper } = harness();
    const { result } = renderHook(() => useInviteList(), { wrapper });

    await waitFor(() => expect(result.current.data?.entries).toHaveLength(1));
    await waitFor(() => expect(published.length).toBeGreaterThan(0));
    expect(await readPersistedInviteList(user.pubkey)).toMatchObject({
      list: local,
      newestCreatedAt: expect.any(Number),
    });
    expect((await readPersistedInviteList(user.pubkey))?.needsPublish).toBeUndefined();
  });

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
