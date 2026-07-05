import { bytesToHex } from "@noble/hashes/utils.js";
import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";

import {
  buildChannelRekeyEvent,
  buildServerRootRekeyEvent,
  buildRekeyBlob,
  epochKeyCommitment,
  openRekeyBlob,
  openRekeyEvent,
  type RekeyBlob,
} from "@/concord-v1/lib/rekey";
import { baseRekeyPseudonym, rekeyPseudonym } from "@/concord-v1/lib/derive";
import { KIND_COMMUNITY_REKEY } from "@/concord-v1/lib/kinds";
import { random32, type Channel, type Community } from "@/concord-v1/lib/types";

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

function hexToBytes32(hex: string): Uint8Array {
  const b = new Uint8Array(32);
  for (let i = 0; i < 32; i++) b[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return b;
}
