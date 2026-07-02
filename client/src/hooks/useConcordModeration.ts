import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { useNostr } from "@nostrify/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { useConcordControlEvents, useConcordRoster } from "@/hooks/useConcordRoster";
import { useConcordMetadata } from "@/hooks/useConcordMetadata";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useDeferredFold } from "@/hooks/useDeferredFold";
import { useRotatorSecretKey } from "@/hooks/useRotatorSecretKey";
import { useUpdateConcordList } from "@/hooks/useConcordList";
import { cordBundleOf, publishChannelRekey, publishCordBaseRekey, publishCordChannelRekey } from "@/hooks/useConcordRekey";
import {
  buildBanlistEditionUnsigned,
  foldBanlist,
  sealControlEdition,
  VSK_GRANT,
  VSK_ROLE,
} from "@/lib/concord/control";
import { banlistLocator } from "@/lib/concord/derive";
import { buildInvite } from "@/lib/concord/invite";
import { KIND_COMMUNITY_DELETE, KIND_COMMUNITY_KICK } from "@/lib/concord/kinds";
import { communityMetadataOf } from "@/lib/concord/metadata";
import { canActOnMember, grantToJSON, roleToJSON, Permissions } from "@/lib/concord/roles";
import { channelWire } from "@/lib/concord/wire";
import type { Community } from "@/lib/concord/types";
import {
  buildCordBanlistRumor,
  buildCordChannelMetadataRumor,
  buildCordCommunityRootRumor,
  buildCordEditionRumor,
  cordControlGroups,
  foldCordBanlist,
} from "@/lib/cord/control";
import { cordBanlistLocator, cordGrantLocator } from "@/lib/cord/derive";
import { buildSealTemplate, finalizeRumor, wrapSeal } from "@/lib/cord/stream";
import { hex32 } from "@/lib/concord/types";
import type { ConcordKeyBundle } from "@/lib/concord";
import type { NostrEvent } from "@nostrify/nostrify";

/** Read the community's folded banlist (vsk=4). Folds the SHARED control-plane fetch. */
export function useConcordBanlist(community: Community | undefined) {
  const control = useConcordControlEvents(community);
  const roster = useConcordRoster(community);
  const events = control.data;
  const folded = roster.data;

  // Deferred fold (after paint) + persisted snapshot, so the banlist's
  // decrypt+verify pass doesn't block the channel's first frame.
  const data = useDeferredFold(
    community ? `banlist:${bytesToHex(community.id)}` : null,
    () =>
      community && events && folded
        ? community.proto === "cord"
          ? foldCordBanlist(events, community, folded)
          : foldBanlist(events, community.serverRootKey, community.id, folded.roster, folded.ownerHex)
        : undefined,
    [community, events, folded],
  );

  return { ...control, data } as typeof control & {
    data: { banned: Set<string>; head?: { version: bigint; hash: Uint8Array } } | undefined;
  };
}

/**
 * Moderation actions for a Concord community: ban (with cryptographic read-cut),
 * unban, kick (cooperative), and moderation-hide. Authority is enforced locally
 * before acting (`canActOnMember`) and re-verified by every member's fold/apply,
 * so an unauthorized action is dropped network-wide.
 *
 * `recipients` is the set of pubkeys (hex) that should KEEP access after a ban —
 * typically the current participants/roster minus the banned member. The caller
 * (ConcordPage) supplies it from the same source it builds the member list from.
 *
 * The read-cut differs per wire: a v1 ban rotates every channel key; a CORD ban
 * is a REFOUNDING (CORD-06 §3) — the CommunityRoot itself rolls (severing the
 * control plane and every derived public channel at once), private channels
 * rekey, and the owner re-anchors the control state under the new epoch.
 */
