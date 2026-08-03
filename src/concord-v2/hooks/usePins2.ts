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
import { KIND_EDIT, VSK_PINS } from "@/concord-v2/lib/kinds";
import {
  PIN_MAX_CONTENT_BYTES,
  PIN_MAX_ENTRIES,
  buildPinEntryOrReason,
  readPinList,
  withProvenEdit,
  serializePublicPinList,
  serializeSealedPinList,
  verifyPinEntry,
  type PinBuildFailure,
  type PinEntry,
  type VerifiedPin,
} from "@/concord-v2/lib/pins";

const PIN_FAILURE_MESSAGE: Record<PinBuildFailure, string> = {
  "no-seal": "This message's original signature wasn't kept, so it can't be proven. Messages received from now on can be pinned.",
  "not-encrypted": "Only chat messages can be pinned.",
  "bad-payload": "This message is from an epoch whose keys you no longer hold.",
  unverifiable: "This message failed verification, so pinning it would publish an unprovable claim.",
};
import { isAuthorized, Permissions } from "@/concord-v2/lib/roles";
import { readStoredSeal } from "@/concord-v2/lib/rumorStore";
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
export function usePins2(
  community: CommunityV2 | undefined,
  channel: ChannelV2 | undefined,
  /** The channel's opened rows, so a keyed client can apply Edits locally (§7). */
  opened?: Map<string, OpenedEvent>,
) {
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

  /**
   * Edits this client can read but the entry doesn't carry (§7 Edits). A keyed
   * member folds these locally and MUST show the revision rather than
   * superseded words; a curator can then push the proof so keyless readers
   * catch up. Keyed by the pinned rumor id.
   */
  const localEdits = useMemo(() => {
    const out = new Map<string, { opened: OpenedEvent; content: string; ms: number }>();
    if (!opened || pins.length === 0) return out;
    const pinned = new Map(pins.map((p) => [p.rumorId, p]));
    for (const ev of opened.values()) {
      if (ev.kind !== KIND_EDIT) continue;
      const target = ev.tags.find((t) => t[0] === "e")?.[1];
      if (!target) continue;
      const pin = pinned.get(target);
      // Only the original author may revise — the fold's own rule.
      if (!pin || ev.author !== pin.author) continue;
      // Newer than whatever the entry already proves, and newer than any
      // sibling edit we've already picked.
      if (pin.edited && ev.ms <= pin.edited.ms) continue;
      const prev = out.get(target);
      if (prev && prev.ms >= ev.ms) continue;
      out.set(target, { opened: ev, content: ev.content, ms: ev.ms });
    }
    return out;
  }, [opened, pins]);

  /**
   * What the UI renders: the verified pins with any locally-readable Edit
   * applied on top. `staleEdit` marks a pin whose revision this client can see
   * but the entry cannot yet prove to keyless readers.
   */
  const view = useMemo(
    () =>
      pins.map((p) => {
        const local = localEdits.get(p.rumorId);
        return local
          ? { ...p, content: local.content, edited: { content: local.content, ms: local.ms }, staleEdit: true }
          : { ...p, staleEdit: false };
      }),
    [pins, localEdits],
  );

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
      // A row read back from the store carries the rumor, not the seal — the
      // seal lives in KV beside it. Recover it here rather than on every read:
      // pinning is the one path that needs it.
      const withSeal = opened.seal
        ? opened
        : { ...opened, seal: community ? await readStoredSeal(community.idHex, opened.rumorId) : undefined };
      const { entry, reason } = buildPinEntryOrReason(withSeal, stream.group.convKey);
      if (!entry) throw new Error(PIN_FAILURE_MESSAGE[reason ?? "unverifiable"]);
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

  /**
   * Push the newest Edit this client can prove into the list, so keyless
   * readers stop seeing superseded words. Offered only while we hold something
   * newer than the entry carries — a refresh attaching an OLDER Edit would
   * silently revert the pin, which no keyless reader could detect.
   */
  const refreshEdits = useMutation<number, Error, void>({
    mutationFn: async () => {
      if (!channel || localEdits.size === 0) return 0;
      let changed = 0;
      const next = pins.map((p) => {
        const local = localEdits.get(p.rumorId);
        if (!local) return p.entry;
        const epoch = epochOf(local.opened);
        const stream =
          channel.streams.find((s) => (epoch === undefined ? false : s.epoch === epoch)) ?? channel.current;
        const withEdit = withProvenEdit(p.entry, local.opened, stream.group.convKey);
        if (withEdit !== p.entry) changed += 1;
        return withEdit;
      });
      if (changed > 0) await publish(next);
      return changed;
    },
  });

  return {
    pins: view,
    /** Pins whose revision this client sees but the entry can't prove yet. */
    staleEdits: localEdits.size,
    refreshEdits: refreshEdits.mutateAsync,
    isRefreshingEdits: refreshEdits.isPending,
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
