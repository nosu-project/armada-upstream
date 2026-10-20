/**
 * The community blocklist: a blocked community can't be previewed or joined,
 * by an invite link, the optimistic path, or a resumed join, and the refusal
 * is a verdict, so a pending join is dropped rather than retried.
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

import { BlockedCommunityError, isJoinRejected, useCommunityActions } from "./useCommunityActions";

const h = vi.hoisted(() => ({
  user: undefined as unknown,
  nostr: undefined as unknown,
  ops: [] as string[],
  graveAt: undefined as number | undefined,
  probes: 0,
  blocked: new Set<string>(),
  refreshes: 0,
}));

vi.mock("@/lib/blocklistStore", () => ({
  isBlockedNow: (id: string) => h.blocked.has(id),
  refreshBlocklist: async () => {
    h.refreshes += 1;
  },
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
    mutateAsync: async (write: { type: string; entry?: unknown }) => {
      h.ops.push(`list:${write.type}`);
      return { entries: write.entry ? [write.entry] : [], tombstones: [] };
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
async function liveInvite(ownerPubkey: string) {
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
  const event = await buildBundleEvent(bundle, token, link.sk);
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
  h.blocked = new Set();
  h.refreshes = 0;
});

describe("a blocked community can't be previewed or joined", () => {
  it("preview refreshes the list, then refuses", async () => {
    h.user = signer();
    const { invite, bundle } = await liveInvite(signer().pubkey);
    h.blocked.add(bundle.community_id);

    const { result } = renderHook(() => useCommunityActions(), { wrapper });
    await expect(result.current.preview({ invite })).rejects.toBeInstanceOf(BlockedCommunityError);
    expect(h.refreshes).toBe(1);
  });

  it("join refuses and records nothing", async () => {
    h.user = signer();
    const { invite, bundle } = await liveInvite(signer().pubkey);
    h.blocked.add(bundle.community_id);

    const { result } = renderHook(() => useCommunityActions(), { wrapper });
    await expect(result.current.join({ invite })).rejects.toBeInstanceOf(BlockedCommunityError);
    expect(h.ops).not.toContain("list:add");
  });

  it("the optimistic join refuses a bundle previewed before the block", async () => {
    h.user = signer();
    const { invite, bundle } = await liveInvite(signer().pubkey);
    h.blocked.add(bundle.community_id);

    const { result } = renderHook(() => useCommunityActions(), { wrapper });
    await expect(result.current.join({ invite, bundle })).rejects.toBeInstanceOf(BlockedCommunityError);
    expect(h.ops).not.toContain("list:add");
  });

  it("is a verdict, so a pending join is dropped", () => {
    expect(isJoinRejected(new BlockedCommunityError())).toBe(true);
  });

  it("leaves other communities alone", async () => {
    h.user = signer();
    const { invite } = await liveInvite(signer().pubkey);
    h.blocked.add("11".repeat(32));

    const { result } = renderHook(() => useCommunityActions(), { wrapper });
    await result.current.join({ invite });
    expect(h.ops).toContain("list:add");
  });
});
