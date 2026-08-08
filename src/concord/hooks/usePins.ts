import { useNostr } from "@nostrify/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef } from "react";

import {
  citationFor,
  invalidateControl,
  publishEdition,
  useControlFold,
} from "@/concord/hooks/useControlPlane";
import { buildEditionRumor } from "@/concord/lib/edition";
import { bytesToHex, pinsLocator } from "@/concord/lib/derive";
import { KIND_DELETE, KIND_EDIT, VSK_PINS } from "@/concord/lib/kinds";
import {
  PIN_MAX_CONTENT_BYTES,
  PIN_MAX_ENTRIES,
  buildPinEntryOrReason,
  isPlaceholderSeal,
  partitionDeletedPins,
  readPinList,
  unconfirmedWrite,
  withProvenEdit,
  serializePublicPinList,
  serializeSealedPinList,
  verifyPinEntry,
  type PinBuildFailure,
  type PinEntry,
  type VerifiedPin,
} from "@/concord/lib/pins";

import { isAuthorized, Permissions } from "@/concord/lib/roles";
import { editionHash } from "@/concord/lib/version";
import { readStoredSeal } from "@/concord/lib/rumorStore";
import type { OpenedEvent } from "@/concord/lib/stream";
import type { Channel, Community } from "@/concord/lib/types";
import { useCurrentUser } from "@/hooks/useCurrentUser";

/** A pin as this client holds it: the entry, plus the id it was proven to carry. */
interface HeldPin {
  rumorId: string;
  entry: PinEntry;
}

