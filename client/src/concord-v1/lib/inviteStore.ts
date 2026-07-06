/**
 * Concord V1 gift-wrap invite cache — the decrypted invite-inbox store.
 *
 * The invite inbox is a NIP-59 gift-wrap scan: `{ kinds: [1059], "#p": [me] }`.
 * Opening each wrap is two NIP-44 decrypts (costly with a bunker signer), and
 * the old inbox refetched all 200 wraps and re-decrypted them on every 60s poll.
 *
 * This persists the DECRYPTED invite rumor once, so the inbox reads back from
 * IndexedDB with no decrypt, and a persisted cursor means only wraps newer than
 * the last sync are fetched.
 *
 * Backed by `@nostrify/indexeddb` (the strfry-port NStore), a SEPARATE database
 * from `armada-events` (which never stores gift wraps at all — see
 * NostrBatcher.cacheEvents). Stored records are keyed by the WRAP id (the inbox
 * dedup key), carry the seal author (sender) and the wrap's `created_at`, and
 * are sig-less.
 *
 * NIP-59 backdate gotcha: `nip59.wrapEvent` randomizes the outer `created_at`
 * up to two days into the PAST. A naive `since = lastSeen` filter would miss a
 * freshly-published-but-backdated wrap, so the cursor's `since` is offset back
 * by {@link WRAP_BACKDATE_WINDOW_SECS}; the store's dedup-by-id absorbs the
 * resulting overlap.
 *
 * Trust note: this persists decrypted invite metadata at rest — the same
 * device-trust level as the folded caches already in use. Wiped on logout.
 */

import { NIndexedDB } from "@nostrify/indexeddb";
import type { NostrEvent } from "@nostrify/nostrify";

import { readFolded, writeFolded } from "@/lib/foldedCache";
import type { UnwrappedRumor } from "@/concord-v1/lib/giftwrap";

const DB_NAME = "armada-concord-invites";

/** NIP-59 wraps may be backdated up to 2 days; scan a hair beyond that. */
export const WRAP_BACKDATE_WINDOW_SECS = 2 * 24 * 60 * 60 + 60 * 60;

/** Synthetic provenance tags on the stored record (not part of the rumor). */
const TAG_WRAP = "wrap";
const TAG_SENDER = "sender";
const TAG_WRAP_CREATED = "wrapts";

let store: NIndexedDB | undefined;

/** The singleton invite store (opens the DB in the background on first use). */
export function inviteStore(): NIndexedDB {
  if (!store) store = new NIndexedDB(DB_NAME);
  return store;
}

/** Warm the IndexedDB connection so the first inbox read hits a hot store. */
export function warmInviteStore(): void {
  try {
    void inviteStore()
      .query([{ kinds: [3304], limit: 1 }])
      .catch(() => undefined);
  } catch {
    // IndexedDB unavailable — the store degrades to a no-op.
  }
}

// ── Codec ─────────────────────────────────────────────────────────────────────

/** A decrypted invite record read back from the store. */
export interface StoredInvite {
  /** Gift-wrap event id (stable key + dedup). */
  wrapId: string;
  /** The seal author — the real sender of the gift wrap. */
  sender: string;
  /** The decrypted inner rumor. */
  rumor: UnwrappedRumor["rumor"];
}

/**
 * Build the stored record for an unwrapped invite. The record `id` is the WRAP
 * id (the inbox dedup key), `pubkey` the sender, `kind`/`content`/`tags` the
 * inner rumor, `sig: ""`. The wrap's own `created_at` is stashed in a tag so the
 * cursor can advance by it.
 */
export function unwrappedToStored(wrap: NostrEvent, unwrapped: UnwrappedRumor): NostrEvent {
  return {
    id: wrap.id,
    kind: unwrapped.rumor.kind,
    content: unwrapped.rumor.content,
    tags: [
      ...unwrapped.rumor.tags,
      [TAG_WRAP, wrap.id],
      [TAG_SENDER, unwrapped.sender],
      [TAG_WRAP_CREATED, String(wrap.created_at)],
    ],
    created_at: unwrapped.rumor.created_at,
    pubkey: unwrapped.sender,
    sig: "",
  };
}

const PROVENANCE = new Set([TAG_WRAP, TAG_SENDER, TAG_WRAP_CREATED]);

/** Reconstruct a StoredInvite from a stored record. */
export function storedToInvite(ev: NostrEvent): StoredInvite {
  const tags = ev.tags.filter((t) => !PROVENANCE.has(t[0]));
  return {
    wrapId: ev.id,
    sender: ev.tags.find((t) => t[0] === TAG_SENDER)?.[1] ?? ev.pubkey,
    rumor: {
      kind: ev.kind,
      content: ev.content,
      tags,
      created_at: ev.created_at,
      pubkey: ev.pubkey,
    },
  };
}

// ── Reads / writes ──────────────────────────────────────────────────────────

/** All cached invite rumors for the current user (kind 3304), newest first. */
export async function queryInvites(opts?: { signal?: AbortSignal }): Promise<StoredInvite[]> {
  const events = await inviteStore().query([{ kinds: [3304] }], { signal: opts?.signal });
  return events.map(storedToInvite);
}

/** Persist decrypted invites (fire-and-forget). Failures are swallowed. */
export function writeInvites(records: { wrap: NostrEvent; unwrapped: UnwrappedRumor }[]): void {
  if (records.length === 0) return;
  const s = inviteStore();
  void Promise.all(records.map(({ wrap, unwrapped }) => s.event(unwrappedToStored(wrap, unwrapped)))).catch(
    () => undefined,
  );
}

// ── Sync cursor ───────────────────────────────────────────────────────────────
//
// Per-user resume state: the newest wrap `created_at` ingested. Persisted in the
// folded cache. The `since` filter subtracts the backdate window so a newly
// published but backdated wrap is still caught.

const cursorKey = (pubkey: string) => `concord-invites-cursor:${pubkey}`;

/** The `since` floor to fetch invite wraps from (0 on a cold cache). */
export async function inviteSince(pubkey: string): Promise<number> {
  const newest = (await readFolded<number>(cursorKey(pubkey))) ?? 0;
  if (newest === 0) return 0;
  return Math.max(0, newest - WRAP_BACKDATE_WINDOW_SECS);
}

/** Advance the cursor to the newest wrap `created_at` seen (monotonic). */
export async function advanceInviteCursor(pubkey: string, newestWrapCreatedAt: number): Promise<void> {
  const prev = (await readFolded<number>(cursorKey(pubkey))) ?? 0;
  if (newestWrapCreatedAt > prev) await writeFolded(cursorKey(pubkey), newestWrapCreatedAt);
}
