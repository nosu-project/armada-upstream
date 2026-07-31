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
import type { NRumorStore } from "@/lib/db/types";
import { readFolded, writeFolded } from "@/lib/foldedCache";
import type { NostrRumor } from "@/lib/nostrRumor";
import type { UnwrappedInvite } from "@/concord-v2/lib/directInvite";
import { KIND_DIRECT_INVITE } from "@/concord-v2/lib/kinds";

/** The shared pre-tenant database, drained into the tenants on first read. */
const LEGACY_DB_NAME = "armada-concord-invites";

/** NIP-59's outer-timestamp backdate window (the cursor rewinds this much). */
export const WRAP_BACKDATE_SECS = 2 * 24 * 60 * 60;

/** Synthetic provenance tags on the stored record (not part of the rumor). */
const TAG_WRAP = "wrap";
const TAG_SENDER = "sender";
const TAG_WRAP_CREATED = "wrapts";
/** Recipient scope — the account the wrap was addressed to. Single-letter so
 * NIndexedDB's tag index covers it (only single-letter tags are indexed). */
const TAG_RECIPIENT = "p";

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

function migrateLegacyInvites(recipient: string): Promise<void> {
  let drain = drains.get(recipient);
  if (!drain) {
    drain = drainLegacyInvites(recipient);
    drains.set(recipient, drain);
  }
  return drain;
}

async function drainLegacyInvites(recipient: string): Promise<void> {
  const db = getArmadaDB();
  const key = LEGACY_MIGRATION_KEY(recipient);
  if (await db.kv.get<boolean>(key)) return;

  try {
    const legacy = new NIndexedDB(LEGACY_DB_NAME);
    const events = await legacy.query([{ kinds: [KIND_DIRECT_INVITE], "#p": [recipient] }]);
    const tenant = db.tenant(`invites:${recipient}`);
    for (const event of events) {
      const { sig: _sig, ...rumor } = event;
      await tenant.event(rumor);
    }
    await legacy.close();
  } catch {
    // Failed part-way, or IndexedDB is unavailable. Leave the flag unset and
    // drop the memo so a later read retries: writes are keyed by wrap id, so
    // recopying what already landed costs nothing.
    drains.delete(recipient);
    return;
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
 * Build the stored record for an unwrapped invite. The record `id` is the WRAP
 * id (the inbox dedup key), `pubkey` the sender, `kind`/`content`/`tags` the
 * inner rumor. The wrap's own `created_at` is stashed in a tag so the cursor
 * can advance by it.
 *
 * No recipient tag: the tenant already names the account, and records drained
 * from the pre-tenant database carry one that {@link storedToInvite} strips.
 */
export function unwrappedToStored(wrap: NostrEvent, unwrapped: UnwrappedInvite): NostrRumor {
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
  };
}

const PROVENANCE = new Set([TAG_RECIPIENT, TAG_WRAP, TAG_SENDER, TAG_WRAP_CREATED]);

/** Reconstruct a StoredDirectInvite from a stored record. */
export function storedToInvite(ev: NostrRumor): StoredDirectInvite {
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
 * Persist decrypted invites addressed to `recipient` (fire-and-forget).
 * Failures are swallowed.
 */
export function writeStoredInvites(
  recipient: string,
  records: { wrap: NostrEvent; unwrapped: UnwrappedInvite }[],
): void {
  if (records.length === 0) return;
  const s = inviteInbox(recipient);
  void Promise.all(
    records.map(({ wrap, unwrapped }) => s.event(unwrappedToStored(wrap, unwrapped))),
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
