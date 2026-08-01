/**
 * The channel WIRE abstraction — everything protocol-specific about reading
 * and writing one channel's append plane, behind one small object, so the
 * (large, orchestration-heavy) channel hooks stay wire-format agnostic:
 *
 *   - v1 (Vector parity): ephemeral-signed outers at `#z` pseudonyms, per-kind
 *     relay filters, inner events signed by the author.
 *
 * Everything above the wire operates on {@link OpenedMessage} with the v1 kind
 * constants, so folds, timelines, reactions, and moderation stay
 * protocol-agnostic.
 */

import { bytesToHex } from "@noble/hashes/utils.js";
import type { EventTemplate, NostrEvent } from "nostr-tools/pure";

import { forgetSkips, openMemoizedBatch } from "@/concord-v1/lib/decodeCache";
import { channelPseudonym } from "@/concord-v1/lib/derive";
import {
  buildInnerEvent,
  openedFromSealed,
  sealWithSignedInner,
  type OpenedMessage,
} from "@/concord-v1/lib/envelope";
import type { Channel, Community } from "@/concord-v1/lib/types";

import type { NostrFilter } from "@nostrify/nostrify";
import type { NostrRumor } from "@/lib/nostrRumor";

/** The minimal signer surface the wire needs (matches @nostrify's NUser signer). */
export interface WireSigner {
  signEvent(template: EventTemplate): Promise<NostrEvent>;
}

/** What a send produces: the optimistic view + the sealed outer to broadcast. */
export interface SealedSend {
  opened: OpenedMessage;
  outer: NostrEvent;
}

export interface ChannelWire {
  proto: "v1";
  /** The relay-filterable addresses across held epochs (z hexes). */
  addresses: string[];
  /** A stable signature of the held-epoch set (drives resubscribe effects). */
  epochSig: string;
  /**
   * Build a relay filter selecting `logicalKinds` (v1 kind constants) at this
   * channel's addresses.
   */
  filter(logicalKinds: number[], extra?: Partial<NostrFilter>): NostrFilter;
  /**
   * Open a batch of sealed outers (decode-once memoized, chunked off the main
   * thread). `kinds` (logical) post-filters the opened set.
   */
  openBatch(
    events: NostrRumor[],
    opts?: { signal?: AbortSignal; kinds?: number[] },
  ): Promise<OpenedMessage[]>;
  /** Sign + seal one append event at the CURRENT epoch. */
  send(
    signer: WireSigner,
    authorPubkey: string,
    opts: { kind?: number; content: string; ms: number; reference?: string; extraTags?: string[][] },
  ): Promise<SealedSend>;
  /** Forget remembered decode failures (a caught-up rekey may now decode them). */
  forgetSkips(): void;
}

/** The retained epoch keys for a v1 channel, newest first. */
function v1EpochKeys(channel: Channel): Array<{ epoch: bigint; key: Uint8Array }> {
  const keys = channel.epochKeys.length ? channel.epochKeys : [{ epoch: channel.epoch, key: channel.key }];
  return [...keys].sort((a, b) => (a.epoch > b.epoch ? -1 : a.epoch < b.epoch ? 1 : 0));
}

function v1Wire(
  channel: Channel,
  extraEpochKeys?: Array<{ epoch: bigint; key: Uint8Array }>,
): ChannelWire {
  const byEpoch = new Map<string, { epoch: bigint; key: Uint8Array }>();
  for (const ek of v1EpochKeys(channel)) byEpoch.set(ek.epoch.toString(), ek);
  for (const ek of extraEpochKeys ?? []) byEpoch.set(ek.epoch.toString(), ek);
  const epochKeys = [...byEpoch.values()].sort((a, b) => (a.epoch > b.epoch ? -1 : a.epoch < b.epoch ? 1 : 0));
  const zs = epochKeys.map((ek) => bytesToHex(channelPseudonym(ek.key, channel.id, ek.epoch)));

  return {
    proto: "v1",
    addresses: zs,
    epochSig: epochKeys.map((e) => e.epoch.toString()).join(","),
    filter(logicalKinds, extra) {
      return { kinds: logicalKinds, "#z": zs, ...extra };
    },
    async openBatch(events, opts) {
      const opened = await openMemoizedBatch(events, channel.id, epochKeys, { signal: opts?.signal });
      return opts?.kinds ? opened.filter((m) => opts.kinds!.includes(m.kind)) : opened;
    },
    async send(signer, _authorPubkey, opts) {
      const template = buildInnerEvent({
        channelId: channel.id,
        epoch: channel.epoch,
        content: opts.content,
        ms: opts.ms,
        kind: opts.kind,
        reference: opts.reference,
        extraTags: opts.extraTags,
      });
      const inner = await signer.signEvent(template);
      const outer = sealWithSignedInner(inner, channel.key, channel.id, channel.epoch);
      return { opened: openedFromSealed(inner, outer, channel.id, channel.epoch), outer };
    },
    forgetSkips,
  };
}

/**
 * The wire for one channel of one community. `extraEpochKeys` are caught-up
 * rekey keys beyond the bundle's seed.
 */
export function channelWire(
  _community: Community,
  channel: Channel,
  extraEpochKeys?: Array<{ epoch: bigint; key: Uint8Array }>,
): ChannelWire {
  return v1Wire(channel, extraEpochKeys);
}
