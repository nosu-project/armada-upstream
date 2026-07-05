import { useNostr } from "@nostrify/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useCommunityEntry2, useUpdateCommunityList2 } from "@/concord-v2/hooks/useCommunityList2";
import { useControlFold2, citationFor, invalidateControl2, publishEdition2 } from "@/concord-v2/hooks/useControlPlane2";
import { useGuestbookPublisher2 } from "@/concord-v2/hooks/useGuestbook2";
import { buildJoinRumor, currentGuestbookGroup, sealGuestbook } from "@/concord-v2/lib/guestbook";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { APP_RELAYS } from "@/lib/platform";
import { toJoinMaterial, rehydrateCommunity, type CommunityListEntry, type JoinMaterial } from "@/concord-v2/lib/communityList";
import { mintCommunity } from "@/concord-v2/lib/community";
import {
  buildChannelEdition,
  buildMetadataEdition,
  sealDissolved,
} from "@/concord-v2/lib/control";
import { bytesToHex, hex32, random32 } from "@/concord-v2/lib/derive";
import { parseBundleEvent, type InviteBundle, type ParsedInviteLink } from "@/concord-v2/lib/invite";
import { KIND_INVITE_BUNDLE } from "@/concord-v2/lib/kinds";
import { capRelays, type CommunityV2 } from "@/concord-v2/lib/types";

import type { NostrEvent } from "@nostrify/nostrify";

/** A preview of where a V2 invite leads, resolved before joining. */
export interface InvitePreview2 {
  communityId: string;
  name: string;
  channelCount: number;
  relays: string[];
  bundle: InviteBundle;
}

/** Fetch + verify a V2 invite bundle from its bootstrap relays. */
async function resolveBundle(
  nostr: ReturnType<typeof useNostr>["nostr"],
  invite: ParsedInviteLink,
  fallbackRelays: string[],
): Promise<InviteBundle> {
  const pool = invite.bootstrapRelays.length ? invite.bootstrapRelays : fallbackRelays;
  const results = await Promise.all(
    pool.map((url) =>
      nostr
        .relay(url)
        .query(
          [{ kinds: [KIND_INVITE_BUNDLE], authors: [invite.linkSigner], "#d": [""], limit: 1 }],
          { signal: AbortSignal.timeout(8000) },
        )
        .catch(() => [] as NostrEvent[]),
    ),
  );
  const flat = results.flat().sort((a, b) => b.created_at - a.created_at);
  if (flat.length === 0) throw new Error("Couldn't find that invite on its relays.");
  // The newest event at the coordinate wins: a refresh replaces the bundle, a
  // revocation tombstone replaces it terminally.
  return parseBundleEvent(flat[0], invite.linkSigner, invite.token, Date.now());
}

/** Turn a verified bundle into the membership-list join material + entry. */
function bundleToEntry(bundle: InviteBundle): CommunityListEntry {
  const jm: JoinMaterial = {
    community_id: bundle.community_id,
    owner: bundle.owner,
    owner_salt: bundle.owner_salt,
    community_root: bundle.community_root,
    root_epoch: bundle.root_epoch,
    channels: Array.isArray(bundle.channels)
      ? bundle.channels.map((ch) => ({ id: ch.id, key: ch.key, epoch: ch.epoch, name: ch.name }))
      : [],
    relays: capRelays(bundle.relays),
    name: bundle.name,
  };
  return { community_id: jm.community_id, seed: jm, current: jm, added_at: Date.now() };
}

/**
 * Create / preview / join for Concord V2 communities. Creating publishes the
 * genesis Control Plane — EXACTLY two owner-signed editions, the metadata and
 * one public `#general` (CORD-02 §1) — plus the creator's own Guestbook Join,
 * and records the keys in the Community List (the only durable record).
 */
