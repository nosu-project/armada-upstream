import { bytesToHex } from "@noble/hashes/utils.js";
import { useNostr } from "@nostrify/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useConcordRoster } from "@/concord-v1/hooks/useConcordRoster";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useDeferredFold } from "@/concord-v1/hooks/useDeferredFold";
import {
  buildChannelMetadataEditionUnsigned,
  buildCommunityRootEditionUnsigned,
  foldMetadata,
  sealControlEdition,
  type FoldedMetadata,
} from "@/concord-v1/lib/control";
import { communityMetadataOf, type CommunityMetadata } from "@/concord-v1/lib/metadata";
import { hex32, type Community, type CommunityImage } from "@/concord-v1/lib/types";

/**
 * Fold the community's metadata control plane (GroupRoot vsk=0 +
 * ChannelMetadata vsk=2) into the authoritative name, description, icon/banner,
 * and per-channel name overrides. Reuses the SHARED control-plane fetch (same
 * kind-3308 / `#z` events the roster folds), so opening a channel doesn't
 * re-query the same filter or wait on a roster→metadata `enabled` waterfall.
 * Authority is enforced against the folded roster (MANAGE_METADATA /
 * MANAGE_CHANNELS), so a forged metadata edit is dropped on every client.
 *
 * Sources its control events THROUGH `useConcordRoster` rather than calling
 * `useConcordControlEvents` a second time: two instances of the query hook in
 * one subtree (the rail button mounts both) each ran their own seed effect and
 * raced a fetch, fanning the per-relay 3308 query out ~twice per community.
 * One instance = one fetch.
 *
 * `active` gates the network fan-out (forwarded to `useConcordRoster` →
 * `useConcordControlEvents`); the rail passes `active = false` so it paints the
 * icon/name from the persisted snapshot with no control-plane REQ.
 */
export function useConcordMetadata(community: Community | undefined, active = true) {
  const roster = useConcordRoster(community, active);
  const events = roster.events;
  const folded = roster.data;

  // Deferred fold (after paint) + persisted snapshot, so the verify-heavy
  // metadata fold doesn't block the first frame on a large control plane.
  const data = useDeferredFold<FoldedMetadata>(
    community ? `metadata:${bytesToHex(community.id)}` : null,
    () =>
      community && events && folded
        ? foldMetadata(events, community.serverRootKey, community.id, folded.roster, folded.ownerHex)
        : undefined,
    [community, events, folded],
  );

  return { ...roster, data } as typeof roster & { data: FoldedMetadata | undefined };
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
      queryClient.invalidateQueries({ queryKey: ["concord", "control", bytesToHex(community.id)] });
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
