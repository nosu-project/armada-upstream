/**
 * Concord V2 direct-invite inbox — the decrypted giftwrap-invite cache.
 *
 * The invite inbox is the indexed lookup CORD-05 §6 defines:
 * `{ kinds: [1059], "#p": [me], "#k": ["3313"] }` — exactly the user's
 * invites, never the whole giftwrap backlog. Opening each wrap is still two
 * NIP-44 decrypts (costly with a bunker signer), so the DECRYPTED rumor is
 * persisted once and read back from IndexedDB with no re-decrypt, and a
 * persisted cursor means only wraps newer than the last sync are fetched.
 *
 * Backed by `@nostrify/indexeddb` (the strfry-port NStore), a SEPARATE
 * database from `armada-events` (which never stores gift wraps at all — see
 * NostrBatcher.cacheEvents). Stored records are keyed by the WRAP id (the
 * inbox dedup key), carry the seal author (sender), the wrap's `created_at`,
 * and the RECIPIENT (the account the wrap was addressed to), and are sig-less.
 *
 * The recipient is stamped as an indexed single-letter `#p` tag and every read
 * is scoped to it: the store is one database shared by every logged-in profile,
 * so without this scope a decrypted invite persisted while account A was active
 * would be read back — and parked — for account B after an account switch,
 * flooding B with A's community invites. Reads return ONLY the active account's
 * invites; the whole database is still wiped on final logout.
 *
 * The `since` cursor resumes from the newest wrap already scanned. NIP-59
 * backdates the outer `created_at` up to two days, so the cursor rewinds that
 * window on every resume — cheap, because the `#k` filter keeps the overlap to
 * invites alone and the store dedups re-fetched wraps before decrypting.
 *
 * Trust note: this persists decrypted invite metadata at rest — the same
 * device-trust level as the folded caches already in use. Wiped on logout.
 */

import { NIndexedDB } from "@nostrify/indexeddb";
import type { NostrEvent } from "@nostrify/nostrify";

import { readFolded, writeFolded } from "@/lib/foldedCache";
import type { UnwrappedInvite } from "@/concord-v2/lib/directInvite";
import { KIND_DIRECT_INVITE } from "@/concord-v2/lib/kinds";

const DB_NAME = "armada-concord-invites";

/** NIP-59's outer-timestamp backdate window (the cursor rewinds this much). */
export const WRAP_BACKDATE_SECS = 2 * 24 * 60 * 60;

/** Synthetic provenance tags on the stored record (not part of the rumor). */
const TAG_WRAP = "wrap";
const TAG_SENDER = "sender";
const TAG_WRAP_CREATED = "wrapts";
/** Recipient scope — the account the wrap was addressed to. Single-letter so
 * NIndexedDB's tag index covers it (only single-letter tags are indexed). */
const TAG_RECIPIENT = "p";

let store: NIndexedDB | undefined;

/** The singleton invite store (opens the DB in the background on first use). */
export function inviteInbox(): NIndexedDB {
  if (!store) store = new NIndexedDB(DB_NAME);
  return store;
}

/** Warm the IndexedDB connection so the first inbox read hits a hot store. */
export function warmInviteInbox(): void {
  try {
    void inviteInbox()
      .query([{ kinds: [KIND_DIRECT_INVITE], limit: 1 }])
      .catch(() => undefined);
  } catch {
    // IndexedDB unavailable — the store degrades to a no-op.
  }
}

// ── Codec ─────────────────────────────────────────────────────────────────────

/** A decrypted invite record read back from the store. */
export interface StoredDirectInvite {
  /** Gift-wrap event id (stable key + dedup). */
  wrapId: string;
  /** The seal author — the verified sender of the gift wrap. */
  sender: string;
  /** The decrypted inner rumor. */
  rumor: UnwrappedInvite["rumor"];
}

