import { bytesToHex } from "@noble/hashes/utils.js";
import { useNostr } from "@nostrify/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useRotatorSecretKey } from "@/hooks/useRotatorSecretKey";
import { useUpdateConcordList } from "@/hooks/useConcordList";
import {
  buildChannelRekeyEvent,
  buildServerRootRekeyEvent,
  buildRekeyBlob,
  epochKeyCommitment,
  openRekeyBlob,
  openRekeyEvent,
  type RekeyBlob,
} from "@/lib/concord/rekey";
import { baseRekeyPseudonym, rekeyPseudonym } from "@/lib/concord/derive";
import { KIND_COMMUNITY_REKEY, KIND_GIFT_WRAP } from "@/lib/concord/kinds";
import { random32, type Channel, type Community } from "@/lib/concord/types";
import { buildCordInvite } from "@/lib/cord/community";
import { baseRekeyGroupKey, cordEpochKeyCommitment, rekeyGroupKey } from "@/lib/cord/derive";
import { registerCordStreamKeys } from "@/lib/cord/relayAuth";
import {
  buildCordBaseRekeyEvent,
  buildCordChannelRekeyEvent,
  buildCordRekeyBlob,
  openCordRekeyBlob,
  openCordRekeyEvent,
} from "@/lib/cord/rekey";
import type { ConcordKeyBundle } from "@/lib/concord";

import type { NostrEvent } from "@nostrify/nostrify";

/** An epoch key recovered for a channel (or the server root). */
export interface EpochKey {
  epoch: bigint;
  key: Uint8Array;
}

/**
 * Walk a channel's rekey chain forward from the bundle's current epoch,
 * recovering each newer epoch's key from the rekey events on the relays. Catch
 * up is how a member learns post-rekey keys (the invite bundle only conveys the
 * current key at join time — the archive fills from 3303 events, exactly as in
 * Vector). The local secret key `mySk` opens this member's per-recipient blob.
 *
 * Returns the full retained set (seed epoch + every caught-up epoch), newest
 * first, ready to feed the channel reader's multi-epoch open.
 */