export function useCommunityActions2() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { mutateAsync: updateList } = useUpdateCommunityList2();
  const queryClient = useQueryClient();

  const create = useMutation<{ communityId: string; name: string }, Error, { name: string }>({
    mutationFn: async ({ name }) => {
      if (!user) throw new Error("Sign in to start an encrypted community.");
      if (!user.signer.nip44) throw new Error("This signer can't hold encrypted communities (NIP-44 unsupported).");
      const trimmed = name.trim();
      if (!trimmed) throw new Error("Name your community first.");

      const { community, generalChannelId } = mintCommunity(trimmed, user.pubkey, APP_RELAYS);

      // Genesis: two owner-signed editions, nothing more (CORD-02 §1).
      await publishEdition2(
        nostr,
        community,
        user.signer,
        buildMetadataEdition(
          community.id,
          { name: trimmed, relays: community.relays },
          { actorPubkey: user.pubkey, version: 1n },
        ),
      );
      await publishEdition2(
        nostr,
        community,
        user.signer,
        buildChannelEdition(
          generalChannelId,
          { name: "general", private: false },
          { actorPubkey: user.pubkey, version: 1n },
        ),
      );

      // Record membership FIRST (the vault), then announce presence.
      const jm = toJoinMaterial(community, { relays: community.relays });
      await updateList({
        type: "add",
        entry: { community_id: community.idHex, seed: jm, current: jm, added_at: Date.now() },
      });

      // Best-effort founder Join, so the member list has a firsthand entry.
      void (async () => {
        const rumor = buildJoinRumor(user.pubkey, Date.now());
        const wrap = await sealGuestbook(rumor, currentGuestbookGroup(community), user.signer);
        await Promise.allSettled(
          community.relays.map((url) => nostr.relay(url).event(wrap, { signal: AbortSignal.timeout(8000) })),
        );
      })().catch(() => undefined);

      return { communityId: community.idHex, name: trimmed };
    },
  });

  const preview = useMutation<InvitePreview2, Error, { invite: ParsedInviteLink }>({
    mutationFn: async ({ invite }) => {
      const bundle = await resolveBundle(nostr, invite, APP_RELAYS);
      return {
        communityId: bundle.community_id,
        name: bundle.name,
        channelCount: Array.isArray(bundle.channels) ? bundle.channels.length : 0,
        relays: bundle.relays,
        bundle,
      };
    },
  });

  const join = useMutation<{ communityId: string; name: string }, Error, { invite: ParsedInviteLink }>({
    mutationFn: async ({ invite }) => {
      if (!user) throw new Error("Sign in to join an encrypted community.");
      const bundle = await resolveBundle(nostr, invite, APP_RELAYS);
      const entry = bundleToEntry(bundle);
      await updateList({ type: "add", entry });
      queryClient.invalidateQueries({ queryKey: ["concord2", "list"] });

      // Best-effort self-signed Guestbook Join, echoing the link's attribution
      // (CORD-02 §5 / CORD-05 §1) — the coalesce self-heals if it never lands.
      void (async () => {
        const community = rehydrateCommunity(entry, APP_RELAYS);
        if (!community) return;
        const attribution = bundle.creator_npub
          ? { creator: bundle.creator_npub, label: bundle.label }
          : undefined;
        const rumor = buildJoinRumor(user.pubkey, Date.now(), attribution);
        const wrap = await sealGuestbook(rumor, currentGuestbookGroup(community), user.signer);
        await Promise.allSettled(
          community.relays.map((url) => nostr.relay(url).event(wrap, { signal: AbortSignal.timeout(8000) })),
        );
      })().catch(() => undefined);

      return { communityId: bundle.community_id, name: bundle.name };
    },
  });

  return {
    create: create.mutateAsync,
    isCreating: create.isPending,
    preview: preview.mutateAsync,
    isPreviewing: preview.isPending,
    join: join.mutateAsync,
    isJoining: join.isPending,
  };
}

