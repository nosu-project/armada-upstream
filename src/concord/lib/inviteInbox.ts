/**
 * Concord direct-invite inbox — the decrypted giftwrap-invite cache.
 *
 * The invite inbox is the indexed lookup CORD-05 §6 defines:
 * `{ kinds: [1059], "#p": [me], "#k": ["3313"] }` — exactly the user's
 * invites, never the whole giftwrap backlog. Opening each wrap is still two
 * NIP-44 decrypts (costly with a bunker signer), so the DECRYPTED rumor is
 * persisted once and read back from IndexedDB with no re-decrypt, and a
 * persisted cursor means only wraps newer than the last sync are fetched.
 *
 * Backed by one ArmadaDB tenant PER RECIPIENT (`invites:<pubkey>`). Stored
 * records are keyed by the WRAP id (the inbox dedup key) and carry the seal
 * author (sender) and the wrap's `created_at`.
 *
 * The per-recipient tenant is what keeps accounts apart. A decrypted invite
 * persisted while account A was active must never be read back — and parked —
 * for account B after an account switch, which would flood B with A's
 * community invites. This used to be a shared database with every read scoped
 * by an `#p` recipient tag; the tenant makes the isolation structural, so a
 * read has no way to reach another account's invites even if it forgets to
 * ask. Every tenant is still wiped on final logout.
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

import { getArmadaDB } from "@/lib/db/armadaDB";
import { skipLegacyDrain } from "@/lib/db/legacyDatabases";
import type { NRumorStore } from "@/lib/db/types";
import { readFolded, writeFolded } from "@/lib/foldedCache";
import type { NostrRumor } from "@/lib/nostrRumor";
import type { UnwrappedInvite } from "@/concord/lib/directInvite";
import { KIND_DIRECT_INVITE } from "@/concord/lib/kinds";

/** The shared pre-tenant database, drained into the tenants on first read. */
const LEGACY_DB_NAME = "armada-concord-invites";

/** NIP-59's outer-timestamp backdate window (the cursor rewinds this much). */
export const WRAP_BACKDATE_SECS = 2 * 24 * 60 * 60;

/** The invite tenant for one account (opens in the background on first use). */
export function inviteInbox(recipient: string): NRumorStore {
  return getArmadaDB().tenant(`invites:${recipient}`);
}

/**
 * Warm an account's invite tenant so the first inbox read hits a hot store,
 * and drain anything the pre-tenant shared database still holds for it.
 */
export function warmInviteInbox(recipient: string): void {
  void migrateLegacyInvites(recipient).catch(() => undefined);
}

// ── Legacy drain ────────────────────────────────────────────────────────────
//
// Invites used to live in one shared database scoped by an `#p` tag. Dropping
// it on upgrade would empty the invite list for good: the sync cursor is
// already past those wraps, so nothing would refetch them. So the first read
// per account copies that account's records across, once, and records that it
// did in ArmadaDB's KV. The legacy database is left in place (it is small, and
// another account may not have migrated yet); logout deletes it either way.

const LEGACY_MIGRATION_KEY = (recipient: string) => `invites:migrated:${recipient}`;

/** In-flight/settled drains, so concurrent reads share one pass. */
const drains = new Map<string, Promise<void>>();

/**
 * Copy `recipient`'s invites out of the shared database. Idempotent, memoised,
 * and REJECTS on failure — the startup gate deletes the shared database once
 * every drain has resolved for every account, so a swallowed error here would
 * read as a finished copy and take the invites with it.
 */
export function migrateLegacyInvites(recipient: string): Promise<void> {
  let drain = drains.get(recipient);
  if (!drain) {
    drain = drainLegacyInvites(recipient).catch((err: unknown) => {
      // Drop the memo so a later read retries: writes are keyed by wrap id, so
      // recopying what already landed costs nothing.
      drains.delete(recipient);
      throw err;
    });
    drains.set(recipient, drain);
  }
  return drain;
}

