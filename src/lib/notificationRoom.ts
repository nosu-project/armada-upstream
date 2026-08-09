/**
 * Who a notification is FROM, at the room level: the conversation's title and
 * its image.
 *
 * Android gets this look from a long-lived conversation shortcut — the peer's
 * avatar for a DM, the community image for a channel — and it is the single
 * biggest reason its notifications read as conversations rather than as app
 * alerts. Web and Electron have one image slot and no shortcuts, so the same
 * effect comes from putting the room's image in `icon` and the room's name in
 * the title.
 *
 * Everything here is a LOCAL read: the ArmadaDB KV fold snapshot for Concord,
 * the per-relay NIP-29 tenant for groups. A notification is the one surface
 * with no time to wait on a relay, so a room this can't name simply isn't
 * named — the caller falls back to the sender, exactly as the Android service
 * falls back to the app icon.
 *
 * Deliberately free of React and of `@/concord/lib/control`: the service worker
 * bundles this module, where no hook exists and where pulling in the whole
 * control-fold machinery (and the legacy-database drain behind `readFolded`)
 * would be both heavy and wrong — migrations are the page's job.
 */

import { getArmadaDB } from "@/lib/db/armadaDB";
import { appEventStore } from "@/lib/db/mainEventStore";
import { decode } from "@/lib/foldedCache";

import type { ImagePointer } from "@/concord/lib/types";

/** NIP-29 group metadata (addressable, relay-signed). */
const KIND_GROUP_METADATA = 39000;

/** How long a resolved room identity is reused before being re-read. */
const MEMO_TTL_MS = 60_000;

/** A room's display identity for a notification. */
export interface RoomIdentity {
  /** "Community / #channel", a NIP-29 group name, or undefined if unnamed. */
  title?: string;
  /** Concord's encrypted icon pointer — the caller decrypts it. */
  iconPointer?: ImagePointer;
  /** NIP-29's plain picture URL. */
  iconUrl?: string;
}

/**
 * The narrow slice of a folded control snapshot a notification needs.
 *
 * Read straight out of KV rather than through `readControlFold`, which
 * validates the WHOLE fold and would reject a snapshot this has no opinion
 * about. A name and an icon pointer are independently useful; there is nothing
 * here a partially-unreadable fold could make unsafe.
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
  // All four or nothing: a half-present pointer can't be decrypted, and a URL
  // on its own is ciphertext a browser would render as a broken image.
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
  // A flood in one room shouldn't grow this without bound; a handful of rooms
  // are live at once and the TTL evicts the rest anyway.
  if (memo.size > 64) {
    const oldest = memo.keys().next().value;
    if (oldest !== undefined && oldest !== key) memo.delete(oldest);
  }
  return identity;
}

/** Forget every memoized identity (a rename should show up promptly). */
export function forgetRoomIdentities(): void {
  memo.clear();
}

/**
 * A Concord channel's identity — "Community / #channel" plus the community's
 * encrypted icon pointer, matching the Java service's `community + " / #" +
 * channel` and its community-image shortcut.
 */
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
  } catch {
    // No fold on disk yet (a fresh join), or KV unavailable — stay unnamed.
  }
  return remember(key, identity);
}

/**
 * A NIP-29 group's identity from its relay-signed kind-39000 metadata.
 *
 * Scoped to the relay's own tenant, because a group id names nothing without
 * its relay — see `relayScope.ts`. `picture` is a bare URL here, not an
 * encrypted pointer: NIP-29 metadata is public by construction.
 */
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
  } catch {
    // Tenant unreadable — stay unnamed.
  }
  return remember(key, identity);
}
