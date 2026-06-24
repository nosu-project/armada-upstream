import { bytesToHex } from "@noble/hashes/utils.js";
import { useNostr } from "@nostrify/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useConcordList, useUpdateConcordList } from "@/hooks/useConcordList";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import type { ConcordCommunity, ConcordInvite, ConcordKeyBundle } from "@/lib/concord";
import {
  buildChannelMetadataEditionUnsigned,
  buildCommunityRootEditionUnsigned,
  buildRoleEditionUnsigned,
  sealControlEdition,
} from "@/lib/concord/control";
import { acceptInvite, buildInvite } from "@/lib/concord/invite";
import { KIND_APPLICATION_SPECIFIC } from "@/lib/concord/kinds";
import { communityMetadataOf } from "@/lib/concord/metadata";
import {
  buildOwnerAttestationUnsigned,
} from "@/lib/concord/owner";
import { locatorHex, parseInviteUrl, parsePublicInviteEvent, signerPubkey } from "@/lib/concord/publicInvite";
import { adminRole, type Role } from "@/lib/concord/roles";
import { createCommunity as mintCommunity, random32, type Channel, type Community } from "@/lib/concord/types";
import { APP_RELAYS } from "@/lib/platform";

/** A preview of where an invite leads, resolved before actually joining. */
export interface ConcordInvitePreview {
  community: ConcordCommunity;
  channelCount: number;
}

/**
 * The real Concord create/join actions, wired to app relays + the membership
 * list. Concord communities are serverless, so they ride the app-relay pool
 * (never the NIP-29 platform relay). Joining/creating writes the resulting key
 * bundle into the kind-30078 membership list (`useConcordList`), the only
 * durable record of Concord membership.
 *
 * This is the concrete implementation behind the wizard's "start" / "join"
 * branches — replacing the pure-protocol stub in `concord.ts` with the I/O-bound
 * version that fetches the sealed invite bundle and publishes the owner
 * attestation.
 */
