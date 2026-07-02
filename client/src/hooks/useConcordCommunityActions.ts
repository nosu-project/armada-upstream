import { bytesToHex } from "@noble/hashes/utils.js";
import { useNostr } from "@nostrify/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { generateSecretKey } from "nostr-tools/pure";
import { wrapEvent } from "nostr-tools/nip59";

import { useUpdateConcordList } from "@/hooks/useConcordList";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { buildDissolvedEditionUnsigned, sealDissolvedEdition } from "@/lib/concord/control";
import { buildInviteRumorTemplate } from "@/lib/concord/invite";
import {
  buildPublicInviteEvent,
  buildPublicInviteTombstone,
  encodeCordInviteUrl,
  encodeInviteUrl,
  newToken,
  parseInviteUrl,
} from "@/lib/concord/publicInvite";
import { buildCordInviteEvent, buildCordInviteTombstone } from "@/lib/cord/invite";
import type { Community } from "@/lib/concord/types";

/**
 * Per-community actions for a Concord owner/member: generate invites (public
 * link + direct gift-wrap), leave, and ban (rekey). These ride the community's
 * app relays. Invite generation is what makes the join flows reachable from
 * within armada (without it, links/invites can only come from outside).
 */
export function useConcordCommunityActions(community: Community | undefined) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { mutateAsync: updateList } = useUpdateConcordList();
  const queryClient = useQueryClient();

  /**
   * Mint a public invite link. Posts the token-encrypted bundle to the
   * community's relays at the token-derived locator, and returns the shareable
   * URL (the token lives only in the `#fragment` — never on the wire).
   *
   * The link format follows the community's wire: a v1 community mints v2
   * (Vector-parity) fragments — untouched; a CORD community necessarily mints
   * v3 CORD fragments (its keys only make sense to the CORD derivations).
   * Since creating a CORD community is itself the explicit opt-in, no v3 link
   * can ever be generated without it.
   */
  const createInviteLink = useMutation<string, Error, { expiresAt?: number; label?: string }>({
    mutationFn: async ({ expiresAt, label }) => {
      if (!community) throw new Error("No community.");
      const token = newToken();
      const isCord = community.proto === "cord";
      const event = isCord
        ? buildCordInviteEvent(community, token, { expiresAt, label, creatorNpub: user?.pubkey })
        : buildPublicInviteEvent(community, token, {
            expiresAt,
            label,
            creatorNpub: user?.pubkey,
          });
      await Promise.all(
        community.relays.map((url) =>
          nostr.relay(url).event(event, { signal: AbortSignal.timeout(8000) }).catch(() => {}),
        ),
      );
      return isCord ? encodeCordInviteUrl(community.relays, token) : encodeInviteUrl(community.relays, token);
    },
  });

  /**
   * Revoke a public invite link: publish a token-signed tombstone that
   * overwrites the bundle at its coordinate, so the link fails cleanly.
   */
  const revokeInviteLink = useMutation<void, Error, { url: string }>({
    mutationFn: async ({ url }) => {
      if (!community) throw new Error("No community.");
      const { token, proto } = parseInviteUrl(url);
      const tomb = proto === "cord" ? buildCordInviteTombstone(token) : buildPublicInviteTombstone(token);
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
      if (community.proto === "cord") {
        // CORD core covers link invites (CORD-05); the targeted-DM bundle is a
        // follow-up. Share a link instead.
        throw new Error("Direct invites aren't available for experimental communities yet — share an invite link.");
      }
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

  /** Leave the community: tombstone it in the membership list (stops syncing/showing). */
  const leave = useMutation<void, Error, void>({
    mutationFn: async () => {
      if (!community) throw new Error("No community.");
      await updateList({ type: "remove", communityId: bytesToHex(community.id) });
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
      if (community.proto === "cord") {
        throw new Error("Deleting an experimental community isn't supported yet.");
      }
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