export function useConcordChannelEpochs(
  community: Community | undefined,
  channel: Channel | undefined,
  mySkHex: string | undefined,
) {
  const { nostr } = useNostr();

  return useQuery<EpochKey[]>({
    queryKey: [
      "concord",
      "epochs",
      community ? bytesToHex(community.id) : null,
      channel ? bytesToHex(channel.id) : null,
    ],
    enabled: Boolean(community && channel && mySkHex),
    staleTime: 15_000,
    refetchInterval: 30_000,
    queryFn: async ({ signal }) => {
      const c = community!;
      const ch = channel!;
      const mySk = hexToBytes32(mySkHex!);

      if (c.proto === "cord") {
        // A derived (public) channel rolls with the CommunityRoot — its epochs
        // are the root epochs, caught up by the root walk, not here.
        if (ch.derived) return [];

        // Private channel: walk its rekey chain forward via the root-derived
        // CORD rekey addresses (`authors` filter on the kind-1059 stream).
        const have = new Map<string, EpochKey>();
        const seedKey = ch.epochKeys[0]?.key ?? ch.key;
        const seedEpoch = ch.epochKeys[0]?.epoch ?? ch.epoch;
        have.set(seedEpoch.toString(), { epoch: seedEpoch, key: seedKey });

        let cursor = seedEpoch;
        let currentKey = seedKey;
        for (let i = 0; i < 256; i++) {
          const nextEpoch = cursor + 1n;
          const group = rekeyGroupKey(c.serverRootKey, ch.id, nextEpoch);
          // AUTH as the probe address before querying: DM-protecting relays
          // only serve `authors`-filtered 1059 REQs to connections authed as
          // the author, and this epoch+1 address is minted right here.
          registerCordStreamKeys(c.relays, [group]);
          const events = await queryRelaysByAuthor(nostr, c.relays, group.pk, signal);
          const wantCommit = bytesToHex(cordEpochKeyCommitment(cursor, currentKey));
          let applied: Uint8Array | undefined;
          for (const ev of events) {
            let parsed;
            try {
              parsed = openCordRekeyEvent(ev, group);
            } catch {
              continue;
            }
            if (parsed.scope.kind !== "channel" || parsed.prevEpoch !== cursor) continue;
            if (bytesToHex(parsed.prevKeyCommitment) !== wantCommit) continue;
            for (const blob of parsed.blobs) {
              try {
                applied = openCordRekeyBlob(mySk, parsed.rotator, parsed.scope, parsed.newEpoch, blob);
                break;
              } catch {
                // not our blob; keep scanning
              }
            }
            if (applied) break;
          }
          if (!applied) break;
          have.set(nextEpoch.toString(), { epoch: nextEpoch, key: applied });
          currentKey = applied;
          cursor = nextEpoch;
        }
        return [...have.values()].sort((a, b) => (a.epoch > b.epoch ? -1 : a.epoch < b.epoch ? 1 : 0));
      }

      // Seed: the key/epoch the bundle conveyed.
      const have = new Map<string, EpochKey>();
      const seedKey = ch.epochKeys[0]?.key ?? ch.key;
      const seedEpoch = ch.epochKeys[0]?.epoch ?? ch.epoch;
      have.set(seedEpoch.toString(), { epoch: seedEpoch, key: seedKey });

      // Walk forward: for each next epoch, the rekey event is addressed by the
      // SERVER-ROOT-derived pseudonym (stable across channel rotations), so we
      // can find any epoch independently of holding the prior channel key.
      let cursor = seedEpoch;
      let currentKey = seedKey;
      // Bound the walk so a hostile relay can't spin us forever.
      for (let i = 0; i < 256; i++) {
        const nextEpoch = cursor + 1n;
        const z = bytesToHex(rekeyPseudonym(c.serverRootKey, ch.id, nextEpoch));
        const events = await queryRelays(nostr, c.relays, z, signal);
        const applied = applyChannelRekey(events, c.serverRootKey, mySk, cursor, currentKey);
        if (!applied) break;
        have.set(nextEpoch.toString(), { epoch: nextEpoch, key: applied });
        currentKey = applied;
        cursor = nextEpoch;
      }

      return [...have.values()].sort((a, b) => (a.epoch > b.epoch ? -1 : a.epoch < b.epoch ? 1 : 0));
    },
  });
}

/**
 * Apply the rekey event(s) at one channel-epoch coordinate: open the outer with
 * the server-root key, verify the prior-key commitment matches the key we hold,
 * find this member's blob, and recover the new key. Returns the new key, or
 * undefined if there's no (valid, for-us) rekey at this coordinate.
 */
function applyChannelRekey(
  events: NostrEvent[],
  serverRoot: Uint8Array,
  mySk: Uint8Array,
  prevEpoch: bigint,
  prevKey: Uint8Array,
): Uint8Array | undefined {
  const wantCommit = bytesToHex(epochKeyCommitment(prevEpoch, prevKey));
  for (const ev of events) {
    let parsed;
    try {
      parsed = openRekeyEvent(ev, serverRoot);
    } catch {
      continue;
    }
    if (parsed.scope.kind !== "channel") continue;
    if (parsed.prevEpoch !== prevEpoch) continue;
    // Fork detection: the rotator must have rotated FROM the key we hold.
    if (bytesToHex(parsed.prevKeyCommitment) !== wantCommit) continue;

    for (const blob of parsed.blobs) {
      try {
        const key = openRekeyBlob(mySk, parsed.rotator, parsed.scope, parsed.newEpoch, blob);
        return key;
      } catch {
        // not our blob; keep scanning
      }
    }
  }
  return undefined;
}

/**
 * Mint + publish a channel rekey: a fresh-random new key for `newEpoch`,
 * delivered to every `recipientPubkeys` member as a per-recipient ECDH blob,
 * enveloped+addressed under the server root. Returns the new key so the caller
 * can advance its local channel. Requires the rotator's RAW identity secret key
 * (a NIP-46 bunker can't rekey — it doesn't expose the secret) AND the raw
 * channel key being rotated from (held locally in the bundle).
 */
