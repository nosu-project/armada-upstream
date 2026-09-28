/**
 * Pure zap helpers. NIP-29: public NIP-57 kind-9735 receipts aggregated by
 * {@link tallyZaps} (bolt11 is the amount's source of truth). Concord: CORD.md
 * private zaps — a sealed 9735-shaped rumor with a `preimage` tag, verified
 * locally by {@link verifyZapRumor}.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { decode as decodeBolt11 } from "light-bolt11-decoder";
import { verifyEvent } from "nostr-tools/pure";

import type { NostrEvent } from "@nostrify/nostrify";
import type { Event as NostrToolsEvent } from "nostr-tools/pure";
import type { NostrRumor } from "@/lib/nostrRumor";

/** Bounded insertion-order cache (entries are immutable; the cap only bounds memory). */
function boundedSet<K, V>(map: Map<K, V>, key: K, value: V, cap = 4096): V {
  if (map.size >= cap) map.delete(map.keys().next().value as K);
  map.set(key, value);
  return value;
}

export const KIND_ZAP_RECEIPT = 9735;
/** On-chain Bitcoin zap attribution (kind 8333). */
export const KIND_ONCHAIN_ZAP = 8333;
/** How the sats were sent. */
export type ZapRail = "lightning" | "onchain";

/** One counted zap on a message. */
export interface ZapEntry {
  /** Receipt event id (NIP-29) or rumor id (Concord). */
  id: string;
  /** The zapper's pubkey (embedded 9734 author for NIP-29; seal author for Concord). */
  pubkey: string;
  sats: number;
  comment: string;
  /** The payment rail: Lightning (NIP-57) or on-chain Bitcoin (kind 8333). */
  rail: ZapRail;
}

/** Aggregated zaps for one message. */
export interface ZapTally {
  totalSats: number;
  count: number;
  /** Whether the current user is among the zappers. */
  mine: boolean;
  /** Individual zaps, largest first. */
  zaps: ZapEntry[];
}

/** "1234567" → "1.2m", "21000" → "21k", "950" → "950". */
export function formatSats(sats: number): string {
  if (sats >= 1_000_000) return `${trimmed(sats / 1_000_000)}m`;
  if (sats >= 1_000) return `${trimmed(sats / 1_000)}k`;
  return String(sats);
}

function trimmed(n: number): string {
  const rounded = Math.round(n * 10) / 10;
  return rounded % 1 === 0 ? String(Math.round(rounded)) : rounded.toFixed(1);
}

interface Bolt11Info {
  /** Millisats, or null for an amountless invoice. */
  amountMsats: number | null;
  /** Lowercase hex payment hash, or null if absent/undecodable. */
  paymentHash: string | null;
}

/** Decode the two invoice fields zaps care about. Never throws. */
export function bolt11Info(invoice: string): Bolt11Info {
  try {
    const decoded = decodeBolt11(invoice.trim());
    let amountMsats: number | null = null;
    let paymentHash: string | null = null;
    for (const section of decoded.sections as Array<{ name: string; value?: unknown }>) {
      if (section.name === "amount") {
        const n = Number(section.value);
        if (Number.isFinite(n) && n > 0) amountMsats = n;
      } else if (section.name === "payment_hash" && typeof section.value === "string") {
        paymentHash = section.value.toLowerCase();
      }
    }
    return { amountMsats, paymentHash };
  } catch {
    return { amountMsats: null, paymentHash: null };
  }
}

/** Whole sats encoded in an invoice, or null (amountless/undecodable). */
export function bolt11AmountSats(invoice: string): number | null {
  const { amountMsats } = bolt11Info(invoice);
  return amountMsats === null ? null : Math.floor(amountMsats / 1000);
}

function tagValue(ev: NostrRumor, name: string): string | undefined {
  return ev.tags.find((t) => t[0] === name)?.[1];
}

/**
 * The embedded kind-9734 request, signature-verified (the only
 * self-authenticating part; prevents spoofed zappers). Cached per receipt id.
 */
const requestCache = new Map<string, NostrEvent | null>();
export function receiptZapRequest(receipt: NostrRumor): NostrEvent | null {
  const hit = requestCache.get(receipt.id);
  if (hit !== undefined) return hit;

  const description = tagValue(receipt, "description");
  if (!description) return boundedSet(requestCache, receipt.id, null);
  try {
    const request = JSON.parse(description) as NostrEvent;
    const valid =
      request &&
      request.kind === 9734 &&
      typeof request.pubkey === "string" &&
      verifyEvent(request as NostrToolsEvent);
    return boundedSet(requestCache, receipt.id, valid ? request : null);
  } catch {
    return boundedSet(requestCache, receipt.id, null);
  }
}

/**
 * Receipt amount in sats from the bolt11 invoice; a disagreeing request amount
 * voids it, and the receipt's own `amount` tag is never trusted.
 */
export function receiptAmountSats(receipt: NostrRumor, request: NostrEvent): number {
  const bolt11 = tagValue(receipt, "bolt11");
  if (!bolt11) return 0;
  const { amountMsats } = bolt11Info(bolt11);
  if (amountMsats === null) return 0;
  const requested = Number(request.tags.find((t) => t[0] === "amount")?.[1]);
  if (Number.isFinite(requested) && requested > 0 && requested !== amountMsats) return 0;
  return Math.floor(amountMsats / 1000);
}

