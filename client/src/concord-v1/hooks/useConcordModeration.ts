import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { useNostr } from "@nostrify/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { useConcordControlEvents, useConcordRoster } from "@/concord-v1/hooks/useConcordRoster";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useDeferredFold } from "@/concord-v1/hooks/useDeferredFold";
import { useRotatorSecretKey } from "@/concord-v1/hooks/useRotatorSecretKey";
import { useUpdateConcordList } from "@/concord-v1/hooks/useConcordList";
import { publishChannelRekey } from "@/concord-v1/hooks/useConcordRekey";
import {
  buildBanlistEditionUnsigned,
  foldBanlist,
  sealControlEdition,
} from "@/concord-v1/lib/control";
import { banlistLocator } from "@/concord-v1/lib/derive";
import { buildInvite } from "@/concord-v1/lib/invite";
import { KIND_COMMUNITY_DELETE, KIND_COMMUNITY_KICK } from "@/concord-v1/lib/kinds";
import { canActOnMember, Permissions } from "@/concord-v1/lib/roles";
import { channelWire } from "@/concord-v1/lib/wire";
import type { Community } from "@/concord-v1/lib/types";
import type { ConcordKeyBundle } from "@/concord-v1/lib/concord";
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
        ? foldBanlist(events, community.serverRootKey, community.id, folded.roster, folded.ownerHex)
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
 * The read-cut rotates every channel key so the banned member keeps the relay
 * header but recovers no new key.
 */
export function useConcordModeration(community: Community | undefined, recipients: string[]) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const rotatorSkHex = useRotatorSecretKey();
  const roster = useConcordRoster(community);
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

  /** Publish a control edition to the community relays. */
  const publishControl = async (
    c: Community,
    unsigned: { kind: number; content: string; tags: string[][]; created_at: number },
  ) => {
    if (!user) throw new Error("Not ready.");
    const inner = await user.signer.signEvent(unsigned);
    const outer: NostrEvent = sealControlEdition(inner, c.serverRootKey, c.id, c.serverRootEpoch);
    await Promise.all(
      c.relays.map((url) => nostr.relay(url).event(outer, { signal: AbortSignal.timeout(8000) }).catch(() => {})),
    );
  };

  /** The unsigned banlist edition. */
  const banlistEditionFor = (c: Community, banned: string[], version: bigint, prevHash?: Uint8Array) => {
    const now = Math.floor(Date.now() / 1000);
    return buildBanlistEditionUnsigned({ communityId: c.id, banned, version, prevHash, createdAtSecs: now });
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
    const bundle: ConcordKeyBundle = {
      communityId: bytesToHex(rotated.id),
      epoch: Number(rotated.serverRootEpoch),
      name: rotated.name,
      relays: rotated.relays,
      keys: { invite: buildInvite(rotated) },
    };
    await updateList({ type: "refresh-current", current: bundle });
  };

  /**
   * Ban a member: add them to the banlist (vsk=4), then perform a read-cut —
   * a fresh epoch key for every channel — so the banned member keeps the relay
   * header but recovers no new key. Requires the rotator's raw secret key
   * (local nsec); a bunker/extension signer can publish the banlist but cannot
   * rekey (Vector's constraint).
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

  /** Moderation-hide another member's message (3305 with authority). */
  const hideMessage = useMutation<void, Error, { messageId: string; author: string }>({
    mutationFn: async ({ messageId, author }) => {
      if (!canActOn(author, Permissions.MANAGE_MESSAGES)) {
        throw new Error("You don't have permission to hide this message.");
      }
      await publishDirective(KIND_COMMUNITY_DELETE, "", messageId);
    },
    onSuccess: invalidate,
  });

  const canRekey = Boolean(rotatorSkHex);

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
  return bytesToHex(banlistLocator(community.id));
}