async function drainLegacyInvites(recipient: string): Promise<void> {
  const db = getArmadaDB();
  const key = LEGACY_MIGRATION_KEY(recipient);
  if (await db.kv.get<boolean>(key)) return;
  // `NIndexedDB` CREATES the database on its first query, which would leave a
  // device that never had one with the very database the startup gate scans
  // for. See `skipLegacyDrain`.
  if (await skipLegacyDrain(LEGACY_DB_NAME)) return;

  const legacy = new NIndexedDB(LEGACY_DB_NAME);
  try {
    const events = await legacy.query([{ kinds: [KIND_DIRECT_INVITE], "#p": [recipient] }]);
    const tenant = db.tenant(`invites:${recipient}`);
    for (const event of events) {
      const { sig: _sig, ...rumor } = event;
      await tenant.event(rumor);
    }
  } finally {
    await legacy.close().catch(() => undefined);
  }

  await db.kv.set(key, true);
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
 * Build the stored record for an unwrapped invite.
 *
 * The record is keyed by the WRAP id (the inbox's dedup key) and carries the
 * verified sender as `pubkey` — which is the inner rumor's author too, since
 * the seal's signer IS the author. Its kind, content and tags are the rumor's,
 * untouched: those tags are the bytes the rumor's id commits to, and every
 * value that used to be folded into them is either already a field of this
 * record (the wrap id, the sender) or read by nothing (the wrap's own
 * `created_at` — the inbox cursor advances from the wraps in hand, not from
 * the store) or answered by the tenant (the recipient).
 */
export function unwrappedToStored(wrap: NostrEvent, unwrapped: UnwrappedInvite): NostrRumor {
  return {
    id: wrap.id,
    kind: unwrapped.rumor.kind,
    content: unwrapped.rumor.content,
    tags: unwrapped.rumor.tags,
    created_at: unwrapped.rumor.created_at,
    pubkey: unwrapped.sender,
  };
}

/** Reconstruct a StoredDirectInvite from a stored record. */
export function storedToInvite(ev: NostrRumor): StoredDirectInvite {
  return {
    wrapId: ev.id,
    sender: ev.pubkey,
    rumor: {
      kind: ev.kind,
      content: ev.content,
      tags: ev.tags,
      created_at: ev.created_at,
      pubkey: ev.pubkey,
    },
  };
}

// ── Reads / writes ──────────────────────────────────────────────────────────

/**
 * The cached direct-invite rumors (kind 3313) addressed to `recipient`, newest
 * first. Read from that account's own tenant, so another logged-in profile's
 * invites are not merely filtered out — they are not in the database at all.
 */
export async function queryStoredInvites(
  recipient: string,
  opts?: { signal?: AbortSignal },
): Promise<StoredDirectInvite[]> {
  await migrateLegacyInvites(recipient).catch(() => undefined);
  const rumors = await inviteInbox(recipient).query([{ kinds: [KIND_DIRECT_INVITE] }], {
    signal: opts?.signal,
  });
  return rumors.map(storedToInvite);
}

/**
 * Persist decrypted invites addressed to `recipient`. Failures are swallowed.
 *
 * Returns the settling promise so a caller that must re-read the store right
 * after (the live wire wake) can await the write and see its own row; existing
 * fire-and-forget callers simply don't await it.
 */
export function writeStoredInvites(
  recipient: string,
  records: { wrap: NostrEvent; unwrapped: UnwrappedInvite }[],
): Promise<void> {
  if (records.length === 0) return Promise.resolve();
  const s = inviteInbox(recipient);
  return Promise.all(
    records.map(({ wrap, unwrapped }) => s.event(unwrappedToStored(wrap, unwrapped))),
  )
    .then(() => undefined)
    .catch(() => undefined);
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

// ── Live invite-wrap buffer ───────────────────────────────────────────────────
//
// The wire's standing DM subscription (`{kinds:[1059], "#p":[me]}`) delivers
// direct-invite wraps too — they are the same kind, distinguished only by the
// outer `#k`=3313 hint. The wire can't decrypt them (that needs the user's
// NIP-44 + the consent gate, both owned by the invite hook), so it BUFFERS the
// in-hand wrap here and rings `c2inv:wrap`, exactly as it buffers a live DM wrap
// and rings `dm:wrap`. The invite hook drains and decrypts directly — no relay
// re-fetch (which re-pays NIP-42 auth) — so a received invite lands ~instantly
// instead of waiting on the 5-minute poll. Ciphertext only, never persisted.
//
// A session-seen id set makes buffering idempotent: the wrap filter rewinds
// `since` by the NIP-59 backdate window, so every fresh round replays recent
// wraps and only genuinely new arrivals ring the doorbell.

/** Cap on buffered live invite wraps (a burst past this falls back to the poll). */
const LIVE_INVITE_CAP = 256;
/** Cap on remembered wrap ids (oldest halves are shed — the poll dedupes deeper). */
const LIVE_INVITE_SEEN_CAP = 4096;
const liveInviteWraps = new Map<string, NostrEvent>();
/** Ids ever accepted into the buffer this session (replay dedupe). */
const liveInviteSeen = new Set<string>();

function rememberLiveInvite(id: string): void {
  if (liveInviteSeen.size >= LIVE_INVITE_SEEN_CAP) {
    let drop = LIVE_INVITE_SEEN_CAP >> 1;
    for (const old of liveInviteSeen) {
      liveInviteSeen.delete(old);
      if (--drop <= 0) break;
    }
  }
  liveInviteSeen.add(id);
}

/** True when a wrap's NIP-40 `expiration` tag has already passed. */
function wrapExpired(tags: readonly string[][], nowSecs: number): boolean {
  for (const [name, value] of tags) {
    if (name !== "expiration") continue;
    const at = Number(value);
    if (Number.isFinite(at) && at <= nowSecs) return true;
  }
  return false;
}

/**
 * Stash raw invite gift wraps the wire received live. Returns the wraps actually
 * accepted — ids already seen this session (a replayed round) are skipped, so
 * the caller can gate the `c2inv:wrap` doorbell on genuinely new arrivals.
 */
export function bufferLiveInviteWraps(wraps: NostrEvent[]): NostrEvent[] {
  const fresh: NostrEvent[] = [];
  const now = Math.floor(Date.now() / 1000);
  for (const w of wraps) {
    // A dead handoff is dropped on arrival — never buffered, never decrypted,
    // never allowed to ring the doorbell for an invite that no longer exists.
    if (wrapExpired(w.tags, now)) continue;
    if (liveInviteSeen.has(w.id)) continue;
    if (liveInviteWraps.size >= LIVE_INVITE_CAP) continue;
    rememberLiveInvite(w.id);
    liveInviteWraps.set(w.id, w);
    fresh.push(w);
  }
  return fresh;
}

/**
 * Put drained wraps BACK (a consent-gate decline deferred the decrypt). This
 * bypasses the session-seen skip — the ids were marked seen when first
 * buffered — so a later allow / the poll backstop can drain them again.
 */
export function rebufferLiveInviteWraps(wraps: NostrEvent[]): void {
  for (const w of wraps) {
    if (liveInviteWraps.size >= LIVE_INVITE_CAP && !liveInviteWraps.has(w.id)) continue;
    liveInviteWraps.set(w.id, w);
  }
}

/** Whether any live invite wraps are currently buffered awaiting a drain. */
export function hasBufferedLiveInviteWraps(): boolean {
  return liveInviteWraps.size > 0;
}

/** Take (and clear) the buffered live invite wraps for decryption by the hook. */
export function drainLiveInviteWraps(): NostrEvent[] {
  if (liveInviteWraps.size === 0) return [];
  const out = [...liveInviteWraps.values()];
  liveInviteWraps.clear();
  return out;
}

/** Reset the buffer AND the session-seen ids (tests only). */
export function resetLiveInviteWraps(): void {
  liveInviteWraps.clear();
  liveInviteSeen.clear();
}
