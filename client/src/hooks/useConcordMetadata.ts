import { bytesToHex } from "@noble/hashes/utils.js";
import { useNostr } from "@nostrify/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useConcordRoster } from "@/hooks/useConcordRoster";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import {
  buildChannelMetadataEditionUnsigned,
  buildCommunityRootEditionUnsigned,
  controlPseudonym,
  foldMetadata,
  sealControlEdition,
  type FoldedMetadata,
} from "@/lib/concord/control";
import { KIND_COMMUNITY_CONTROL } from "@/lib/concord/kinds";
import { communityMetadataOf, type CommunityMetadata } from "@/lib/concord/metadata";
import { hex32, type Community, type CommunityImage } from "@/lib/concord/types";

import type { NostrEvent } from "@nostrify/nostrify";

/**
 * Fetch + fold the community's metadata control plane (GroupRoot vsk=0 +
 * ChannelMetadata vsk=2 kind-3308 editions) into the authoritative name,
 * description, icon/banner, and per-channel name overrides. Authority is
 * enforced against the folded roster (MANAGE_METADATA / MANAGE_CHANNELS), so a
 * forged metadata edit is dropped on every client.
 */
export function useConcordMetadata(community: Community | undefined) {
  const { nostr } = useNostr();
  const roster = useConcordRoster(community);

  return useQuery<FoldedMetadata>({
    queryKey: ["concord", "metadata", community ? bytesToHex(community.id) : null],
    enabled: Boolean(community) && Boolean(roster.data),
    staleTime: 15_000,
    refetchInterval: 30_000,
    queryFn: async ({ signal }) => {
      const z = controlPseudonym(community!.serverRootKey, community!.id, community!.serverRootEpoch);
      const results = await Promise.all(
        community!.relays.map((url) =>
          nostr
            .relay(url)
            .query([{ kinds: [KIND_COMMUNITY_CONTROL], "#z": [z], limit: 500 }], {
              signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
            })
            .catch(() => [] as NostrEvent[]),
        ),
      );
      return foldMetadata(
        results.flat(),
        community!.serverRootKey,
        community!.id,
        roster.data!.roster,
        roster.data!.ownerHex,
      );
    },
  });
}

/**
 * Metadata mutations: edit the community's GroupRoot (name/description/icon/
 * banner) and rename a channel. The actor's real npub signs; every member's
 * fold re-checks MANAGE_METADATA / MANAGE_CHANNELS, so an unauthorized edit is
 * dropped. Each edit is version-chained off the held head.
 */
export function useConcordMetadataActions(community: Community | undefined) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  const metadata = useConcordMetadata(community);

  const invalidate = () => {
    if (community) {
      queryClient.invalidateQueries({ queryKey: ["concord", "metadata", bytesToHex(community.id)] });
    }
  };

  const publish = async (unsigned: { kind: number; content: string; tags: string[][]; created_at: number }) => {
    if (!user || !community) throw new Error("Not ready.");
    const inner = await user.signer.signEvent(unsigned);
    const outer = sealControlEdition(inner, community.serverRootKey, community.id, community.serverRootEpoch);
    await Promise.all(
      community.relays.map((url) =>
        nostr.relay(url).event(outer, { signal: AbortSignal.timeout(8000) }).catch(() => {}),
      ),
    );
  };

  const updateMetadata = useMutation<void, Error, {
    name?: string;
    description?: string;
    icon?: CommunityImage | null;
    banner?: CommunityImage | null;
  }>({
    mutationFn: async (patch) => {
      if (!community) throw new Error("No community.");
      const now = Math.floor(Date.now() / 1000);

      // Start from the current folded root (or the community's own descriptor),
      // apply the patch, and chain off the GroupRoot head.
      const current: CommunityMetadata = metadata.data?.root ?? communityMetadataOf(community);
      const next: CommunityMetadata = { ...current };
      if (patch.name !== undefined) next.name = patch.name.trim();
      if (patch.description !== undefined) {
        next.description = patch.description.trim() || undefined;
      }
      if (patch.icon !== undefined) next.icon = patch.icon ?? undefined;
      if (patch.banner !== undefined) next.banner = patch.banner ?? undefined;

      const key = bytesToHex(community.id);
      const head = metadata.data?.heads.get(key);
      await publish(
        buildCommunityRootEditionUnsigned({
          communityId: community.id,
          metadata: next,
          version: head ? head.version + 1n : 1n,
          prevHash: head?.hash,
          createdAtSecs: now,
        }),
      );
    },
    onSuccess: invalidate,
  });

  const renameChannel = useMutation<void, Error, { channelId: string; name: string }>({
    mutationFn: async ({ channelId, name }) => {
      if (!community) throw new Error("No community.");
      const trimmed = name.trim();
      if (!trimmed) throw new Error("Channel name is required.");
      const now = Math.floor(Date.now() / 1000);
      const head = metadata.data?.heads.get(channelId);
      await publish(
        buildChannelMetadataEditionUnsigned({
          channelId: hex32(channelId),
          metadata: { name: trimmed },
          version: head ? head.version + 1n : 1n,
          prevHash: head?.hash,
          createdAtSecs: now,
        }),
      );
    },
    onSuccess: invalidate,
  });

  return {
    metadata: metadata.data,
    isLoading: metadata.isLoading,
    updateMetadata: updateMetadata.mutateAsync,
    isUpdating: updateMetadata.isPending,
    renameChannel: renameChannel.mutateAsync,
    isRenaming: renameChannel.isPending,
  };
}