export function useConcordActions() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { mutateAsync: updateList } = useUpdateConcordList();
  const queryClient = useQueryClient();
  const list = useConcordList();

  /** The app relays a Concord community should gather on (deployment-configurable). */
  const relays = APP_RELAYS;

  /** Snapshot a live Community into the membership-list key bundle. */
  function toBundle(c: Community, epoch = Number(c.serverRootEpoch)): ConcordKeyBundle {
    return {
      communityId: bytesToHex(c.id),
      epoch,
      name: c.name,
      relays: c.relays,
      keys: {
        // The full invite bundle is the rehydration payload (carries channel keys).
        invite: buildInvite(c),
      },
    };
  }

  function toCommunity(c: Community): ConcordCommunity {
    return { communityId: bytesToHex(c.id), name: c.name, about: c.description, relays: c.relays };
  }

  /**
   * Resolve an invite to its live {@link Community} without joining: decode the
   * token, fetch the sealed bundle from the bootstrap relays, then decrypt +
   * verify it (rejecting impostor/revoked invites). Shared by the preview (look
   * before you leap) and the actual join.
   */
  async function resolveInvite(invite: ConcordInvite): Promise<Community> {
    // `invite.token` is the raw `#fragment`; decode it to the real 32-byte
    // token + bootstrap relays via the v2 fragment parser.
    let tokenBytes: Uint8Array;
    let bootstrapRelays: string[];
    try {
      const parsed = parseInviteUrl(invite.token);
      tokenBytes = parsed.token;
      bootstrapRelays = parsed.relays;
    } catch {
      throw new Error("Invalid invite link.");
    }

    // Fetch the sealed bundle from the token's locator on the bootstrap relays.
    const locator = locatorHex(tokenBytes);
    const author = signerPubkey(tokenBytes);
    const pool = bootstrapRelays.length ? bootstrapRelays : relays;
    const events = await Promise.all(
      pool.map((url) =>
        nostr
          .relay(url)
          .query(
            [{ kinds: [KIND_APPLICATION_SPECIFIC], authors: [author], "#d": [locator], limit: 1 }],
            { signal: AbortSignal.timeout(8000) },
          )
          .catch(() => []),
      ),
    );
    const flat = events.flat().sort((a, b) => b.created_at - a.created_at);
    if (flat.length === 0) throw new Error("Couldn't find that invite on its relays.");

    // Decrypt + verify the bundle with the token (rejects impostor/revoked).
    const bundle = parsePublicInviteEvent(flat[0], tokenBytes);
    return acceptInvite(bundle.join);
  }

  /** Look up an invite's community (name, channels, relays) without joining. */
  const preview = useMutation<ConcordInvitePreview, Error, { invite: ConcordInvite }>({
    mutationFn: async ({ invite }) => {
      const community = await resolveInvite(invite);
      return { community: toCommunity(community), channelCount: community.channels.length };
    },
  });

  const create = useMutation<ConcordCommunity, Error, { name: string }>({
    mutationFn: async ({ name }) => {
      if (!user) throw new Error("Sign in to start an encrypted chat.");
      const community = mintCommunity(name.trim(), "general", relays);

      // Sign the owner attestation with the user's identity signer (works with
      // bunker/NIP-46 — it's an ordinary event), then publish it to app relays.
      const cidHex = bytesToHex(community.id);
      const unsigned = buildOwnerAttestationUnsigned(cidHex);
      // The signer may be local or remote; both produce a signed event.
      const signed = user.signer.nip44
        ? await user.signer.signEvent({
            kind: unsigned.kind,
            content: unsigned.content,
            tags: unsigned.tags,
            created_at: unsigned.created_at,
          })
        : null;
      if (!signed) throw new Error("A signer is required to create a community.");
      community.ownerAttestation = JSON.stringify(signed);
      await nostr.event(signed, { signal: AbortSignal.timeout(8000) }).catch(() => {});

      // Publish the genesis control plane (owner-signed, server-root-sealed):
      // the GroupRoot metadata (vsk=0), an auto Admin role (vsk=1), and one
      // ChannelMetadata edition (vsk=2) per channel. This anchors the control
      // plane at mint so members fold authoritative metadata/roles from the
      // start, instead of the Admin role being minted lazily on first grant.
      await publishGenesisControlPlane(community);

      await updateList({ bundle: toBundle(community), type: "add" });
      return toCommunity(community);
    },
  });

  /** Sign + seal + publish the genesis vsk=0/1/2 control editions for a freshly minted community. */
  async function publishGenesisControlPlane(community: Community): Promise<void> {
    if (!user) return;
    const now = Math.floor(Date.now() / 1000);
    const signer = user.signer;

    const seal = async (unsigned: { kind: number; content: string; tags: string[][]; created_at: number }) => {
      const inner = await signer.signEvent(unsigned);
      return sealControlEdition(inner, community.serverRootKey, community.id, community.serverRootEpoch);
    };

    const role: Role = adminRole(bytesToHex(random32()));
    const editions = await Promise.all([
      seal(
        buildCommunityRootEditionUnsigned({
          communityId: community.id,
          metadata: communityMetadataOf(community),
          version: 1n,
          createdAtSecs: now,
        }),
      ),
      seal(buildRoleEditionUnsigned({ role, version: 1n, createdAtSecs: now })),
      ...community.channels.map((ch) =>
        seal(
          buildChannelMetadataEditionUnsigned({
            channelId: ch.id,
            metadata: { name: ch.name },
            version: 1n,
            createdAtSecs: now,
          }),
        ),
      ),
    ]);

    await Promise.all(
      editions.flatMap((outer) =>
        community.relays.map((url) =>
          nostr.relay(url).event(outer, { signal: AbortSignal.timeout(8000) }).catch(() => {}),
        ),
      ),
    );
  }

  const join = useMutation<ConcordCommunity, Error, { invite: ConcordInvite }>({
    mutationFn: async ({ invite }) => {
      if (!user) throw new Error("Sign in to join an encrypted chat.");
      const community = await resolveInvite(invite);
      await updateList({ bundle: toBundle(community), type: "add" });
      return toCommunity(community);
    },
  });

  /**
   * Add a channel to an existing community: mint a fresh random channel key+id,
   * append it, and persist by refreshing the membership-list bundle (which
   * carries every channel key). The new channel needs no on-relay event — it
   * exists as soon as members hold its key; the first message creates its
   * presence on the relays. Since only the local member's list is updated here,
   * other members learn the channel when the owner re-shares an invite (the MVP
   * grants the full channel set); per-member channel-grant editions are the
   * natural next step.
   */
  const createChannel = useMutation<Community, Error, { community: Community; name: string }>({
    mutationFn: async ({ community, name }) => {
      if (!user) throw new Error("Sign in to add a channel.");
      const trimmed = name.trim();
      if (!trimmed) throw new Error("Channel name is required.");

      const newChannel: Channel = {
        id: random32(),
        key: random32(),
        epoch: 0n,
        name: trimmed,
        epochKeys: [],
      };
      const updated: Community = { ...community, channels: [...community.channels, newChannel] };

      await updateList({ type: "refresh-current", current: toBundle(updated) });
      return updated;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["concord", "list"] });
    },
  });

  return {
    createCommunity: create.mutateAsync,
    previewInvite: preview.mutateAsync,
    joinViaInvite: join.mutateAsync,
    createChannel: createChannel.mutateAsync,
    isWorking: create.isPending || join.isPending,
    isPreviewing: preview.isPending,
    isAddingChannel: createChannel.isPending,
    communities: (list.data?.list.entries ?? []).map((e) => ({
      communityId: e.communityId,
      name: e.current.name,
      relays: e.current.relays,
    })),
  };
}
