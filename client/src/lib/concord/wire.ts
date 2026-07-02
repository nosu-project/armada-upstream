/**
 * The channel WIRE abstraction — everything protocol-specific about reading
 * and writing one channel's append plane, behind one small object, so the
 * (large, orchestration-heavy) channel hooks run both wire formats:
 *
 *   - v1 (Vector parity): ephemeral-signed outers at `#z` pseudonyms, per-kind
 *     relay filters, inner events signed by the author.
 *   - CORD (experimental): kind-1059 streams at derived group addresses
 *     (`authors` filters — one address carries every kind), sealed rumors.
 *
 * Everything above the wire operates on {@link OpenedMessage} with the v1 kind
 * constants (CORD rumor kinds are normalized on open), so folds, timelines,
 * reactions, and moderation stay protocol-agnostic.
 */

import { bytesToHex } from "@noble/hashes/utils.js";
import type { EventTemplate, NostrEvent } from "nostr-tools/pure";

import { forgetSkips, openMemoizedBatch } from "@/lib/concord/decodeCache";
import { channelPseudonym } from "@/lib/concord/derive";
import {
  buildInnerEvent,
  openedFromSealed,
  sealWithSignedInner,
  type OpenedMessage,
} from "@/lib/concord/envelope";
import { KIND_GIFT_WRAP } from "@/lib/concord/kinds";
import type { Channel, Community } from "@/lib/concord/types";
import { cordChannelCurrent, cordChannelGroups } from "@/lib/cord/community";
import { channelGroupKey } from "@/lib/cord/derive";
import {
  buildCordRumorTemplate,
  buildSealTemplate,
  finalizeRumor,
  forgetCordSkips,
  openCordBatch,
  openedFromCordRumor,
  wrapSeal,
  type EpochGroup,
} from "@/lib/cord/stream";

import type { NostrFilter } from "@nostrify/nostrify";

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
  proto: "v1" | "cord";
  /** The relay-filterable addresses across held epochs (z hexes / group pks). */
  addresses: string[];
  /** A stable signature of the held-epoch set (drives resubscribe effects). */
  epochSig: string;
  /**
   * Build a relay filter selecting `logicalKinds` (v1 kind constants) at this
   * channel's addresses. CORD carries every kind at one 1059 address, so the
   * kinds narrow only post-decode there — pass them anyway for v1's benefit.
   */
  filter(logicalKinds: number[], extra?: Partial<NostrFilter>): NostrFilter;
  /**
   * Open a batch of sealed outers (decode-once memoized, chunked off the main
   * thread). `kinds` (logical) post-filters the opened set — REQUIRED where a
   * v1 relay filter would have narrowed (CORD returns everything otherwise).
   */
  openBatch(
    events: NostrEvent[],
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

function cordWire(community: Community, channel: Channel): ChannelWire {
  const groups: EpochGroup[] = cordChannelGroups(community, channel);
  const pks = groups.map((g) => g.group.pk);

  return {
    proto: "cord",
    addresses: pks,
    epochSig: groups.map((g) => g.epoch.toString()).join(","),
    filter(_logicalKinds, extra) {
      return { kinds: [KIND_GIFT_WRAP], authors: pks, ...extra };
    },
    async openBatch(events, opts) {
      const opened = await openCordBatch(events, channel.id, groups, { signal: opts?.signal });
      return opts?.kinds ? opened.filter((m) => opts.kinds!.includes(m.kind)) : opened;
    },
    async send(signer, authorPubkey, opts) {
      const { secret, epoch } = cordChannelCurrent(community, channel);
      const group = channelGroupKey(secret, channel.id, epoch);
      const rumor = finalizeRumor(
        buildCordRumorTemplate({
          channelId: channel.id,
          epoch,
          content: opts.content,
          ms: opts.ms,
          kind: opts.kind,
          reference: opts.reference,
          extraTags: opts.extraTags,
        }),
        authorPubkey,
      );
      const seal = await signer.signEvent(buildSealTemplate(rumor, group));
      const outer = wrapSeal(seal, group);
      return { opened: openedFromCordRumor(rumor, outer, channel.id, epoch), outer };
    },
    forgetSkips: forgetCordSkips,
  };
}

/**
 * The wire for one channel of one community, selected by the community's
 * protocol. `extraEpochKeys` are caught-up rekey keys beyond the bundle's seed
 * (v1 only — CORD derived channels roll with the root, private ones carry
 * their history in `channel.epochKeys`).
 */
export function channelWire(
  community: Community,
  channel: Channel,
  extraEpochKeys?: Array<{ epoch: bigint; key: Uint8Array }>,
): ChannelWire {
  return community.proto === "cord" ? cordWire(community, channel) : v1Wire(channel, extraEpochKeys);
}