export async function publishChannelRekey(
  nostr: ReturnType<typeof useNostr>["nostr"],
  community: Community,
  channel: Channel,
  rotatorSk: Uint8Array,
  recipientPubkeys: string[],
): Promise<Uint8Array> {
  const prevEpoch = channel.epoch;
  const newEpoch = prevEpoch + 1n;
  const newKey = random32();
  const blobs: RekeyBlob[] = recipientPubkeys.map((pk) =>
    buildRekeyBlob(rotatorSk, pk, { kind: "channel", channelId: channel.id }, newEpoch, newKey),
  );
  const event = buildChannelRekeyEvent({
    rotatorSk,
    serverRoot: community.serverRootKey,
    channelId: channel.id,
    newEpoch,
    prevEpoch,
    prevKeyCommitment: epochKeyCommitment(prevEpoch, channel.key),
    blobs,
  });
  await Promise.all(
    community.relays.map((url) =>
      nostr.relay(url).event(event, { signal: AbortSignal.timeout(8000) }).catch(() => {}),
    ),
  );
  return newKey;
}

/**
 * Mint + publish a server-root (base) rotation: a fresh root for `newEpoch`,
 * delivered to `recipientPubkeys` via ServerRoot-scope blobs, enveloped under
 * the PRIOR root. Returns the new root. The control plane must be re-anchored
 * under the new epoch separately by the caller.
 */
export async function publishServerRootRekey(
  nostr: ReturnType<typeof useNostr>["nostr"],
  community: Community,
  rotatorSk: Uint8Array,
  recipientPubkeys: string[],
): Promise<{ newRoot: Uint8Array; newEpoch: bigint }> {
  const prevEpoch = community.serverRootEpoch;
  const newEpoch = prevEpoch + 1n;
  const newRoot = random32();
  const blobs: RekeyBlob[] = recipientPubkeys.map((pk) =>
    buildRekeyBlob(rotatorSk, pk, { kind: "server-root" }, newEpoch, newRoot),
  );
  const event = buildServerRootRekeyEvent({
    rotatorSk,
    priorRoot: community.serverRootKey,
    communityId: community.id,
    newEpoch,
    prevEpoch,
    prevKeyCommitment: epochKeyCommitment(prevEpoch, community.serverRootKey),
    blobs,
  });
  await Promise.all(
    community.relays.map((url) =>
      nostr.relay(url).event(event, { signal: AbortSignal.timeout(8000) }).catch(() => {}),
    ),
  );
  return { newRoot, newEpoch };
}

/** Catch up a server-root rotation a member missed (forward-walk from the held root). */
export async function catchUpServerRoot(
  nostr: ReturnType<typeof useNostr>["nostr"],
  community: Community,
  mySk: Uint8Array,
): Promise<{ root: Uint8Array; epoch: bigint } | undefined> {
  let root = community.serverRootKey;
  let epoch = community.serverRootEpoch;
  let advanced = false;
  for (let i = 0; i < 64; i++) {
    const nextEpoch = epoch + 1n;
    const z = bytesToHex(baseRekeyPseudonym(root, community.id, nextEpoch));
    const events = await queryRelays(nostr, community.relays, z);
    const wantCommit = bytesToHex(epochKeyCommitment(epoch, root));
    let next: Uint8Array | undefined;
    for (const ev of events) {
      let parsed;
      try {
        parsed = openRekeyEvent(ev, root);
      } catch {
        continue;
      }
      if (parsed.scope.kind !== "server-root" || parsed.prevEpoch !== epoch) continue;
      if (bytesToHex(parsed.prevKeyCommitment) !== wantCommit) continue;
      for (const blob of parsed.blobs) {
        try {
          next = openRekeyBlob(mySk, parsed.rotator, parsed.scope, parsed.newEpoch, blob);
          break;
        } catch {
          // not our blob
        }
      }
      if (next) break;
    }
    if (!next) break;
    root = next;
    epoch = nextEpoch;
    advanced = true;
  }
  return advanced ? { root, epoch } : undefined;
}

async function queryRelays(
  nostr: ReturnType<typeof useNostr>["nostr"],
  relays: string[],
  z: string,
  signal?: AbortSignal,
): Promise<NostrEvent[]> {
  const results = await Promise.all(
    relays.map((url) =>
      nostr
        .relay(url)
        .query([{ kinds: [KIND_COMMUNITY_REKEY], "#z": [z], limit: 20 }], {
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000),
        })
        .catch(() => [] as NostrEvent[]),
    ),
  );
  return results.flat();
}

