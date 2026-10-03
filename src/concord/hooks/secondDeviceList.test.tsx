/**
 * A second device whose signer can't decrypt the NIP-44 community list shows
 * no communities. `useCommunityList` reports `decryptFailed` with an empty
 * list, and the rail's `CommunityListLocked` notice says why.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, renderHook, screen, waitFor } from "@testing-library/react";
import { getConversationKey, decrypt as nip44Decrypt, encrypt as nip44Encrypt } from "nostr-tools/nip44";
import { matchFilters, type Filter } from "nostr-tools/filter";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { EventTemplate, NostrEvent } from "nostr-tools/pure";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ReactNode } from "react";

import type { NUser } from "@nostrify/react/login";

class FakeRelay {
  stored: NostrEvent[] = [];

  async query(filters: Filter[]): Promise<NostrEvent[]> {
    return this.stored.filter((ev) => matchFilters(filters, ev));
  }

  async event(ev: NostrEvent): Promise<void> {
    if (!this.stored.some((e) => e.id === ev.id)) this.stored.push(ev);
  }
}

const h = vi.hoisted(() => ({
  relays: new Map<string, unknown>(),
  user: undefined as unknown,
}));

function relayAt(url: string): FakeRelay {
  let relay = h.relays.get(url) as FakeRelay | undefined;
  if (!relay) {
    relay = new FakeRelay();
    h.relays.set(url, relay);
  }
  return relay;
}

const pool = {
  relay: (url: string) => relayAt(url),
  group: (urls: string[]) => ({
    query: async (filters: Filter[]) => (await Promise.all(urls.map((u) => relayAt(u).query(filters)))).flat(),
    event: async (ev: NostrEvent) => {
      await Promise.any(urls.map((u) => relayAt(u).event(ev)));
    },
  }),
  query: async (filters: Filter[]) =>
    (await Promise.all([...h.relays.values()].map((r) => (r as FakeRelay).query(filters)))).flat(),
  event: async (ev: NostrEvent) => {
    await Promise.any([...h.relays.values()].map((r) => (r as FakeRelay).event(ev)));
  },
};

vi.mock("@nostrify/react", () => ({ useNostr: () => ({ nostr: pool }) }));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: h.user }) }));
vi.mock("@/hooks/useAppContext", () => ({
  useAppContext: () => ({ config: { appRelays: [SELF_RELAY], communityRelays: [] } }),
}));
vi.mock("@/contexts/AppContext", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  selfStateRelays: () => [SELF_RELAY],
}));
vi.mock("@/hooks/useEventStore", () => ({
  useEventStore: () => Promise.resolve({ query: async () => [], event: async () => undefined }),
}));

const SELF_RELAY = "wss://relay.ditto.pub";
const OWNER = getPublicKey(generateSecretKey());

// Fresh per case: a second device starts with nothing on disk for the account.
let SK = generateSecretKey();
let PUBKEY = getPublicKey(SK);

/** The account on a device whose signer signs, and decrypts only if `nip44Works`. */
function deviceUser(nip44Works: boolean): NUser {
  const sk = SK;
  const pubkey = PUBKEY;
  const refuse = async () => {
    throw new Error("nip44_decrypt timed out");
  };
  return {
    pubkey,
    method: "bunker",
    signer: {
      getPublicKey: async () => pubkey,
      signEvent: async (t: EventTemplate) => finalizeEvent(t, sk),
      nip44: {
        encrypt: nip44Works
          ? async (pk: string, plaintext: string) => nip44Encrypt(plaintext, getConversationKey(sk, pk))
          : refuse,
        decrypt: nip44Works
          ? async (pk: string, ciphertext: string) => nip44Decrypt(ciphertext, getConversationKey(sk, pk))
          : refuse,
      },
    },
  } as unknown as NUser;
}

/** What the phone left on the account-state relay: a one-fragment list with one community. */
async function phonePublishedList() {
  const { mintCommunity } = await import("@/concord/lib/community");
  const { toJoinMaterial } = await import("@/concord/lib/communityList");
  const { fragment, serializeFragList } = await import("@/concord/lib/listFrag");
  const { community } = mintCommunity("Soapbox Community", OWNER, ["wss://relay.dreamith.to"]);
  const jm = toJoinMaterial(community, { relays: community.relays });
  const list = {
    entries: [{ community_id: jm.community_id, seed: jm, current: jm, added_at: Date.now() - 60_000 }],
    tombstones: [],
  };
  const frags = fragment(list as never);
  expect(frags).toHaveLength(1);
  const event = finalizeEvent({
    kind: 33302,
    content: nip44Encrypt(serializeFragList(frags[0]!), getConversationKey(SK, PUBKEY)),
    tags: [["d", "0"]],
    created_at: Math.floor(Date.now() / 1000) - 60,
  }, SK);
  relayAt(SELF_RELAY).stored.push(event);
  return { communityId: community.idHex };
}

function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

async function railNotice() {
  const { CommunityListLocked } = await import("@/concord/components/CommunityListLocked");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<CommunityListLocked />, { wrapper: wrapperFor(client) });
}

const NOTICE = { name: "Your communities couldn't be decrypted" };

async function openOnLaptop(user: NUser) {
  h.user = user;
  const { useCommunityList, useLiveCommunities } = await import("@/concord/hooks/useCommunityList");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { result } = renderHook(() => ({ list: useCommunityList(), live: useLiveCommunities() }), {
    wrapper: wrapperFor(client),
  });
  await waitFor(() => expect(result.current.list.isFetched).toBe(true));
  return result;
}

beforeEach(() => {
  SK = generateSecretKey();
  PUBKEY = getPublicKey(SK);
  h.relays.clear();
});

afterEach(() => {
  vi.resetModules();
});

describe("the laptop, signed in to the phone's account", { timeout: 30_000 }, () => {
  it("control: with a signer that decrypts, it shows the phone's community", async () => {
    const { communityId } = await phonePublishedList();
    const laptop = await openOnLaptop(deviceUser(true));
    await waitFor(() => expect(laptop.current.live.map((e) => e.community_id)).toEqual([communityId]));
    expect(laptop.current.list.data?.decryptFailed).toBeFalsy();
    await railNotice();
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.queryByRole("button", NOTICE)).toBeNull();
  });

  it("with a remote signer that won't decrypt, it shows no communities and says why", async () => {
    await phonePublishedList();
    const laptop = await openOnLaptop(deviceUser(false));

    // The list was found — the relay holds it and the read reached it…
    expect(relayAt(SELF_RELAY).stored.filter((e) => e.kind === 33302)).toHaveLength(1);
    // …but it couldn't be opened, and the rail is simply empty.
    expect(laptop.current.list.data?.decryptFailed).toBe(true);
    expect(laptop.current.live).toEqual([]);
    // The rail says so, rather than presenting an account that never joined any.
    await railNotice();
    expect(await screen.findByRole("button", NOTICE)).toBeTruthy();
  });

  it("with a signer that has no NIP-44 at all, the rail says why", async () => {
    await phonePublishedList();
    const user = deviceUser(true);
    delete (user.signer as { nip44?: unknown }).nip44;
    h.user = user;
    await railNotice();
    expect(await screen.findByRole("button", NOTICE)).toBeTruthy();
  });
});