/** Per-community actions: leave, dissolve, and channel management. */
export function useCommunityManagement2(community: CommunityV2 | undefined) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { mutateAsync: updateList } = useUpdateCommunityList2();
  const { data: folded } = useControlFold2(community);
  const publisher = useGuestbookPublisher2(community);
  const entry = useCommunityEntry2(community?.idHex);
  const queryClient = useQueryClient();

  const leave = useMutation<void, Error, void>({
    mutationFn: async () => {
      if (!user || !community) throw new Error("Not ready.");
      // Best-effort Leave (the tombstone is the authoritative local act).
      await publisher.mutateAsync({ type: "leave" }).catch(() => undefined);
      await updateList({ type: "remove", communityId: community.idHex });
    },
  });

  const dissolve = useMutation<void, Error, void>({
    mutationFn: async () => {
      if (!user || !community) throw new Error("Not ready.");
      if (user.pubkey !== community.owner) throw new Error("Only the owner can delete the community.");
      const wrap = await sealDissolved(community.id, user.pubkey, user.signer);
      const results = await Promise.allSettled(
        community.relays.map((url) => nostr.relay(url).event(wrap, { signal: AbortSignal.timeout(8000) })),
      );
      if (!results.some((r) => r.status === "fulfilled")) {
        throw new Error("No relay accepted the dissolution.");
      }
      await updateList({ type: "remove", communityId: community.idHex });
    },
  });

  const createChannel = useMutation<{ channelIdHex: string }, Error, { name: string }>({
    mutationFn: async ({ name }) => {
      if (!user || !community) throw new Error("Not ready.");
      const trimmed = name.trim();
      if (!trimmed) throw new Error("Channel name is required.");
      const channelId = random32();
      await publishEdition2(
        nostr,
        community,
        user.signer,
        buildChannelEdition(
          channelId,
          { name: trimmed, private: false },
          { actorPubkey: user.pubkey, version: 1n, authority: citationFor(community, folded, user.pubkey) },
        ),
      );
      invalidateControl2(queryClient, community.idHex);
      return { channelIdHex: bytesToHex(channelId) };
    },
  });

  const renameChannel = useMutation<void, Error, { channelIdHex: string; name: string }>({
    mutationFn: async ({ channelIdHex, name }) => {
      if (!user || !community) throw new Error("Not ready.");
      const trimmed = name.trim();
      if (!trimmed) throw new Error("Channel name is required.");
      const def = folded?.channels.get(channelIdHex);
      const head = folded?.heads.get(channelIdHex);
      await publishEdition2(
        nostr,
        community,
        user.signer,
        buildChannelEdition(
          hex32(channelIdHex),
          { name: trimmed, private: def?.isPrivate ?? false },
          {
            actorPubkey: user.pubkey,
            version: head ? head.version + 1n : 1n,
            prevHash: head?.hash,
            authority: citationFor(community, folded, user.pubkey),
          },
        ),
      );
      invalidateControl2(queryClient, community.idHex);
    },
  });

  const deleteChannel = useMutation<void, Error, { channelIdHex: string }>({
    mutationFn: async ({ channelIdHex }) => {
      if (!user || !community) throw new Error("Not ready.");
      const def = folded?.channels.get(channelIdHex);
      const head = folded?.heads.get(channelIdHex);
      await publishEdition2(
        nostr,
        community,
        user.signer,
        buildChannelEdition(
          hex32(channelIdHex),
          { name: def?.name ?? "deleted", private: def?.isPrivate ?? false, deleted: true },
          {
            actorPubkey: user.pubkey,
            version: head ? head.version + 1n : 1n,
            prevHash: head?.hash,
            authority: citationFor(community, folded, user.pubkey),
          },
        ),
      );
      invalidateControl2(queryClient, community.idHex);
    },
  });

  return {
    leave: leave.mutateAsync,
    isLeaving: leave.isPending,
    dissolve: dissolve.mutateAsync,
    isDissolving: dissolve.isPending,
    createChannel: createChannel.mutateAsync,
    isAddingChannel: createChannel.isPending,
    renameChannel: renameChannel.mutateAsync,
    isRenaming: renameChannel.isPending,
    deleteChannel: deleteChannel.mutateAsync,
    entry,
  };
}