/** CORD rekeys ride kind-1059 streams addressed by the rekey group pubkey. */
async function queryRelaysByAuthor(
  nostr: ReturnType<typeof useNostr>["nostr"],
  relays: string[],
  author: string,
  signal?: AbortSignal,
): Promise<NostrEvent[]> {
  const results = await Promise.all(
    relays.map((url) =>
      nostr
        .relay(url)
        .query([{ kinds: [KIND_GIFT_WRAP], authors: [author], limit: 20 }], {
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000),
        })
        .catch(() => [] as NostrEvent[]),
    ),
  );
  return results.flat();
}

// ── CORD base rotation (Refounding, CORD-06 §3) ──────────────────────────────

/**
 * Publish a CORD base rotation: a fresh CommunityRoot for `newEpoch`,
 * delivered to `recipientPubkeys` via blobs at the prior-root base-rekey
 * address. The caller re-anchors the control plane and rekeys private channels
 * separately (see the moderation hook's refounding ban).
 */
export async function publishCordBaseRekey(
  nostr: ReturnType<typeof useNostr>["nostr"],
  community: Community,
  rotatorSk: Uint8Array,
  recipientPubkeys: string[],
): Promise<{ newRoot: Uint8Array; newEpoch: bigint }> {
  const prevEpoch = community.serverRootEpoch;
  const newEpoch = prevEpoch + 1n;
  const newRoot = random32();
  const blobs: RekeyBlob[] = recipientPubkeys.map((pk) =>
    buildCordRekeyBlob(rotatorSk, pk, { kind: "server-root" }, newEpoch, newRoot),
  );
  const event = buildCordBaseRekeyEvent({
    rotatorSk,
    priorRoot: community.serverRootKey,
    communityId: community.id,
    newEpoch,
    prevEpoch,
    prevKeyCommitment: cordEpochKeyCommitment(prevEpoch, community.serverRootKey),
    blobs,
  });
  await Promise.all(
    community.relays.map((url) =>
      nostr.relay(url).event(event, { signal: AbortSignal.timeout(8000) }).catch(() => {}),
    ),
  );
  return { newRoot, newEpoch };
}

/**
 * Publish a CORD PRIVATE-channel rekey under `root` (the root the recipients
 * will hold — during a refounding, the NEW root). Returns the fresh key.
 */
export async function publishCordChannelRekey(
  nostr: ReturnType<typeof useNostr>["nostr"],
  community: Community,
  channel: Channel,
  root: Uint8Array,
  rotatorSk: Uint8Array,
  recipientPubkeys: string[],
): Promise<Uint8Array> {
  const prevEpoch = channel.epoch;
  const newEpoch = prevEpoch + 1n;
  const newKey = random32();
  const blobs: RekeyBlob[] = recipientPubkeys.map((pk) =>
    buildCordRekeyBlob(rotatorSk, pk, { kind: "channel", channelId: channel.id }, newEpoch, newKey),
  );
  const event = buildCordChannelRekeyEvent({
    rotatorSk,
    root,
    channelId: channel.id,
    newEpoch,
    prevEpoch,
    prevKeyCommitment: cordEpochKeyCommitment(prevEpoch, channel.key),
    blobs,
  });
  await Promise.all(
    community.relays.map((url) =>
      nostr.relay(url).event(event, { signal: AbortSignal.timeout(8000) }).catch(() => {}),
    ),
  );
  return newKey;
}

/**
 * Catch up CORD base rotations this member missed: walk the base-rekey
 * addresses forward from the held root (CORD-06 §2's precomputed next-epoch
 * subscription, as a poll). Returns the advanced root + the prior roots walked
 * through (retained so pre-refounding history stays readable), or undefined
 * when already current. A member whose locator appears in no event has been
 * removed — the walk simply stops (their access ends at the held epoch).
 */
