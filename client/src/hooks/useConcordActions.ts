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
import { isExpired, locatorHex, parseInviteUrl, parsePublicInviteEvent, signerPubkey } from "@/lib/concord/publicInvite";
import { adminRole, type Role } from "@/lib/concord/roles";
import { createCommunity as mintCommunity, random32, type Channel, type Community } from "@/lib/concord/types";
import { acceptCordInvite, buildCordInvite, mintCordCommunity } from "@/lib/cord/community";
import {
  buildCordChannelMetadataRumor,
  buildCordCommunityRootRumor,
  buildCordRoleRumor,
  cordControlGroups,
} from "@/lib/cord/control";
import { cordLocatorHex, cordSignerPubkey, isCordBundleExpired, parseCordInviteEvent } from "@/lib/cord/invite";
import { buildSealTemplate, finalizeRumor, wrapSeal } from "@/lib/cord/stream";
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
      keys:
        c.proto === "cord"
          ? // The CORD rehydration payload (list-only: prior roots included).
            { cord: buildCordInvite(c, { includePriorRoots: true }) }
          : {
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
   * before you leap) and the actual join. The fragment version selects the
   * protocol: v1/v2 fragments resolve a Vector-parity bundle, v3 a CORD one —
   * joining either works without any opt-in (only GENERATION is gated).
   */
  async function resolveInvite(invite: ConcordInvite): Promise<Community> {
    // `invite.token` is the raw `#fragment`; decode it to the real 32-byte
    // token + bootstrap relays via the fragment parser.
    let tokenBytes: Uint8Array;
    let bootstrapRelays: string[];
    let proto: "v1" | "cord";
    try {
      const parsed = parseInviteUrl(invite.token);
      tokenBytes = parsed.token;
      bootstrapRelays = parsed.relays;
      proto = parsed.proto;
    } catch {
      throw new Error("Invalid invite link.");
    }

    // Fetch the sealed bundle from the token's locator on the bootstrap relays.
    const locator = proto === "cord" ? cordLocatorHex(tokenBytes) : locatorHex(tokenBytes);
    const author = proto === "cord" ? cordSignerPubkey(tokenBytes) : signerPubkey(tokenBytes);
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
    const nowSecs = Math.floor(Date.now() / 1000);
    if (proto === "cord") {
      const bundle = parseCordInviteEvent(flat[0], tokenBytes);
      if (isCordBundleExpired(bundle, nowSecs)) {
        throw new Error("This invite link has expired.");
      }
      return acceptCordInvite(bundle.join);
    }
    const bundle = parsePublicInviteEvent(flat[0], tokenBytes);
    if (isExpired(bundle, nowSecs)) {
      throw new Error("This invite link has expired.");
    }
    return acceptInvite(bundle.join);
  }

  /** Look up an invite's community (name, channels, relays) without joining. */
  const preview = useMutation<ConcordInvitePreview, Error, { invite: ConcordInvite }>({
    mutationFn: async ({ invite }) => {
      const community = await resolveInvite(invite);
      return { community: toCommunity(community), channelCount: community.channels.length };
    },
  });

  const create = useMutation<ConcordCommunity, Error, { name: string; experimental?: boolean }>({
    mutationFn: async ({ name, experimental }) => {
      if (!user) throw new Error("Sign in to start an encrypted chat.");

      // EXPLICIT OPT-IN: the experimental CORD wire is chosen per community at
      // creation and is immutable — every other community (and its invite
      // links) stays byte-compatible with Concord/Vector v1.
      if (experimental) {
        const community = mintCordCommunity(name.trim(), "general", relays, user.pubkey);
        // No attestation event: the community id itself commits to the owner.
        // The owner-signed genesis control plane proves secret-key possession.
        await publishCordGenesis(community);
        await updateList({ bundle: toBundle(community), type: "add" });
        return toCommunity(community);
      }

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

  /**
   * Sign + seal + publish the genesis control plane for a fresh CORD
   * community: the owner-sealed GroupRoot (whose seal signature is the
   * secret-key possession proof, CORD-02 §1), an auto Admin role, and one
   * ChannelMetadata rumor per channel — each a stream event at the control
   * address.
   */
  async function publishCordGenesis(community: Community): Promise<void> {
    if (!user) return;
    const now = Math.floor(Date.now() / 1000);
    const [group] = cordControlGroups(community);

    const seal = async (rumorTemplate: { kind: number; content: string; tags: string[][]; created_at: number }) => {
      const rumor = finalizeRumor(rumorTemplate, user.pubkey);
      const signedSeal = await user.signer.signEvent(buildSealTemplate(rumor, group.group));
      return wrapSeal(signedSeal, group.group);
    };

    const role: Role = adminRole(bytesToHex(random32()));
    const editions = await Promise.all([
      seal(
        buildCordCommunityRootRumor({
          communityId: community.id,
          metadata: communityMetadataOf(community),
          version: 1n,
          createdAtSecs: now,
        }),
      ),
      seal(buildCordRoleRumor({ role, version: 1n, createdAtSecs: now })),
      ...community.channels.map((ch) =>
        seal(
          buildCordChannelMetadataRumor({
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
   * Add a channel to an existing community. v1: mint a fresh random channel
   * key+id, append it to the local membership-list bundle, AND publish a
   * ChannelMetadata (vsk=2) control edition so the channel's name is
   * authoritative and discoverable to every member on the control plane. The
   * channel KEY still rides to members via an invite re-share (channel keys
   * can't go on the server-root-readable control plane).
   *
   * CORD: a new channel is PUBLIC (derived from the CommunityRoot, CORD-03),
   * so the control edition alone makes it fully joinable by every member — no
   * key delivery at all. Every member materializes it from the fold.
   */
  const createChannel = useMutation<Community, Error, { community: Community; name: string }>({
    mutationFn: async ({ community, name }) => {
      if (!user) throw new Error("Sign in to add a channel.");
      const trimmed = name.trim();
      if (!trimmed) throw new Error("Channel name is required.");

      const isCord = community.proto === "cord";
      const newChannel: Channel = isCord
        ? {
            id: random32(),
            key: community.serverRootKey,
            epoch: community.serverRootEpoch,
            name: trimmed,
            epochKeys: [],
            derived: true,
          }
        : {
            id: random32(),
            key: random32(),
            epoch: 0n,
            name: trimmed,
            epochKeys: [],
          };
      const updated: Community = { ...community, channels: [...community.channels, newChannel] };

      // Publish the channel-metadata edition (owner/MANAGE_CHANNELS signs).
      const now = Math.floor(Date.now() / 1000);
      let outer;
      if (isCord) {
        const [group] = cordControlGroups(community);
        const rumor = finalizeRumor(
          buildCordChannelMetadataRumor({
            channelId: newChannel.id,
            metadata: { name: trimmed, private: false },
            version: 1n,
            createdAtSecs: now,
          }),
          user.pubkey,
        );
        const seal = await user.signer.signEvent(buildSealTemplate(rumor, group.group));
        outer = wrapSeal(seal, group.group);
      } else {
        const inner = await user.signer.signEvent(
          buildChannelMetadataEditionUnsigned({
            channelId: newChannel.id,
            metadata: { name: trimmed },
            version: 1n,
            createdAtSecs: now,
          }),
        );
        outer = sealControlEdition(inner, community.serverRootKey, community.id, community.serverRootEpoch);
      }
      await Promise.all(
        community.relays.map((url) =>
          nostr.relay(url).event(outer, { signal: AbortSignal.timeout(8000) }).catch(() => {}),
        ),
      );

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