const PIN_FAILURE_MESSAGE: Record<PinBuildFailure, string> = {
  "no-seal": "This message's original signature wasn't kept, so it can't be proven. Messages received from now on can be pinned.",
  pending: "This message is still being sent. Try pinning it again in a moment.",
  "not-encrypted": "Only chat messages can be pinned.",
  "bad-payload": "This message is from an epoch whose keys you no longer hold.",
  unverifiable: "This message failed verification, so pinning it would publish an unprovable claim.",
};


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
export function usePins(
  community: Community | undefined,
  channel: Channel | undefined,
  /** The channel's opened rows, so a keyed client can apply Edits locally (§7). */
  opened?: Map<string, OpenedEvent>,
) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  const { data: folded } = useControlFold(community);

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
   * Deletes this client holds (§7). Self-erasure outranks curation: a reader
   * holding the delete MUST hide the entry immediately, whether or not anyone
   * ever republishes the list. Without this a message its author erased keeps
   * rendering under a "proven" badge — on the Control Plane head, which
   * compaction carries into every future epoch, so the pin would outlive the
   * deletion it was meant to obey.
   */
  const deletes = useMemo(
    () => [...(opened?.values() ?? [])].filter((e) => e.kind === KIND_DELETE),
    [opened],
  );
  const { alive, killed } = useMemo(() => partitionDeletedPins(pins, deletes), [pins, deletes]);

  /**
   * What the UI renders: the verified pins with any locally-readable Edit
   * applied on top. `staleEdit` marks a pin whose revision this client can see
   * but the entry cannot yet prove to keyless readers.
   */
  const view = useMemo(
    () =>
      alive.map((p) => {
        const local = localEdits.get(p.rumorId);
        return local
          ? { ...p, content: local.content, edited: { content: local.content, ms: local.ms }, staleEdit: true }
          : { ...p, staleEdit: false };
      }),
    [alive, localEdits],
  );

  // A view that is empty because we could not READ the list must never be
  // published from: a replace-entire edition would drop every entry we cannot
  // see, and compaction would then prune the ancestors that still held them.
  // Two ways that happens, and neither looks different from "no pins yet":
  // the list is sealed under an epoch we never held (`dark`), or the fold
  // served no edition for this entity this round (`incomplete`).
  const unreadable = dark || Boolean(eidHex && folded?.incomplete.includes(eidHex));
  const canPin =
    Boolean(user && folded && isAuthorized(folded.roster, user.pubkey, folded.ownerHex, Permissions.PIN_MESSAGES)) &&
    !unreadable;

  /**
   * Our own last write, held until the fold catches up to it.
   *
   * Every write here is replace-entire, and the fold is a relay round trip
   * behind: two actions in quick succession would each build from the
   * pre-write list, so the second would silently erase the first's entry and
   * claim a version that is already taken. The edition hash is computable
   * locally, so we chain off our own edition rather than waiting to see it.
   */
  const written = useRef<{ eid: string; version: bigint; hash: Uint8Array; held: HeldPin[] } | undefined>(undefined);
  // Keyed by entity, not cleared on switch: an op already queued for the old
  // channel resolves after any clear and would repopulate the ref.
  const mineHere = () => (written.current?.eid === eidHex ? written.current : undefined);

  /** The head as we best know it: our own write while it outranks the fold. */
  const knownHead = () => {
    const foldedHead = eidHex ? folded?.heads.get(eidHex) : undefined;
    return unconfirmedWrite(mineHere(), foldedHead, eidHex) ? mineHere() : foldedHead;
  };

  /** The list to build the next write from — ours if the fold hasn't caught up. */
  const currentPins = (): HeldPin[] =>
    unconfirmedWrite(mineHere(), eidHex ? folded?.heads.get(eidHex) : undefined, eidHex) ??
    pins.map((p) => ({ rumorId: p.rumorId, entry: p.entry }));

  // Writes run one at a time. Concurrency here is not a race to lose a render,
  // it is a race to lose someone's pin.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const serialize = <T,>(op: () => Promise<T>): Promise<T> => {
    const next = queue.current.then(op, op);
    queue.current = next.catch(() => undefined);
    return next;
  };

  /** Publish the list, replaced entire — the only write shape (§7). */
  const publish = async (held: HeldPin[]) => {
    if (!user || !community || !channel || !eidHex) throw new Error("Not ready.");
    const entries = held.map((h) => h.entry);
    const content = channel.isPrivate
      ? serializeSealedPinList(entries, channel.current.group.convKey, channel.current.epoch)
      : serializePublicPinList(entries);
    const prior = knownHead();
    const entityId = pinsLocator(community.id, channel.id);
    const version = prior ? prior.version + 1n : 1n;
    await publishEdition(
      nostr,
      community,
      user.signer,
      buildEditionRumor({
        vsk: VSK_PINS,
        entityId,
        content,
        actorPubkey: user.pubkey,
        version,
        prevHash: prior?.hash,
        authority: citationFor(community, folded, user.pubkey),
      }),
    );
    written.current = {
      eid: eidHex,
      version,
      hash: editionHash(entityId, version, prior?.hash, new TextEncoder().encode(content)),
      held,
    };
    if (community) invalidateControl(queryClient, community.idHex);
  };

  const pin = useMutation<void, Error, { opened: OpenedEvent }>({
    mutationFn: ({ opened }) => serialize(async () => {
      if (!channel) throw new Error("Not ready.");
      const current = currentPins();
      if (current.length >= PIN_MAX_ENTRIES) {
        throw new Error(`This channel already has ${PIN_MAX_ENTRIES} pins. Unpin one first.`);
      }
      // The epoch the message was written under — its keys, not today's.
      const epoch = epochOf(opened);
      const stream = channel.streams.find((s) => (epoch === undefined ? false : s.epoch === epoch)) ?? channel.current;
      // A row read back from the store has no seal (it lives in KV beside the
      // rumor); a row just sent carries a PLACEHOLDER one. Both need the real
      // seal fetched here — pinning is the only path that needs it at all.
      const needsSeal = !opened.seal || isPlaceholderSeal(opened.seal);
      const withSeal = needsSeal
        ? { ...opened, seal: community ? await readStoredSeal(community.idHex, opened.rumorId) : undefined }
        : opened;
      const { entry, reason } = buildPinEntryOrReason(withSeal, stream.group.convKey);
      if (!entry) throw new Error(PIN_FAILURE_MESSAGE[reason ?? "unverifiable"]);
      if (current.some((h) => h.rumorId === opened.rumorId)) return; // already pinned
      await publish([{ rumorId: opened.rumorId, entry }, ...current]);
    }),
  });

  const unpin = useMutation<void, Error, { rumorId: string }>({
    mutationFn: ({ rumorId }) =>
      serialize(async () => {
        await publish(currentPins().filter((h) => h.rumorId !== rumorId));
      }),
  });

  /**
   * Settle what the published list owes its keyless readers: drop entries whose
   * author erased the message, and attach the newest Edit this client can prove
   * so nobody reads superseded words.
   *
   * Both duties are one write because both are the same write — the list is
   * replace-entire, so splitting them would publish two editions to say one
   * thing. An Edit is attached only while we hold something NEWER than the
   * entry carries: attaching an older one would silently revert the pin, and no
   * keyless reader could detect that.
   */
  const refreshEdits = useMutation<number, Error, void>({
    mutationFn: () => serialize(async () => {
      if (!channel || !community) return 0;
      const erased = new Set(killed.map((p) => p.rumorId));
      if (localEdits.size === 0 && erased.size === 0) return 0;
      let changed = 0;
      const next: HeldPin[] = [];
      for (const p of currentPins()) {
        // An erased message leaves the head entirely. Hiding it locally is not
        // enough: compaction re-wraps the head verbatim, so an entry left in
        // place carries the deleted words into every future epoch.
        if (erased.has(p.rumorId)) {
          changed += 1;
          continue;
        }
        const local = localEdits.get(p.rumorId);
        if (!local) {
          next.push(p);
          continue;
        }
        const epoch = epochOf(local.opened);
        const stream =
          channel.streams.find((s) => (epoch === undefined ? false : s.epoch === epoch)) ?? channel.current;
        // A row read back from the store carries the rumor, not the seal — and
        // proving a revision needs the Edit's seal exactly as pinning needs the
        // message's. Recover it here, on this path only.
        const opened =
          local.opened.seal && !isPlaceholderSeal(local.opened.seal)
            ? local.opened
            : { ...local.opened, seal: await readStoredSeal(community.idHex, local.opened.rumorId) };
        const withEdit = withProvenEdit(p.entry, opened, stream.group.convKey);
        // Compare on CONTENT: withProvenEdit always returns a fresh object when
        // the edit verifies, so an identity check counts a no-op as a change
        // and republishes an identical list.
        if (withEdit.edit?.keys !== p.entry.edit?.keys) changed += 1;
        next.push({ rumorId: p.rumorId, entry: withEdit });
      }
      if (changed > 0) await publish(next);
      return changed;
    }),
  });

  /**
   * Push a revision to keyless readers on our own, the way the deletion
   * omission does. A pin nobody refreshes shows superseded words forever, and a
   * button nobody clicks is the same as no rule at all.
   *
   * Deferring by a random interval does double duty: it collapses simultaneous
   * curators into one publisher (every republish carries the same list), and it
   * coalesces an author's burst of corrections, since the push attaches
   * whatever is newest when it fires rather than each revision as it lands.
   */
  // Depend on a STRING, never the Map or the mutation: both take a fresh
  // identity most renders, and an effect keyed on them re-arms its own cleanup
  // before the timer can fire — the push would be scheduled forever and never
  // happen.
  const editSignature = useMemo(
    () =>
      [
        ...[...localEdits.entries()].map(([id, e]) => `e${id}:${e.ms}`),
        ...killed.map((p) => `d${p.rumorId}`),
      ]
        .sort()
        .join("|"),
    [localEdits, killed],
  );
  const pushed = useRef("");
  const runPush = useRef<() => Promise<unknown>>(async () => undefined);
  useEffect(() => {
    runPush.current = () => refreshEdits.mutateAsync();
  });
  useEffect(() => {
    if (!canPin || !editSignature) return;
    // One attempt per distinct set of stale revisions: a failure must not spin.
    if (pushed.current === editSignature) return;
    const timer = setTimeout(() => {
      // Marked done only on success: a relay that was briefly unreachable must
      // not cost the list a §7 obligation permanently. Re-firing is bounded —
      // the signature only survives while the obligation does.
      void runPush.current().then(
        () => {
          pushed.current = editSignature;
        },
        () => undefined,
      );
    }, 3_000 + Math.floor(Math.random() * 12_000));
    return () => clearTimeout(timer);
  }, [canPin, editSignature]);

  const pinnedIds = useMemo(() => new Set(alive.map((p) => p.rumorId)), [alive]);
  const isPinned = useCallback((rumorId: string) => pinnedIds.has(rumorId), [pinnedIds]);

  return {
    pins: view,
    /** Pins whose revision this client sees but the entry can't prove yet. */
    staleEdits: localEdits.size,
    /** Pins their author erased, hidden here and dropped from the head shortly. */
    deletedPins: killed.length,
    refreshEdits: refreshEdits.mutateAsync,
    isRefreshingEdits: refreshEdits.isPending,
    /** The list is sealed under an epoch we never held — pins exist but are unreadable. */
    dark,
    canPin,
    isPinned,
    pin: pin.mutateAsync,
    isPinning: pin.isPending,
    unpin: unpin.mutateAsync,
    isUnpinning: unpin.isPending,
    /** Remaining budget, which is the real ceiling for a private channel (§7). */
    remaining: { entries: Math.max(0, PIN_MAX_ENTRIES - alive.length), bytes: PIN_MAX_CONTENT_BYTES },
  };
}

/** Decode a list, handing it the key for whichever epoch it was sealed at. */
function readList(content: string, channel: Channel) {
  return readPinList(content, (epoch) => channel.streams.find((s) => s.epoch === epoch)?.group.convKey);
}

function epochOf(opened: OpenedEvent): bigint | undefined {
  for (const t of opened.tags) {
    if (t[0] === "epoch" && /^(0|[1-9][0-9]*)$/.test(t[1] ?? "")) return BigInt(t[1]);
  }
  return undefined;
}