export function useConcordModeration(community: Community | undefined, recipients: string[]) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const rotatorSkHex = useRotatorSecretKey();
  const roster = useConcordRoster(community);
  const metadata = useConcordMetadata(community);
  const banlist = useConcordBanlist(community);
  const { mutateAsync: updateList } = useUpdateConcordList();
  const queryClient = useQueryClient();

  const ownerHex = roster.data?.ownerHex;

  const invalidate = () => {
    if (!community) return;
    const cid = bytesToHex(community.id);
    queryClient.invalidateQueries({ queryKey: ["concord", "control", cid] });
    queryClient.invalidateQueries({ queryKey: ["concord", "list"] });
    queryClient.invalidateQueries({ queryKey: ["concord", "epochs"] });
  };

  /** Can the current user act on `target` with `permission`? */
  const canActOn = (target: string, permission: bigint): boolean =>
    Boolean(user && roster.data && canActOnMember(roster.data.roster, user.pubkey, ownerHex, target, permission));

  /** Directive wire: kicks/hides ride the first channel's append plane. */
  const directiveWire = useMemo(() => {
    const channel = community?.channels[0];
    return community && channel ? channelWire(community, channel) : undefined;
  }, [community]);

  /** Publish a control edition to the community relays (proto-aware seal). */
  const publishControl = async (
    c: Community,
    unsigned: { kind: number; content: string; tags: string[][]; created_at: number },
  ) => {
    if (!user) throw new Error("Not ready.");
    let outer: NostrEvent;
    if (c.proto === "cord") {
      const [group] = cordControlGroups(c);
      const rumor = finalizeRumor(unsigned, user.pubkey);
      const seal = await user.signer.signEvent(buildSealTemplate(rumor, group.group));
      outer = wrapSeal(seal, group.group);
    } else {
      const inner = await user.signer.signEvent(unsigned);
      outer = sealControlEdition(inner, c.serverRootKey, c.id, c.serverRootEpoch);
    }
    await Promise.all(
      c.relays.map((url) => nostr.relay(url).event(outer, { signal: AbortSignal.timeout(8000) }).catch(() => {})),
    );
  };

  /** The proto-correct unsigned banlist edition. */
  const banlistEditionFor = (c: Community, banned: string[], version: bigint, prevHash?: Uint8Array) => {
    const now = Math.floor(Date.now() / 1000);
    return c.proto === "cord"
      ? buildCordBanlistRumor({ communityId: c.id, banned, version, prevHash, createdAtSecs: now })
      : buildBanlistEditionUnsigned({ communityId: c.id, banned, version, prevHash, createdAtSecs: now });
  };

  /** Publish a sealed channel-scoped directive (kick/hide) on the channel wire. */
  const publishDirective = async (kind: number, content: string, targetMessageOrPubkey: string) => {
    if (!user || !community || !directiveWire) throw new Error("Not ready.");
    const { outer } = await directiveWire.send(user.signer, user.pubkey, {
      kind,
      content,
      ms: Date.now(),
      extraTags: [["e", targetMessageOrPubkey]],
    });
    await Promise.all(
      community.relays.map((url) => nostr.relay(url).event(outer, { signal: AbortSignal.timeout(8000) }).catch(() => {})),
    );
  };

  /** Rebuild + persist the community bundle after advancing epochs. */
  const persistRekeyed = async (rotated: Community) => {
    const bundle: ConcordKeyBundle =
      rotated.proto === "cord"
        ? cordBundleOf(rotated)
        : {
            communityId: bytesToHex(rotated.id),
            epoch: Number(rotated.serverRootEpoch),
            name: rotated.name,
            relays: rotated.relays,
            keys: { invite: buildInvite(rotated) },
          };
    await updateList({ type: "refresh-current", current: bundle });
  };

  /**
   * The CORD read-cut: a Refounding (CORD-06 §3). Roll the CommunityRoot via a
   * base rekey to everyone but the target, rekey private channels under the new
   * root, then re-anchor the control plane (continuation editions re-published
   * by the refounder at the new control address, so both old members and fresh
   * joiners fold the same heads). Owner-only in this core rollout — the
   * re-anchor re-issues every entity under the refounder's own authority.
   */
  const refoundCord = async (target: string, rotatorSk: Uint8Array, nextBanned: string[]) => {
    if (!community || !user) throw new Error("Not ready.");
    const keep = recipients.filter((pk) => pk !== target && pk !== user.pubkey);
    const recipientSet = [...new Set([user.pubkey, ...keep])];

    // 1. Roll the base (blobs at the prior-root base-rekey address).
    const { newRoot, newEpoch } = await publishCordBaseRekey(nostr, community, rotatorSk, recipientSet);

    // 2. Rekey private channels under the NEW root; derived channels follow it.
    const rotatedChannels = await Promise.all(
      community.channels.map(async (ch) => {
        if (ch.derived) return { ...ch, key: newRoot, epoch: newEpoch };
        const newKey = await publishCordChannelRekey(nostr, community, ch, newRoot, rotatorSk, recipientSet);
        const chEpoch = ch.epoch + 1n;
        return {
          ...ch,
          key: newKey,
          epoch: chEpoch,
          epochKeys: [{ epoch: chEpoch, key: newKey }, ...ch.epochKeys, { epoch: ch.epoch, key: ch.key }],
        };
      }),
    );

    const refounded: Community = {
      ...community,
      serverRootKey: newRoot,
      serverRootEpoch: newEpoch,
      priorRoots: [
        { epoch: community.serverRootEpoch, key: community.serverRootKey },
        ...(community.priorRoots ?? []),
      ],
      channels: rotatedChannels,
    };

    // 3. Re-anchor the control plane at the new control address: continuation
    //    editions for the GroupRoot, every role, every surviving grant, each
    //    channel's metadata, and the banlist (now including the target).
    const now = Math.floor(Date.now() / 1000);
    const heads = new Map([...(roster.data?.heads ?? []), ...(metadata.data?.heads ?? [])]);
    const nextVersion = (entityHex: string) => {
      const head = heads.get(entityHex);
      return { version: head ? head.version + 1n : 1n, prevHash: head?.hash };
    };

    const editions: Array<{ kind: number; content: string; tags: string[][]; created_at: number }> = [];

    const rootMeta = metadata.data?.root ?? communityMetadataOf(refounded);
    editions.push(
      buildCordCommunityRootRumor({
        communityId: refounded.id,
        metadata: { ...rootMeta, owner: refounded.owner, owner_salt: refounded.ownerSalt },
        ...nextVersion(bytesToHex(refounded.id)),
        createdAtSecs: now,
      }),
    );
    for (const role of roster.data?.roster.roles ?? []) {
      editions.push(
        buildCordEditionRumor({
          vsk: VSK_ROLE,
          entityId: hex32(role.roleId),
          content: roleToJSON(role),
          ...nextVersion(role.roleId),
          createdAtSecs: now,
        }),
      );
    }
    for (const grant of roster.data?.roster.grants ?? []) {
      const entity = cordGrantLocator(refounded.id, hex32(grant.member));
      const surviving = grant.member === target ? { ...grant, roleIds: [] } : grant;
      editions.push(
        buildCordEditionRumor({
          vsk: VSK_GRANT,
          entityId: entity,
          content: grantToJSON(surviving),
          ...nextVersion(bytesToHex(entity)),
          createdAtSecs: now,
        }),
      );
    }
    for (const ch of refounded.channels) {
      editions.push(
        buildCordChannelMetadataRumor({
          channelId: ch.id,
          metadata: ch.derived ? { name: ch.name } : { name: ch.name, private: true },
          ...nextVersion(bytesToHex(ch.id)),
          createdAtSecs: now,
        }),
      );
    }
    editions.push(
      (() => {
        const v = nextVersion(bytesToHex(cordBanlistLocator(refounded.id)));
        return banlistEditionFor(refounded, nextBanned, v.version, v.prevHash);
      })(),
    );

    for (const unsigned of editions) {
      await publishControl(refounded, unsigned);
    }

    await persistRekeyed(refounded);
  };

  /**
   * Ban a member: add them to the banlist (vsk=4), then perform a read-cut —
   * v1: a fresh epoch key for every channel; CORD: a full Refounding — so the
   * banned member keeps the relay header but recovers no new key. Requires the
   * rotator's raw secret key (local nsec); a bunker/extension signer can
   * publish the banlist but cannot rekey (Vector's constraint). A CORD
   * refounding is additionally owner-only (the control re-anchor re-issues the
   * roster under the refounder's authority).
   */
  const ban = useMutation<{ rekeyed: boolean }, Error, { target: string }>({
    mutationFn: async ({ target }) => {
      if (!user || !community) throw new Error("Not ready.");
      if (!canActOn(target, Permissions.BAN)) throw new Error("You don't have permission to ban this member.");

      // 1. Append to the banlist (version-chained).
      const current = banlist.data?.banned ?? new Set<string>();
      const next = new Set(current);
      next.add(target);
      const head = banlist.data?.head;

      if (community.proto === "cord") {
        // CORD: the read-cut is a Refounding, which re-publishes the banlist
        // (and everything else) under the NEW root — owner + raw-nsec only.
        const canRefound = Boolean(rotatorSkHex) && user.pubkey === ownerHex;
        if (!canRefound) {
          await publishControl(community, banlistEditionFor(community, [...next], head ? head.version + 1n : 1n, head?.hash));
          return { rekeyed: false };
        }
        await refoundCord(target, hexToBytes(rotatorSkHex!), [...next]);
        return { rekeyed: true };
      }

      await publishControl(community, banlistEditionFor(community, [...next], head ? head.version + 1n : 1n, head?.hash));

      // 2. Read-cut: rotate every channel to a new epoch excluding the target.
      if (!rotatorSkHex) {
        // Banlist published, but this signer can't rekey — surface that.
        return { rekeyed: false };
      }
      const rotatorSk = hexToBytes(rotatorSkHex);
      const keep = recipients.filter((pk) => pk !== target && pk !== user.pubkey);
      // Always include the rotator so they keep reading.
      const recipientSet = [...new Set([user.pubkey, ...keep])];

      const rotatedChannels = await Promise.all(
        community.channels.map(async (ch) => {
          const newKey = await publishChannelRekey(nostr, community, ch, rotatorSk, recipientSet);
          const newEpoch = ch.epoch + 1n;
          return {
            ...ch,
            key: newKey,
            epoch: newEpoch,
            epochKeys: [{ epoch: newEpoch, key: newKey }, ...ch.epochKeys, { epoch: ch.epoch, key: ch.key }],
          };
        }),
      );
      await persistRekeyed({ ...community, channels: rotatedChannels });
      return { rekeyed: true };
    },
    onSuccess: invalidate,
  });

  const unban = useMutation<void, Error, { target: string }>({
    mutationFn: async ({ target }) => {
      if (!user || !community) throw new Error("Not ready.");
      if (!canActOn(target, Permissions.BAN)) throw new Error("You don't have permission.");
      const next = new Set(banlist.data?.banned ?? []);
      next.delete(target);
      const head = banlist.data?.head;
      await publishControl(community, banlistEditionFor(community, [...next], head ? head.version + 1n : 1n, head?.hash));
    },
    onSuccess: invalidate,
  });

  /** Kick a member (cooperative 3309): honest clients drop them; not a rekey. */
  const kick = useMutation<void, Error, { target: string }>({
    mutationFn: async ({ target }) => {
      if (!canActOn(target, Permissions.KICK)) throw new Error("You don't have permission to kick this member.");
      await publishDirective(KIND_COMMUNITY_KICK, target, target);
    },
    onSuccess: invalidate,
  });

  /** Moderation-hide another member's message (3305 / CORD kind-5 with authority). */
  const hideMessage = useMutation<void, Error, { messageId: string; author: string }>({
    mutationFn: async ({ messageId, author }) => {
      if (!canActOn(author, Permissions.MANAGE_MESSAGES)) {
        throw new Error("You don't have permission to hide this message.");
      }
      await publishDirective(KIND_COMMUNITY_DELETE, "", messageId);
    },
    onSuccess: invalidate,
  });

  // A CORD refounding is owner-only (see refoundCord); v1 needs only the nsec.
  const canRekey =
    community?.proto === "cord"
      ? Boolean(rotatorSkHex) && Boolean(user && ownerHex && user.pubkey === ownerHex)
      : Boolean(rotatorSkHex);

  return {
    banned: banlist.data?.banned ?? new Set<string>(),
    canRekey,
    ban: ban.mutateAsync,
    isBanning: ban.isPending,
    unban: unban.mutateAsync,
    kick: kick.mutateAsync,
    isKicking: kick.isPending,
    hideMessage: hideMessage.mutateAsync,
    canBan: (target: string) => canActOn(target, Permissions.BAN),
    canKick: (target: string) => canActOn(target, Permissions.KICK),
    canHide: (author: string) => canActOn(author, Permissions.MANAGE_MESSAGES),
  };
}

/** Locator (for callers that need the banlist entity id hex). */
export function banlistEntityHex(community: Community): string {
  return bytesToHex(
    community.proto === "cord" ? cordBanlistLocator(community.id) : banlistLocator(community.id),
  );
}