export async function catchUpCordRoot(
  nostr: ReturnType<typeof useNostr>["nostr"],
  community: Community,
  mySk: Uint8Array,
): Promise<{ root: Uint8Array; epoch: bigint; priors: Array<{ epoch: bigint; key: Uint8Array }> } | undefined> {
  let root = community.serverRootKey;
  let epoch = community.serverRootEpoch;
  const priors: Array<{ epoch: bigint; key: Uint8Array }> = [];
  let advanced = false;
  for (let i = 0; i < 64; i++) {
    const nextEpoch = epoch + 1n;
    const group = baseRekeyGroupKey(root, community.id, nextEpoch);
    // AUTH as the probe address (see the channel walk above).
    registerCordStreamKeys(community.relays, [group]);
    const events = await queryRelaysByAuthor(nostr, community.relays, group.pk);
    const wantCommit = bytesToHex(cordEpochKeyCommitment(epoch, root));
    let next: Uint8Array | undefined;
    for (const ev of events) {
      let parsed;
      try {
        parsed = openCordRekeyEvent(ev, group);
      } catch {
        continue;
      }
      if (parsed.scope.kind !== "server-root" || parsed.prevEpoch !== epoch) continue;
      if (bytesToHex(parsed.prevKeyCommitment) !== wantCommit) continue;
      for (const blob of parsed.blobs) {
        try {
          next = openCordRekeyBlob(mySk, parsed.rotator, parsed.scope, parsed.newEpoch, blob);
          break;
        } catch {
          // not our blob
        }
      }
      if (next) break;
    }
    if (!next) break;
    priors.push({ epoch, key: root });
    root = next;
    epoch = nextEpoch;
    advanced = true;
  }
  return advanced ? { root, epoch, priors } : undefined;
}

/** Snapshot a CORD community into its membership-list bundle (with prior roots). */
export function cordBundleOf(community: Community): ConcordKeyBundle {
  return {
    communityId: bytesToHex(community.id),
    epoch: Number(community.serverRootEpoch),
    name: community.name,
    relays: community.relays,
    keys: { cord: buildCordInvite(community, { includePriorRoots: true }) },
  };
}

/**
 * Follow CORD base rotations for a community: polls the next base-rekey
 * address; when a refounding is caught up, advances the membership-list bundle
 * (new root + epoch, priors retained) so every reader re-derives the new
 * addresses. Requires the raw local nsec (ECDH) — extension/bunker signers
 * can't open rekey blobs (the same constraint as v1 rekeys).
 */
export function useCordRootCatchUp(community: Community | undefined) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const mySkHex = useRotatorSecretKey();
  const { mutateAsync: updateList } = useUpdateConcordList();
  const queryClient = useQueryClient();

  const cidHex = community ? bytesToHex(community.id) : null;
  const epochStr = community?.serverRootEpoch.toString();

  const query = useQuery({
    queryKey: ["concord", "cord-root", cidHex, epochStr],
    enabled: Boolean(community && community.proto === "cord" && user && mySkHex),
    staleTime: 30_000,
    refetchInterval: 60_000,
    queryFn: async () => {
      const advanced = await catchUpCordRoot(nostr, community!, hexToBytes32(mySkHex!));
      if (!advanced) return null;
      const next: Community = {
        ...community!,
        serverRootKey: advanced.root,
        serverRootEpoch: advanced.epoch,
        priorRoots: [
          ...advanced.priors,
          ...(community!.priorRoots ?? []),
        ].filter((r, i, arr) => arr.findIndex((x) => x.epoch === r.epoch) === i),
        // Derived channels follow the root forward.
        channels: community!.channels.map((ch) =>
          ch.derived ? { ...ch, key: advanced.root, epoch: advanced.epoch } : ch,
        ),
      };
      await updateList({ type: "refresh-current", current: cordBundleOf(next) });
      return { epoch: advanced.epoch.toString() };
    },
  });

  // A caught-up refounding re-addresses everything — refresh the folds.
  const caughtEpoch = query.data?.epoch;
  useEffect(() => {
    if (!caughtEpoch || !cidHex) return;
    queryClient.invalidateQueries({ queryKey: ["concord", "list"] });
    queryClient.invalidateQueries({ queryKey: ["concord", "control", cidHex] });
    queryClient.invalidateQueries({ queryKey: ["concord", "epochs"] });
  }, [caughtEpoch, cidHex, queryClient]);

  return query;
}

function hexToBytes32(hex: string): Uint8Array {
  const b = new Uint8Array(32);
  for (let i = 0; i < 32; i++) b[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return b;
}
