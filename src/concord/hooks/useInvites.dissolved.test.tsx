/**
 * The link side of dissolution.
 *
 * Retiring a dissolved community's links publishes revocation tombstones and
 * nothing on the control plane (no registry edition may follow the grave),
 * and hands back a retry holding whatever didn't land — the community leaves
 * the rail when dissolve finishes, taking every other retry path with it.
 *
 * The freshness watcher re-posts a creator's bundles on every open; for a
 * dissolved community (or one whose check hasn't answered) it must not, or the
 * dead links would keep resolving.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { finalizeEvent, generateSecretKey, getPublicKey, type EventTemplate } from "nostr-tools/pure";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReactNode } from "react";

import { mintCommunity } from "@/concord/lib/community";
import { bytesToHex } from "@/concord/lib/derive";
import { buildInviteUrl, mintLinkSigner, mintToken, type InviteList } from "@/concord/lib/invite";

import { inviteListKey, useLinkFreshnessWatch, useRetireCommunityLinks } from "./useInvites";

import type { NostrEvent } from "@nostrify/nostrify";

const h = vi.hoisted(() => ({
  pool: undefined as unknown,
  user: undefined as unknown,
  folded: undefined as unknown,
  dissolved: null as number | null | undefined,
  ops: [] as string[],
}));

vi.mock("@nostrify/react", () => ({ useNostr: () => ({ nostr: h.pool }) }));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: h.user }) }));
vi.mock("@/hooks/useAppContext", () => ({
  useAppContext: () => ({
    config: { useAppRelays: false, appRelays: [], useUserRelays: false, relayMetadata: { relays: [], updatedAt: 0 } },
  }),
}));
vi.mock("@/hooks/useNostrPublish", () => ({
  useNostrPublish: () => ({
    mutateAsync: async (t: { kind: number }) => {
      h.ops.push(`publish:${t.kind}`);
    },
  }),
}));
vi.mock("@/hooks/useToast", () => ({ toast: () => undefined }));
vi.mock("@/concord/hooks/useCommunityList", () => ({ useCommunity: () => undefined }));
vi.mock("@/concord/hooks/useControlPlane", () => ({
  useControlFold: () => ({ data: h.folded, isLoading: false, isFetching: false }),
  useDissolved: () => ({ data: h.dissolved }),
  citationFor: () => undefined,
  invalidateControl: () => undefined,
  publishEdition: async () => {
    h.ops.push("edition");
  },
}));

const RELAY = "wss://relay.test";

function creator() {
  const sk = generateSecretKey();
  const pubkey = getPublicKey(sk);
  return {
    pubkey,
    signer: {
      getPublicKey: async () => pubkey,
      signEvent: async (t: EventTemplate) => finalizeEvent(t, sk),
      nip44: { encrypt: async () => "", decrypt: async () => "" },
    },
  };
}

/** A creator holding one live link for a fresh community, its list already cached. */
function setup() {
  const me = creator();
  h.user = me;
  const { community } = mintCommunity("Fleet", me.pubkey, [RELAY]);
  const link = mintLinkSigner();
  const token = mintToken();
  const list: InviteList = {
    entries: [
      {
        token: bytesToHex(token),
        signer_sk: bytesToHex(link.sk),
        community_id: community.idHex,
        url: buildInviteUrl("https://armada.test", link.pk, token, [RELAY]),
        created_at: 1,
      },
    ],
    tombstones: [],
  };
  h.folded = {
    ownerHex: me.pubkey,
    roster: { roles: [], grants: [] },
    heads: new Map(),
    registriesByCreator: new Map([[me.pubkey, [link.pk]]]),
    liveInviteLinks: new Set([link.pk]),
  };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  queryClient.setQueryData(inviteListKey(me.pubkey), list);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { me, community, link, wrapper };
}

beforeEach(() => {
  h.ops = [];
  h.dissolved = null;
});

describe("useRetireCommunityLinks (run by dissolve, after the grave)", () => {
  it("publishes no registry edition, and retries exactly the revocation no relay accepted", async () => {
    const { community, link, wrapper } = setup();
    let blocked = true;
    const sent: { relay: string; event: NostrEvent }[] = [];
    h.pool = {
      relay: (url: string) => ({
        query: async () => [],
        event: async (event: NostrEvent) => {
          if (blocked) throw new Error("blocked");
          sent.push({ relay: url, event });
        },
      }),
    };

    const { result, unmount } = renderHook(() => useRetireCommunityLinks(community), { wrapper });
    const outcome = await result.current();

    expect(outcome.revokeFailed).toBe(true);
    expect(outcome.retry).toBeDefined();
    expect(h.ops, "nothing on the control plane after the grave").not.toContain("edition");

    // Retry runs after the community (and this hook) are gone.
    unmount();
    blocked = false;
    const again = await outcome.retry!();

    expect(again.revokeFailed).toBe(false);
    expect(again.retry).toBeUndefined();
    expect(sent.map((s) => s.event.pubkey)).toEqual([link.pk]);
    expect(community.relays).toContain(sent[0].relay);
    expect(h.ops).not.toContain("edition");
  });

  it("revokes every link and offers no retry when the tombstones land", async () => {
    const { community, link, wrapper } = setup();
    const sent: NostrEvent[] = [];
    h.pool = {
      relay: () => ({
        query: async () => [],
        event: async (e: NostrEvent) => {
          sent.push(e);
        },
      }),
    };

    const { result } = renderHook(() => useRetireCommunityLinks(community), { wrapper });
    const outcome = await result.current();

    expect(outcome.revokeFailed).toBe(false);
    expect(sent.some((e) => e.pubkey === link.pk && e.tags.some((t) => t[0] === "vsk"))).toBe(true);
    expect(h.ops).not.toContain("edition");
    expect(outcome.retry).toBeUndefined();
  });
});

describe("useLinkFreshnessWatch — the dissolved gate", () => {
  function mountWatch(dissolved: number | null | undefined) {
    const { community, link, wrapper } = setup();
    h.dissolved = dissolved;
    const sent: NostrEvent[] = [];
    h.pool = {
      relay: () => ({
        query: async () => [],
        event: async (e: NostrEvent) => {
          sent.push(e);
        },
      }),
    };
    renderHook(() => useLinkFreshnessWatch(community), { wrapper });
    return { sent, link };
  }

  const settle = () => new Promise((r) => setTimeout(r, 300));

  it("re-posts a live community's links (the control case)", async () => {
    const { sent, link } = mountWatch(null);
    await settle();
    expect(sent.some((e) => e.pubkey === link.pk)).toBe(true);
  });

  it("never re-posts a dissolved community's links", async () => {
    const { sent } = mountWatch(Date.now());
    await settle();
    expect(sent).toHaveLength(0);
  });

  it("waits while the dissolved check is still asking", async () => {
    const { sent } = mountWatch(undefined);
    await settle();
    expect(sent).toHaveLength(0);
  });
});
