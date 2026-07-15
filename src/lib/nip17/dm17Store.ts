/**
 * NIP-17 opened-DM cache — the decrypted store for the modern DM plane.
 *
 * Gift wraps are NEVER persisted (NostrBatcher already drops kind 1059 from
 * the shared cache): caching ciphertext would re-run two NIP-44 opens per
 * event on every cold read. Instead, wraps are opened once on sync and the
 * recovered rumor is persisted here as a signature-less event carrying its
 * real kind / author / content / tags, plus conversation provenance folded
 * into synthetic tags:
 *
 *   `peer` — the conversation partner (how threads and the list query);
 *   `wrap` — the carrier wrap id (debugging/provenance only).
 *
 * Backed by `@nostrify/indexeddb` in its own database, so its tag index and
 * NIP-09 semantics stay isolated (mirrors Concord's `rumorStore.ts`).
 *
 * Deletes ARE deletes: a kind-5 rumor written here triggers the store's
 * self-only NIP-09 pass, physically removing the targeted rumor its author
 * wrote — a peer deletes their own messages/reactions, never ours.
 *
 * Trust note: this persists DECRYPTED messages at rest — the same device-trust
 * level as the DM thread snapshots and the signer's decrypt cache. Wiped on
 * logout (see purgeClientStorage).
 */

import { NIndexedDB } from "@nostrify/indexeddb";
import type { NostrEvent } from "@nostrify/nostrify";

import { readFolded, writeFolded } from "@/lib/foldedCache";
import { DM_RUMOR_KINDS, KIND_DM_CHAT, KIND_DM_FILE, type OpenedDm } from "@/lib/nip17/protocol";
import { emitWireScopes } from "@/wire/bus";

const DB_NAME = "armada-dm17-rumors";

/** Provenance tags injected onto the stored event (never part of the rumor). */
const TAG_PEER = "peer";
const TAG_WRAP = "wrap";
const PROVENANCE = new Set([TAG_PEER, TAG_WRAP]);

/**
 * Index the tags DM queries need. The default NIndexedDB policy only indexes
 * single-letter tags; we additionally query by the multi-letter `peer`.
 */
function indexTags(event: NostrEvent): string[][] {
  return event.tags.filter(
    ([name, value]) =>
      typeof name === "string" &&
      typeof value === "string" &&
      value.length > 0 &&
      value.length < 200 &&
      (name.length === 1 || name === TAG_PEER),
  );
}

let store: NIndexedDB | undefined;

/** The singleton opened-DM store (opens the DB lazily on first use). */
export function dm17Store(): NIndexedDB {
  if (!store) store = new NIndexedDB(DB_NAME, { indexTags });
  return store;
}

// ── Codec: OpenedDm ⇆ stored event ───────────────────────────────────────────

/** Build the stored event for an opened DM rumor. */
export function dm17ToStored(opened: OpenedDm): NostrEvent {
  return {
    id: opened.rumorId,
    kind: opened.kind,
    content: opened.content,
    tags: [...opened.tags, [TAG_PEER, opened.peer], [TAG_WRAP, opened.wrapId]],
    created_at: opened.createdAt,
    pubkey: opened.author,
    sig: "",
  };
}

/** Reconstruct an OpenedDm from a stored event. */
export function storedToDm17(ev: NostrEvent): OpenedDm {
  return {
    rumorId: ev.id,
    author: ev.pubkey,
    kind: ev.kind,
    content: ev.content,
    tags: ev.tags.filter((t) => !PROVENANCE.has(t[0])),
    createdAt: ev.created_at,
    peer: ev.tags.find((t) => t[0] === TAG_PEER)?.[1] ?? "",
    wrapId: ev.tags.find((t) => t[0] === TAG_WRAP)?.[1] ?? "",
  };
}

// ── Reads / writes ────────────────────────────────────────────────────────────

/**
 * Persist opened DM rumors, then ring the wire bus's `dm` scope so every DM
 * surface (thread, conversation list, unread dot) re-reads. Kind-5 rumors
 * trigger the store's self-only NIP-09 removal of their targets. Best-effort;
 * resolves once the write commits.
 */
export async function writeDm17Rumors(opened: OpenedDm[]): Promise<void> {
  if (opened.length === 0) return;
  const s = dm17Store();
  await Promise.all(
    opened.map((o) =>
      s.event(dm17ToStored(o)).catch(() => {
        // Duplicate or rejected — the store's state is authoritative.
      }),
    ),
  );
  emitWireScopes(["dm"]);
}

