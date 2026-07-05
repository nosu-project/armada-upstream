import { bytesToHex } from "@noble/hashes/utils.js";
import { useNostr } from "@nostrify/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { generateSecretKey } from "nostr-tools/pure";
import { wrapEvent } from "nostr-tools/nip59";

import { useUpdateConcordList } from "@/concord-v1/hooks/useConcordList";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { buildDissolvedEditionUnsigned, sealDissolvedEdition } from "@/concord-v1/lib/control";
import { buildInviteRumorTemplate } from "@/concord-v1/lib/invite";
import {
  buildPublicInviteEvent,
  buildPublicInviteTombstone,
  encodeInviteUrl,
  newToken,
  parseInviteUrl,
} from "@/concord-v1/lib/publicInvite";
import type { Community } from "@/concord-v1/lib/types";

/**
 * Per-community actions for a Concord owner/member: generate invites (public
 * link + direct gift-wrap), leave, and ban (rekey). These ride the community's
 * app relays. Invite generation is what makes the join flows reachable from
 * within armada (without it, links/invites can only come from outside).
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
   * Send a direct invite to a specific npub over a NIP-17 gift wrap. The 3304
   * bundle is wrapped with an EPHEMERAL sender key (the invite's authority is
   * the owner attestation inside, not the wrap sender), so this works with any
   * signer type. The recipient's client parks it for consent.
   */
  const sendDirectInvite = useMutation<void, Error, { recipientPubkey: string }>({
    mutationFn: async ({ recipientPubkey }) => {
      if (!community) throw new Error("No community.");
      const rumorTemplate = buildInviteRumorTemplate(community);
      const ephemeralSk = generateSecretKey();
      // wrapEvent builds seal+wrap to the recipient; the rumor stays unsigned.
      const wrap = wrapEvent(
        { kind: rumorTemplate.kind, content: rumorTemplate.content, tags: rumorTemplate.tags, created_at: rumorTemplate.created_at },
        ephemeralSk,
        recipientPubkey,
      );
      // Publish on the community's relays + the recipient's perspective is the
      // app-relay pool (Concord rides app relays). nostr.event routes to app relays.
      await nostr.event(wrap, { signal: AbortSignal.timeout(8000) }).catch(() => {});
      await Promise.all(
        community.relays.map((url) =>
          nostr.relay(url).event(wrap, { signal: AbortSignal.timeout(8000) }).catch(() => {}),
        ),
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
    sendDirectInvite: sendDirectInvite.mutateAsync,
    isSendingInvite: sendDirectInvite.isPending,
    leave: leave.mutateAsync,
    isLeaving: leave.isPending,
    dissolve: dissolve.mutateAsync,
    isDissolving: dissolve.isPending,
  };
}