/**
 * Build the stored record for an unwrapped invite. The record `id` is the WRAP
 * id (the inbox dedup key), `pubkey` the sender, `kind`/`content`/`tags` the
 * inner rumor, `sig: ""`. The wrap's own `created_at` is stashed in a tag so
 * the cursor can advance by it, and `recipient` (the account the wrap was
 * addressed to) is stamped as an indexed `#p` tag so reads stay scoped to the
 * active account.
 */
export function unwrappedToStored(
  wrap: NostrEvent,
  unwrapped: UnwrappedInvite,
  recipient: string,
): NostrEvent {
  return {
    id: wrap.id,
    kind: unwrapped.rumor.kind,
    content: unwrapped.rumor.content,
    tags: [
      ...unwrapped.rumor.tags,
      // Recipient scope. A single-letter tag so NIndexedDB indexes it; direct-
      // invite rumors carry no tags of their own, so this `p` is unambiguously
      // provenance (stripped back off in storedToInvite).
      [TAG_RECIPIENT, recipient],
      [TAG_WRAP, wrap.id],
      [TAG_SENDER, unwrapped.sender],
      [TAG_WRAP_CREATED, String(wrap.created_at)],
    ],
    created_at: unwrapped.rumor.created_at,
    pubkey: unwrapped.sender,
    sig: "",
  };
}

const PROVENANCE = new Set([TAG_RECIPIENT, TAG_WRAP, TAG_SENDER, TAG_WRAP_CREATED]);

/** Reconstruct a StoredDirectInvite from a stored record. */
export function storedToInvite(ev: NostrEvent): StoredDirectInvite {
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

/**
 * The cached direct-invite rumors (kind 3313) addressed to `recipient`, newest
 * first. Scoped by the recipient `#p` tag so one profile never reads back the
 * invites another logged-in profile decrypted into this shared store.
 */
export async function queryStoredInvites(
  recipient: string,
  opts?: { signal?: AbortSignal },
): Promise<StoredDirectInvite[]> {
  const events = await inviteInbox().query(
    [{ kinds: [KIND_DIRECT_INVITE], "#p": [recipient] }],
    { signal: opts?.signal },
  );
  return events.map(storedToInvite);
}

/**
 * Persist decrypted invites addressed to `recipient` (fire-and-forget). Failures
 * are swallowed. The recipient is stamped so {@link queryStoredInvites} can scope
 * reads to the active account.
 */
export function writeStoredInvites(
  recipient: string,
  records: { wrap: NostrEvent; unwrapped: UnwrappedInvite }[],
): void {
  if (records.length === 0) return;
  const s = inviteInbox();
  void Promise.all(
    records.map(({ wrap, unwrapped }) => s.event(unwrappedToStored(wrap, unwrapped, recipient))),
  ).catch(() => undefined);
}

// ── Sync cursor ───────────────────────────────────────────────────────────────
//
// Per-user resume state: the newest wrap `created_at` ingested. Persisted in
// the folded cache. Resumes {@link WRAP_BACKDATE_SECS} behind the newest wrap
// already scanned, covering NIP-59's backdate window.

const cursorKey = (pubkey: string) => `concord2-invites-cursor:${pubkey}`;

/** The `since` floor to fetch invite wraps from (0 on a cold cache). */
export async function inviteInboxSince(pubkey: string): Promise<number> {
  const newest = (await readFolded<number>(cursorKey(pubkey))) ?? 0;
  return newest > WRAP_BACKDATE_SECS ? newest - WRAP_BACKDATE_SECS : 0;
}

/** Advance the cursor to the newest wrap `created_at` seen (monotonic). */
export async function advanceInviteInboxCursor(pubkey: string, newestWrapCreatedAt: number): Promise<void> {
  const prev = (await readFolded<number>(cursorKey(pubkey))) ?? 0;
  if (newestWrapCreatedAt > prev) await writeFolded(cursorKey(pubkey), newestWrapCreatedAt);
}
