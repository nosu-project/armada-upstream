/**
 * Synchronous last-known-good timeline snapshots, shared by every chat
 * transport (NIP-29 groups, Concord channels, DM threads, the DM conversation
 * list).
 *
 * Why this exists: the durable event store is IndexedDB, and the FIRST
 * IndexedDB read after a cold Android WebView launch pays a multi-second
 * connection penalty before anything can render — the "skeleton on every cold
 * open" problem. localStorage, by contrast, reads synchronously in
 * microseconds. So each timeline hook persists the last screenful of its
 * rendered messages here and seeds its TanStack query with it (`initialData`),
 * making the previous content paint on the very first frame; the IndexedDB
 * read and the relay refresh then merge in on top (every hook's merge path is
 * append-only/dedup-by-id, so the seed can never clobber fresher data).
 *
 * Storage shape:
 *   - `armada:snap:v1:<scope>` → encoded item array (newest MAX_ITEMS)
 *   - `armada:snap:index`      → LRU list of scopes (oldest first)
 *
 * A shared LRU across all transports bounds total usage to roughly
 * MAX_SCOPES × MAX_ITEMS messages (~a few hundred KB worst case).
 *
 * Values are encoded with the tagged codec from the Concord folded cache so
 * shapes containing `Uint8Array`/`bigint` (Concord's `OpenedMessage`) survive
 * the round-trip exactly.
 *
 * Trust note: Concord/DM snapshots persist DECRYPTED message plaintext at
 * rest. That is the same device-trust level as the existing caches — the
 * Concord folded cache and the signer's persistent decrypt cache both already
 * persist plaintext in IndexedDB, and the raw channel keys live in the event
 * store. Anyone with local storage access already has the keys. Snapshots use
 * the `armada:` prefix, so `purgeClientStorage` wipes them on logout.
 */

import { decode, encode } from "@/lib/concord/foldedCache";

const PREFIX = "armada:snap:v1:";
const INDEX_KEY = "armada:snap:index";

/** Most snapshotted conversations kept across ALL transports (shared LRU). */
const MAX_SCOPES = 16;
/** Newest items kept per conversation — roughly one screenful plus headroom. */
const MAX_ITEMS = 30;

// ── scope keys ────────────────────────────────────────────────────────────────

/** Snapshot scope for a NIP-29 group timeline. */
export function nip29SnapshotScope(relayUrl: string, groupId: string): string {
  return `nip29:${relayUrl}|${groupId}`;
}

/** Snapshot scope for a Concord channel timeline. */
export function concordSnapshotScope(channelIdHex: string): string {
  return `concord:${channelIdHex}`;
}

/** Snapshot scope for a 1:1 DM thread (self-scoped: DMs are per-account). */
export function dmThreadSnapshotScope(self: string, peer: string): string {
  return `dm:${self}|${peer}`;
}

/** Snapshot scope for the DM conversation list (newest event per peer). */
export function dmConversationsSnapshotScope(self: string): string {
  return `dmlist:${self}`;
}

// ── read / write ──────────────────────────────────────────────────────────────

function readIndex(): string[] {
  try {
    const raw = localStorage.getItem(INDEX_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : undefined;
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

function writeIndex(index: string[]): void {
  try {
    localStorage.setItem(INDEX_KEY, JSON.stringify(index));
  } catch {
    // Best-effort.
  }
}

/**
 * Read the snapshot for a scope, or undefined on miss/error. Synchronous —
 * safe to call from a TanStack `initialData` callback on the render path.
 */
export function readTimelineSnapshot<T>(scope: string | undefined): T[] | undefined {
  if (!scope || typeof localStorage === "undefined") return undefined;
  try {
    const raw = localStorage.getItem(PREFIX + scope);
    if (!raw) return undefined;
    const items = decode<T[]>(raw);
    return Array.isArray(items) && items.length > 0 ? items : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Persist the newest {@link MAX_ITEMS} of a timeline for a scope and bump it
 * in the shared LRU, evicting the least-recently-written scopes beyond
 * {@link MAX_SCOPES}. Best-effort: quota/serialization failures are swallowed
 * (the snapshot is purely an optimization).
 *
 * `items` must be ordered oldest-first (every timeline cache's order).
 */
export function writeTimelineSnapshot(scope: string | undefined, items: readonly unknown[]): void {
  if (!scope || typeof localStorage === "undefined") return;
  if (items.length === 0) return;
  try {
    const newest = items.slice(-MAX_ITEMS);
    localStorage.setItem(PREFIX + scope, encode(newest));

    const index = readIndex().filter((s) => s !== scope);
    index.push(scope);
    while (index.length > MAX_SCOPES) {
      const evicted = index.shift();
      if (evicted) {
        try {
          localStorage.removeItem(PREFIX + evicted);
        } catch {
          // ignore
        }
      }
    }
    writeIndex(index);
  } catch {
    // Quota exceeded / unavailable — snapshots are best-effort.
  }
}
