import { bytesToHex } from "@noble/hashes/utils.js";
import { useNostr } from "@nostrify/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useUpdateConcordList } from "@/concord-v1/hooks/useConcordList";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { buildDissolvedEditionUnsigned, sealDissolvedEdition } from "@/concord-v1/lib/control";
import {
  buildPublicInviteEvent,
  buildPublicInviteTombstone,
  encodeInviteUrl,
  newToken,
  parseInviteUrl,
} from "@/concord-v1/lib/publicInvite";
import type { Community } from "@/concord-v1/lib/types";

/**
 * Per-community actions for a Concord owner/member: generate public invite
 * links, leave, and dissolve. These ride the community's app relays. Direct
 * (gift-wrapped) invites are a V2-only feature now — V1 is being phased out
 * and no longer touches the giftwrap inbox at all.
 */
export function useConcordCommunityActions(
  community: Community | undefined,
  fallbackCommunityId?: string,
) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { mutateAsync: updateList } = useUpdateConcordList();
  const queryClient = useQueryClient();

  /**
   * Mint a public invite link. Posts the token-encrypted bundle to the
   * community's relays at the token-derived locator, and returns the shareable
   * URL (the token lives only in the `#fragment` — never on the wire).
   */
  const createInviteLink = useMutation<string, Error, { expiresAt?: number; label?: string }>({
    mutationFn: async ({ expiresAt, label }) => {
      if (!community) throw new Error("No community.");
      const token = newToken();
      const event = buildPublicInviteEvent(community, token, {
        expiresAt,
        label,
        creatorNpub: user?.pubkey,
      });
      await Promise.all(
        community.relays.map((url) =>
          nostr.relay(url).event(event, { signal: AbortSignal.timeout(8000) }).catch(() => {}),
        ),
      );
      return encodeInviteUrl(community.relays, token);
    },
  });

  /**
   * Revoke a public invite link: publish a token-signed tombstone that
   * overwrites the bundle at its coordinate, so the link fails cleanly.
   */
  const revokeInviteLink = useMutation<void, Error, { url: string }>({
    mutationFn: async ({ url }) => {
      if (!community) throw new Error("No community.");
      const { token } = parseInviteUrl(url);
      const tomb = buildPublicInviteTombstone(token);
      await Promise.all(
        community.relays.map((u) => nostr.relay(u).event(tomb, { signal: AbortSignal.timeout(8000) }).catch(() => {})),
      );
    },
  });

  /**
   * Leave the community: tombstone it in the membership list (stops
   * syncing/showing). Falls back to the raw community id (from the route/list
   * entry) when the full community can't be rehydrated — otherwise a broken
   * room (corrupt stored bundle) could never be removed.
   */
  const leave = useMutation<void, Error, void>({
    mutationFn: async () => {
      const communityId = community ? bytesToHex(community.id) : fallbackCommunityId;
      if (!communityId) throw new Error("No community.");
      await updateList({ type: "remove", communityId });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["concord", "list"] });
    },
  });

  /**
   * Dissolve the community (owner-only, IRREVERSIBLE): publish the terminal
   * GroupDissolved tombstone (vsk=10) under the epoch-free dissolved
   * envelope/pseudonym so every member at any epoch discovers it and seals the
   * community. Then remove it from the local membership list.
   */
  const dissolve = useMutation<void, Error, void>({
    mutationFn: async () => {
      if (!user || !community) throw new Error("Not ready.");
      const now = Math.floor(Date.now() / 1000);
      const inner = await user.signer.signEvent(buildDissolvedEditionUnsigned(community.id, now));
      const outer = sealDissolvedEdition(inner, community.id);
      await Promise.all(
        community.relays.map((url) =>
          nostr.relay(url).event(outer, { signal: AbortSignal.timeout(8000) }).catch(() => {}),
        ),
      );
      await updateList({ type: "remove", communityId: bytesToHex(community.id) });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["concord", "list"] });
    },
  });

  return {
    createInviteLink: createInviteLink.mutateAsync,
    isCreatingLink: createInviteLink.isPending,
    revokeInviteLink: revokeInviteLink.mutateAsync,
    leave: leave.mutateAsync,
    isLeaving: leave.isPending,
    dissolve: dissolve.mutateAsync,
    isDissolving: dissolve.isPending,
  };
}
