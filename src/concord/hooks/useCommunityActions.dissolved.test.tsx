/**
 * Dissolution, from the owner's side and from a joiner's.
 *
 * The owner: the grave is published, the community is marked dissolved
 * locally, and only THEN are its links retired and its vault entry dropped —
 * a retirement that ran first could publish past a dissolution that failed,
 * and one that ran after the entry went would have nothing left to run from.
 *
 * A joiner: a bundle keeps resolving after dissolution (nothing about the grave
 * touches a link coordinate), so both the preview and the join itself must
 * refuse a community whose grave is found.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { finalizeEvent, generateSecretKey, getPublicKey, type EventTemplate } from "nostr-tools/pure";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReactNode } from "react";

import { mintCommunity } from "@/concord/lib/community";
import { bytesToHex } from "@/concord/lib/derive";
import {
  buildBundleEvent,
  buildInviteUrl,
  mintLinkSigner,
  mintToken,
  parseInviteLink,
  type InviteBundle,
} from "@/concord/lib/invite";

import { DissolvedCommunityError, useCommunityActions, useCommunityManagement } from "./useCommunityActions";

import type { NostrEvent } from "@nostrify/nostrify";

const h = vi.hoisted(() => ({
  user: undefined as unknown,
  nostr: undefined as unknown,
  ops: [] as string[],
  graveAt: undefined as number | undefined,
  probes: 0,
}));

vi.mock("@nostrify/react", () => ({ useNostr: () => ({ nostr: h.nostr }) }));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: h.user }) }));
vi.mock("@/hooks/useAppContext", () => ({
  useAppContext: () => ({ config: { appRelays: ["wss://relay.test"] } }),
}));
vi.mock("@/hooks/useToast", () => ({ toast: () => undefined }));
vi.mock("@/concord/hooks/useControlPlane", () => ({
  useControlFold: () => ({ data: undefined }),
  useDissolved: () => ({ data: undefined }),
  citationFor: () => undefined,
  invalidateControl: () => undefined,
  publishEdition: async () => {
    h.ops.push("edition");
  },
  markDissolvedLocally: async () => {
    h.ops.push("mark");
  },
  probeCommunityDissolved: async () => {
    h.probes += 1;
    return h.graveAt;
  },
}));
vi.mock("@/concord/hooks/useCommunityList", () => ({
  useCommunityEntry: () => undefined,
  useUpdateCommunityList: () => ({
    mutateAsync: async (write: { type: string }) => {
      h.ops.push(`list:${write.type}`);
    },
  }),
}));
vi.mock("@/concord/hooks/useGuestbook", () => ({
  useGuestbookPublisher: () => ({ mutateAsync: async () => undefined }),
}));

const RELAY = "wss://relay.test";

function signer() {
  const sk = generateSecretKey();
  return {
    pubkey: getPublicKey(sk),
    signer: {
      getPublicKey: async () => getPublicKey(sk),
      signEvent: async (t: EventTemplate) => finalizeEvent(t, sk),
      nip44: {},
    },
  };
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** A live invite to a freshly minted community, and a pool that vends its bundle. */
function liveInvite(ownerPubkey: string) {
  const { community } = mintCommunity("Fleet", ownerPubkey, [RELAY]);
  const bundle: InviteBundle = {
    community_id: community.idHex,
    owner: community.owner,
    owner_salt: bytesToHex(community.ownerSalt),
    community_root: bytesToHex(community.root),
    root_epoch: 0,
    control_pk: community.controlPk,
    channels: [],
    relays: [RELAY],
    name: "Fleet",
  } as InviteBundle;
  const token = mintToken();
  const link = mintLinkSigner();
  const event = buildBundleEvent(bundle, token, link.sk);
  const invite = parseInviteLink(buildInviteUrl("https://armada.test", link.pk, token, [RELAY]))!;
  h.nostr = {
    relay: () => ({
      query: async () => [event],
      event: async () => undefined,
    }),
  };
  return { invite, bundle };
}

beforeEach(() => {
  h.ops = [];
  h.graveAt = undefined;
  h.probes = 0;
});

describe("dissolve — ordering", () => {
  it("publishes the grave, marks it, retires the links, then drops the entry", async () => {
    const owner = signer();
    h.user = owner;
    const { community } = mintCommunity("Fleet", owner.pubkey, [RELAY]);
    h.nostr = {
      relay: () => ({
        event: async (e: NostrEvent) => {
          h.ops.push(`grave:${e.kind}`);
        },
      }),
    };

    const { result } = renderHook(() => useCommunityManagement(community), { wrapper });
    await result.current.dissolve({
      retire: async () => {
        h.ops.push("retire");
      },
    });

    expect(h.ops).toEqual(["grave:1059", "mark", "retire", "list:remove"]);
    expect(h.ops, "no control edition follows the grave").not.toContain("edition");
  });

  it("retires nothing when no relay accepts the grave", async () => {
    const owner = signer();
    h.user = owner;
    const { community } = mintCommunity("Fleet", owner.pubkey, [RELAY]);
    h.nostr = {
      relay: () => ({
        event: async () => {
          throw new Error("down");
        },
      }),
    };

    const { result } = renderHook(() => useCommunityManagement(community), { wrapper });
    await expect(
      result.current.dissolve({
        retire: async () => {
          h.ops.push("retire");
        },
      }),
    ).rejects.toThrow(/dissolution/);
    expect(h.ops).toEqual([]);
  });

  it("still drops the entry when the retirement throws", async () => {
    const owner = signer();
    h.user = owner;
    const { community } = mintCommunity("Fleet", owner.pubkey, [RELAY]);
    h.nostr = { relay: () => ({ event: async () => undefined }) };

    const { result } = renderHook(() => useCommunityManagement(community), { wrapper });
    await result.current.dissolve({
      retire: async () => {
        throw new Error("relays down");
      },
    });
    expect(h.ops).toEqual(["mark", "list:remove"]);
  });
});

describe("a dissolved community can't be previewed or joined", () => {
  it("preview refuses with DissolvedCommunityError", async () => {
    h.user = signer();
    const { invite } = liveInvite(signer().pubkey);
    h.graveAt = Date.now();

    const { result } = renderHook(() => useCommunityActions(), { wrapper });
    await expect(result.current.preview({ invite })).rejects.toBeInstanceOf(DissolvedCommunityError);
  });

  it("join refuses with DissolvedCommunityError and records nothing", async () => {
    h.user = signer();
    const { invite } = liveInvite(signer().pubkey);
    h.graveAt = Date.now();

    const { result } = renderHook(() => useCommunityActions(), { wrapper });
    await expect(result.current.join({ invite })).rejects.toBeInstanceOf(DissolvedCommunityError);
    expect(h.ops, "no vault write for a dead community").not.toContain("list:add");
  });

  it("a live community previews and joins", async () => {
    h.user = signer();
    const { invite, bundle } = liveInvite(signer().pubkey);

    const { result } = renderHook(() => useCommunityActions(), { wrapper });
    const preview = await result.current.preview({ invite });
    expect(preview.communityId).toBe(bundle.community_id);
    await result.current.join({ invite });
    expect(h.ops).toContain("list:add");
  });
});
