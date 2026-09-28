/**
 * A notification's room-level identity (title + image), mimicking Android's
 * conversation shortcuts on web/Electron. Local reads only (KV fold snapshot,
 * NIP-29 tenant); unnamed rooms fall back to the sender. Free of React and
 * `@/concord/lib/control` because the service worker bundles it.
 */

import { getArmadaDB } from "@/lib/db/armadaDB";
import { appEventStore } from "@/lib/db/mainEventStore";
import { decode } from "@/lib/foldedCache";

import type { ImagePointer } from "@/concord/lib/types";

/** NIP-29 group metadata (addressable, relay-signed). */
const KIND_GROUP_METADATA = 39000;

/** How long a resolved room identity is reused before being re-read. */
const MEMO_TTL_MS = 60_000;

export interface RoomIdentity {
  title?: string;
  /** Concord's encrypted icon pointer; the caller decrypts it. */
  iconPointer?: ImagePointer;
  iconUrl?: string;
}

/**
 * The slice of a control-fold snapshot a notification needs, read straight
 * from KV: `readControlFold` would reject a partially-unreadable fold.
 */
interface FoldNameSlice {
  metadata?: { name?: unknown; icon?: unknown };
  channels?: Map<string, { name?: unknown }>;
}

/** Mirrors `controlFoldKey` + `foldedCache`'s `folded:` namespace. */
function controlFoldKvKey(communityIdHex: string): string {
  return `folded:concord2-fold:${communityIdHex}`;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** An `{url, key, nonce, hash}` pointer, or undefined if it isn't one. */
function asImagePointer(value: unknown): ImagePointer | undefined {
  if (!value || typeof value !== "object") return undefined;
  const p = value as Record<string, unknown>;
  const url = asString(p.url);
  const key = asString(p.key);
  const nonce = asString(p.nonce);
  const hash = asString(p.hash);
  // All four or nothing: a bare URL is ciphertext that would render broken.
  return url && key && nonce && hash ? { url, key, nonce, hash } : undefined;
}

const memo = new Map<string, { at: number; identity: RoomIdentity }>();

function memoized(key: string): RoomIdentity | undefined {
  const hit = memo.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > MEMO_TTL_MS) {
    memo.delete(key);
    return undefined;
  }
  return hit.identity;
}

function remember(key: string, identity: RoomIdentity): RoomIdentity {
  memo.set(key, { at: Date.now(), identity });
  if (memo.size > 64) {
    const oldest = memo.keys().next().value;
    if (oldest !== undefined && oldest !== key) memo.delete(oldest);
  }
  return identity;
}

/** Concord identity: "Community / #channel" plus the encrypted icon pointer (as the Java service does). */
export async function concordRoomIdentity(
  communityIdHex: string,
  channelIdHex: string,
): Promise<RoomIdentity> {
  const key = `c2:${communityIdHex}:${channelIdHex}`;
  const cached = memoized(key);
  if (cached) return cached;

  let identity: RoomIdentity = {};
  try {
    const json = await getArmadaDB().kv.get<string>(controlFoldKvKey(communityIdHex));
    const fold = typeof json === "string" ? decode<FoldNameSlice>(json) : undefined;
    const community = asString(fold?.metadata?.name);
    const channel = asString(fold?.channels?.get(channelIdHex)?.name);
    identity = {
      title: community && channel
        ? `${community} / #${channel}`
        : community ?? (channel ? `#${channel}` : undefined),
      iconPointer: asImagePointer(fold?.metadata?.icon),
    };
  } catch { /* ignore */ }
  return remember(key, identity);
}

/** NIP-29 identity from relay-signed kind 39000, read from that relay's tenant (see `relayScope.ts`). */
export async function nip29RoomIdentity(
  relayUrl: string,
  groupId: string,
): Promise<RoomIdentity> {
  const key = `h:${relayUrl}|${groupId}`;
  const cached = memoized(key);
  if (cached) return cached;

  let identity: RoomIdentity = {};
  try {
    const store = await appEventStore();
    const [ev] = await store.query(
      [{ kinds: [KIND_GROUP_METADATA], "#d": [groupId], limit: 1 }],
      { relay: relayUrl },
    );
    if (ev) {
      const tagValue = (name: string) => asString(ev.tags.find((t) => t[0] === name)?.[1]);
      identity = { title: tagValue("name"), iconUrl: tagValue("picture") };
    }
  } catch { /* ignore */ }
  return remember(key, identity);
}