/**
 * Read one conversation's cached rumors (messages, reactions, deletes),
 * newest-first up to `limit`. `before` (exclusive `created_at` upper bound)
 * pages older history out of the store.
 */
export async function queryDm17Thread(
  peer: string,
  opts: { limit: number; before?: number; signal?: AbortSignal },
): Promise<OpenedDm[]> {
  const filter: { kinds: number[]; "#peer": string[]; limit: number; until?: number } = {
    kinds: DM_RUMOR_KINDS,
    "#peer": [peer],
    limit: opts.limit,
  };
  if (opts.before !== undefined) filter.until = opts.before - 1;
  const events = await dm17Store().query([filter], { signal: opts.signal });
  return events.map(storedToDm17);
}

/**
 * The newest chat/file rumor per conversation partner — the NIP-17 side of
 * the conversation list. Reads the newest `limit` message rumors and groups
 * client-side (fine at DM scale; reactions/deletes never surface a peer).
 */
export async function queryDm17Conversations(
  opts: { limit?: number; signal?: AbortSignal } = {},
): Promise<Array<{ peer: string; latest: OpenedDm }>> {
  const events = await dm17Store().query(
    [{ kinds: [KIND_DM_CHAT, KIND_DM_FILE], limit: opts.limit ?? 500 }],
    { signal: opts.signal },
  );
  const byPeer = new Map<string, OpenedDm>();
  for (const ev of events) {
    const opened = storedToDm17(ev);
    if (!opened.peer) continue;
    const cur = byPeer.get(opened.peer);
    if (!cur || opened.createdAt > cur.createdAt) byPeer.set(opened.peer, opened);
  }
  return [...byPeer.entries()]
    .map(([peer, latest]) => ({ peer, latest }))
    .sort((a, b) => b.latest.createdAt - a.latest.createdAt);
}

/**
 * Every locally-cached chat/file rumor whose decrypted content matches
 * `query` (case-insensitive substring), across all conversation partners.
 * Purely local — the rumors are already decrypted at rest, so this never
 * prompts the signer. Newest-first, capped at `limit` matches.
 */
export async function searchDm17Rumors(
  query: string,
  opts: { limit?: number; scan?: number; signal?: AbortSignal } = {},
): Promise<OpenedDm[]> {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const events = await dm17Store().query(
    [{ kinds: [KIND_DM_CHAT, KIND_DM_FILE], limit: opts.scan ?? 2000 }],
    { signal: opts.signal },
  );
  const matches = events
    .map(storedToDm17)
    .filter((o) => o.peer && o.content.toLowerCase().includes(needle))
    .sort((a, b) => b.createdAt - a.createdAt);
  return matches.slice(0, opts.limit ?? 200);
}

// ── Sync cursor ───────────────────────────────────────────────────────────────
//
// The inbox scan's resume position, persisted so a cold launch tops up from
// where it left off instead of re-reading the whole `#p` backlog. Wrap
// timestamps are backdated ≤ 2 days (NIP-59), so consumers re-scan a slack
// window behind `newest` — see useDm17's RESYNC_SLACK.

/** The DM inbox's persisted sync position. */
export interface Dm17Cursor {
  /** `created_at` of the newest wrap ingested. */
  newest: number;
  /** `created_at` of the oldest wrap paged back to (the backfill `until`). */
  oldest: number;
  /** No relay had deeper history past `oldest` — stop older-backfills. */
  exhausted: boolean;
}

const cursorKey = (self: string) => `dm17-cursor:${self}`;

/** Read the viewer's inbox cursor, or undefined if none has been saved. */
export function readDm17Cursor(self: string): Promise<Dm17Cursor | undefined> {
  return readFolded<Dm17Cursor>(cursorKey(self));
}

/**
 * Merge sync progress into the cursor (best-effort). `newest` only advances,
 * `oldest` only recedes, `exhausted` is sticky.
 */
export async function updateDm17Cursor(self: string, patch: Partial<Dm17Cursor>): Promise<void> {
  const prev = await readDm17Cursor(self);
  const next: Dm17Cursor = {
    newest: Math.max(prev?.newest ?? 0, patch.newest ?? 0),
    oldest:
      patch.oldest !== undefined
        ? prev?.oldest
          ? Math.min(prev.oldest, patch.oldest)
          : patch.oldest
        : (prev?.oldest ?? 0),
    exhausted: patch.exhausted ?? prev?.exhausted ?? false,
  };
  await writeFolded(cursorKey(self), next);
}