/**
 * Fold kind-9735 receipts for ONE message. Dedupes by receipt id AND payment
 * hash; drops mismatched targets, bad signatures, and inflated amounts.
 * Residual trust: the author isn't pinned to the LNURL `nostrPubkey` (that
 * fetch would leak readers' IPs), so unpaid self-made invoices remain possible.
 */
export function tallyZaps(
  receipts: NostrRumor[],
  targetId: string,
  userPubkey?: string,
): ZapTally {
  const seen = new Set<string>();
  const seenHashes = new Set<string>();
  const zaps: ZapEntry[] = [];
  for (const receipt of receipts) {
    if (receipt.kind !== KIND_ZAP_RECEIPT || seen.has(receipt.id)) continue;
    const request = receiptZapRequest(receipt);
    if (!request) continue;
    if (!request.tags.some((t) => t[0] === "e" && t[1] === targetId)) continue;
    const sats = receiptAmountSats(receipt, request);
    if (sats <= 0) continue;
    const { paymentHash } = bolt11Info(tagValue(receipt, "bolt11") ?? "");
    if (paymentHash) {
      if (seenHashes.has(paymentHash)) continue;
      seenHashes.add(paymentHash);
    }
    seen.add(receipt.id);
    zaps.push({ id: receipt.id, pubkey: request.pubkey, sats, comment: request.content ?? "", rail: "lightning" });
  }
  zaps.sort((a, b) => b.sats - a.sats);
  return {
    totalSats: zaps.reduce((sum, z) => sum + z.sats, 0),
    count: zaps.length,
    mine: Boolean(userPubkey && zaps.some((z) => z.pubkey === userPubkey)),
    zaps,
  };
}

/**
 * Fold kind-8333 on-chain zaps for ONE message. The tx on the public ledger is
 * the proof, so only structure is validated; deduped by txid.
 */
export function tallyOnchainZaps(
  events: NostrRumor[],
  targetId: string,
  userPubkey?: string,
): ZapTally {
  const seenTxids = new Set<string>();
  const zaps: ZapEntry[] = [];
  for (const event of events) {
    if (event.kind !== KIND_ONCHAIN_ZAP) continue;
    if (!event.tags.some((t) => t[0] === "e" && t[1] === targetId)) continue;
    const txid = verifyOnchainZapRumor({ kind: event.kind, tags: event.tags });
    if (!txid) continue;
    if (seenTxids.has(txid)) continue;
    seenTxids.add(txid);
    const sats = Number(event.tags.find((t) => t[0] === "amount")?.[1]);
    if (!Number.isFinite(sats) || sats <= 0) continue;
    zaps.push({
      id: event.id,
      pubkey: event.pubkey,
      sats,
      comment: event.content ?? "",
      rail: "onchain",
    });
  }
  zaps.sort((a, b) => b.sats - a.sats);
  return {
    totalSats: zaps.reduce((sum, z) => sum + z.sats, 0),
    count: zaps.length,
    mine: Boolean(userPubkey && zaps.some((z) => z.pubkey === userPubkey)),
    zaps,
  };
}

/**
 * Verify a CORD.md zap rumor (§4): sha256(preimage) = invoice payment hash and
 * `amount` = invoice msats. Returns the payment hash (the fold's dedup key) or
 * null. Channel/epoch binding is the plane decoder's job. Never throws.
 */
export function verifyZapRumor(rumor: {
  kind: number;
  tags: string[][];
}): string | null {
  if (rumor.kind !== KIND_ZAP_RECEIPT) return null;
  const find = (name: string) => rumor.tags.find((t) => t[0] === name)?.[1];
  const bolt11 = find("bolt11");
  const preimage = find("preimage");
  const amount = Number(find("amount"));
  if (!bolt11 || !preimage || !/^[0-9a-f]{64}$/.test(preimage)) return null;
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const { amountMsats, paymentHash } = bolt11Info(bolt11);
  if (!paymentHash || amountMsats === null) return null; // amountless invoices are not zappable
  if (amountMsats !== amount) return null;
  try {
    return bytesToHex(sha256(hexToBytes(preimage))) === paymentHash ? paymentHash : null;
  } catch {
    return null;
  }
}

/** CORD.md zap rumor tags (binding tags added by the send path); `omitTarget` skips `e`. */
export function zapRumorTags(opts: {
  targetId: string;
  targetKind: number;
  recipient: string;
  amountMsats: number;
  bolt11: string;
  preimage: string;
  omitTarget?: boolean;
}): string[][] {
  return [
    ...(opts.omitTarget ? [] : [["e", opts.targetId]]),
    ["p", opts.recipient],
    ["k", String(opts.targetKind)],
    ["amount", String(opts.amountMsats)],
    ["bolt11", opts.bolt11],
    ["preimage", opts.preimage],
  ];
}

/**
 * Verify a CORD.md on-chain zap rumor structurally (kind 8333, `i` =
 * `bitcoin:tx:<txid>`, positive `amount`). Returns the txid (dedup key) or
 * null. Never throws.
 */
export function verifyOnchainZapRumor(rumor: {
  kind: number;
  tags: string[][];
}): string | null {
  if (rumor.kind !== KIND_ONCHAIN_ZAP) return null;
  const find = (name: string) => rumor.tags.find((t) => t[0] === name)?.[1];
  const i = find("i");
  const amount = Number(find("amount"));
  if (!i || !i.startsWith("bitcoin:tx:")) return null;
  const txid = i.slice("bitcoin:tx:".length);
  if (!/^[0-9a-f]{64}$/.test(txid)) return null;
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return txid;
}
