import { useNostr } from "@nostrify/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import {
  citationFor,
  invalidateControl2,
  publishEdition2,
  useControlFold2,
} from "@/concord-v2/hooks/useControlPlane2";
import { buildEditionRumor } from "@/concord-v2/lib/edition";
import { bytesToHex, pinsLocator } from "@/concord-v2/lib/derive";
import { VSK_PINS } from "@/concord-v2/lib/kinds";
import {
  PIN_MAX_CONTENT_BYTES,
  PIN_MAX_ENTRIES,
  buildPinEntry,
  readPinList,
  serializePublicPinList,
  serializeSealedPinList,
  verifyPinEntry,
  type PinEntry,
  type VerifiedPin,
} from "@/concord-v2/lib/pins";
import { isAuthorized, Permissions } from "@/concord-v2/lib/roles";
import type { OpenedEvent } from "@/concord-v2/lib/stream";
import type { ChannelV2, CommunityV2 } from "@/concord-v2/lib/types";
import { useCurrentUser } from "@/hooks/useCurrentUser";

/**
 * A Channel's pins (CORD-04 §7).
 *
 * The list rides the Control Plane, so compaction carries it across every
 * rotation and a member who joined yesterday reads pins written years ago with
 * none of that history's keys. Every rendered pin has been VERIFIED here — the
 * seal's signature, the MAC under the disclosed keys, the decryption, the
 * author equality, and the channel binding — so the UI never displays an
 * unproven claim about who said what.
 */
export function usePins2(community: CommunityV2 | undefined, channel: ChannelV2 | undefined) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  const { data: folded } = useControlFold2(community);

  const eidHex = useMemo(
    () => (community && channel ? bytesToHex(pinsLocator(community.id, channel.id)) : undefined),
    [community, channel],
  );
  const head = eidHex ? folded?.pinLists.get(eidHex) : undefined;

  /** Verified pins, newest first. Memoized on the raw content: verification is
   *  a signature + MAC + decrypt per entry, far too costly to redo per render. */
  const pins = useMemo<VerifiedPin[]>(() => {
    if (!head || !channel) return [];
    const { entries } = readList(head.content, channel);
    const out: VerifiedPin[] = [];
    for (const entry of entries) {
      const verified = verifyPinEntry(entry, channel.idHex);
      if (verified) out.push(verified); // a failed entry is dropped ALONE
    }
    return out.sort((a, b) => b.ms - a.ms);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [head?.content, channel?.idHex, channel?.streams.length]);

  /** Whether the list exists but is sealed under an epoch key we never held. */
  const dark = useMemo(() => {
    if (!head || !channel) return false;
    return readList(head.content, channel).sealed;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [head?.content, channel?.idHex, channel?.streams.length]);

  const canPin = Boolean(
    user && folded && isAuthorized(folded.roster, user.pubkey, folded.ownerHex, Permissions.PIN_MESSAGES),
  );

  /** Publish the list, replaced entire — the only write shape (§7). */
  const publish = async (entries: PinEntry[]) => {
    if (!user || !community || !channel || !eidHex) throw new Error("Not ready.");
    const content = channel.isPrivate
      ? serializeSealedPinList(entries, channel.current.group.convKey, channel.current.epoch)
      : serializePublicPinList(entries);
    const prior = folded?.heads.get(eidHex);
    await publishEdition2(
      nostr,
      community,
      user.signer,
      buildEditionRumor({
        vsk: VSK_PINS,
        entityId: pinsLocator(community.id, channel.id),
        content,
        actorPubkey: user.pubkey,
        version: prior ? prior.version + 1n : 1n,
        prevHash: prior?.hash,
        authority: citationFor(community, folded, user.pubkey),
      }),
    );
    if (community) invalidateControl2(queryClient, community.idHex);
  };

  const pin = useMutation<void, Error, { opened: OpenedEvent }>({
    mutationFn: async ({ opened }) => {
      if (!channel) throw new Error("Not ready.");
      if (pins.length >= PIN_MAX_ENTRIES) {
        throw new Error(`This channel already has ${PIN_MAX_ENTRIES} pins. Unpin one first.`);
      }
      // The epoch the message was written under — its keys, not today's.
      const epoch = epochOf(opened);
      const stream = channel.streams.find((s) => (epoch === undefined ? false : s.epoch === epoch)) ?? channel.current;
      const entry = buildPinEntry(opened, stream.group.convKey);
      if (!entry) throw new Error("This message can't be proven — it may be from an epoch you no longer hold.");
      if (pins.some((p) => p.rumorId === opened.rumorId)) return; // already pinned
      await publish([entry, ...pins.map((p) => p.entry)]);
    },
  });

  const unpin = useMutation<void, Error, { rumorId: string }>({
    mutationFn: async ({ rumorId }) => {
      await publish(pins.filter((p) => p.rumorId !== rumorId).map((p) => p.entry));
    },
  });

  /**
   * Drop an entry an author erased (§7). Separate from `unpin` so the caller
   * can express the obligation rather than a curator's choice — the pinner
   * publishes at once, other holders jitter and re-check first.
   */
  const omitDeleted = async (rumorIds: ReadonlySet<string>) => {
    const survivors = pins.filter((p) => !rumorIds.has(p.rumorId));
    if (survivors.length === pins.length) return;
    await publish(survivors.map((p) => p.entry));
  };

  return {
    pins,
    /** The list is sealed under an epoch we never held — pins exist but are unreadable. */
    dark,
    canPin,
    isPinned: (rumorId: string) => pins.some((p) => p.rumorId === rumorId),
    pin: pin.mutateAsync,
    isPinning: pin.isPending,
    unpin: unpin.mutateAsync,
    isUnpinning: unpin.isPending,
    omitDeleted,
    /** Remaining budget, which is the real ceiling for a private channel (§7). */
    remaining: { entries: Math.max(0, PIN_MAX_ENTRIES - pins.length), bytes: PIN_MAX_CONTENT_BYTES },
  };
}

/** Decode a list, handing it the key for whichever epoch it was sealed at. */
function readList(content: string, channel: ChannelV2) {
  return readPinList(content, (epoch) => channel.streams.find((s) => s.epoch === epoch)?.group.convKey);
}

function epochOf(opened: OpenedEvent): bigint | undefined {
  for (const t of opened.tags) {
    if (t[0] === "epoch" && /^(0|[1-9][0-9]*)$/.test(t[1] ?? "")) return BigInt(t[1]);
  }
  return undefined;
}
