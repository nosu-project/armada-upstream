/**
 * The "last outgoing message" ledger behind Android's Direct Share suggestions.
 *
 * A share suggestion should name the rooms the user TALKS TO. Neither of the
 * two signals the app had answered that question: the publisher ranked DM
 * conversations by `latest.createdAt` — the newest message in the thread
 * whoever sent it, so a chatty stranger outranked someone messaged daily — and
 * the notification service pushed a shortcut per INCOMING notification, which
 * is the same mistake with the sender inverted.
 *
 * So record the one fact that is actually being ranked by: when the viewer last
 * sent to a room. Keyed by the room's ROUTE, which is the same id the shortcut
 * itself carries (see `ShareTargetPlugin.publishShortcuts`), so a DM, a Concord
 * channel and a NIP-29 group are one kind of entry rather than three.
 *
 * Deliberately LOCAL — ArmadaDB KV, never a NIP-78 document. This is
 * device-scoped Android UX with no meaning on another client, and a synced list
 * of every room the user writes in is exactly the shape the "never publish a
 * user's lists" rule in AGENTS.md exists to prevent, for no benefit here.
 *
 * The DM side has a second, better source that costs nothing: the NIP-17
 * conversation query already reads `distinct:convmine` (the newest message the
 * viewer authored, per conversation) and used to reduce it to a boolean. That
 * timestamp is durable and survives a reinstall, so `useShareShortcuts` takes
 * whichever of the two is newer. This ledger is what gives COMMUNITIES the same
 * signal, since nothing else records an outgoing Concord/NIP-29 send.
 */

import { KvPrefixCache } from "@/lib/db/kvCache";

/** One room the viewer has sent to. */
export interface LastSentEntry {
  /** Unix SECONDS the viewer last sent here — the same clock as `created_at`. */
  sentAt: number;
  /**
   * The room's display name, captured at send time.
   *
   * Stored rather than resolved at publish time because resolving it later
   * would put Concord and NIP-29 lookups inside a hook that runs in
   * `MainLayout`, where neither community nor group state is loaded. The
   * sending page already knows what the room is called, and re-captures it on
   * every send, so a rename settles the next time the user writes there.
   *
   * DMs pass none: `useShareShortcuts` resolves those from the kind-0 profiles
   * in the local event store, which keeps a renamed contact fresh without a
   * send.
   */
  label?: string;
  /** Room avatar (community image / group picture) to fetch native-side. */
  iconUrl?: string;
}

/**
 * How many rooms to remember. Bounded because `KvPrefixCache` holds its whole
 * prefix in memory — and because a suggestion list is a handful of slots, so
 * anything past the most recent few dozen rooms can never be published.
 */
const MAX_ROOMS = 32;

const cache = new KvPrefixCache<LastSentEntry>({ prefix: "share-sent:" });

/**
 * Entry id: `<pubkey>:<route>`.
 *
 * Scoped by account because KV is not — an account SWITCH resets the caches but
 * only a final logout purges the database, so an unscoped ledger would suggest
 * the previous account's rooms. A pubkey is hex, so splitting on the first
 * colon recovers the route whatever the route contains.
 */
function entryId(self: string, route: string): string {
  return `${self}:${route}`;
}

function splitId(id: string): { self: string; route: string } | null {
  const cut = id.indexOf(":");
  if (cut <= 0) return null;
  return { self: id.slice(0, cut), route: id.slice(cut + 1) };
}

/**
 * Note that `self` just sent to `route`, which must be a ROOM path (no `/t/` or
 * `/m/` focus — see `roomPath`), so a thread reply and a permalinked message
 * both credit the room they are in.
 *
 * Fire-and-forget, like every other write on the send path: a suggestion that
 * doesn't update is not worth failing a message over.
 */
export function recordSent(
  self: string,
  route: string,
  meta?: { label?: string; iconUrl?: string },
): void {
  if (!self || !route) return;
  const entry: LastSentEntry = { sentAt: Math.floor(Date.now() / 1000) };
  if (meta?.label) entry.label = meta.label;
  if (meta?.iconUrl) entry.iconUrl = meta.iconUrl;
  cache.set(entryId(self, route), entry);
  // Pruning needs the warm, which the write above does not wait for. Doing it
  // after means a cold process can briefly hold more than the cap, which costs
  // nothing — the cap bounds memory, it is not a correctness property.
  void cache.ready().then(() => prune(self)).catch(() => undefined);
}

/** Drop this account's oldest entries past {@link MAX_ROOMS}. */
function prune(self: string): void {
  const mine = readAll(self);
  if (mine.length <= MAX_ROOMS) return;
  for (const { route } of mine.slice(MAX_ROOMS)) cache.delete(entryId(self, route));
}

/** This account's rooms, newest send first. Synchronous; empty before the warm. */
function readAll(self: string): { route: string; entry: LastSentEntry }[] {
  const rows: { route: string; entry: LastSentEntry }[] = [];
  for (const id of cache.ids()) {
    const parts = splitId(id);
    if (!parts || parts.self !== self) continue;
    const entry = cache.get(id);
    if (!entry || typeof entry.sentAt !== "number") continue;
    rows.push({ route: parts.route, entry });
  }
  return rows.sort((a, b) => b.entry.sentAt - a.entry.sentAt);
}

/**
 * This account's rooms, newest send first. Synchronous, and empty until
 * {@link warmSentRooms} resolves.
 */
export function sentRooms(self: string): { route: string; entry: LastSentEntry }[] {
  return self ? readAll(self) : [];
}

/** Fill the ledger from KV. Idempotent and shared by concurrent callers. */
export function warmSentRooms(): Promise<void> {
  return cache.ready();
}

/**
 * Re-publish when the ledger changes.
 *
 * The publisher can't key a React effect on this the way it does on the DM
 * conversation list: the ledger is written from the send path, outside render,
 * and routing it through component state would re-render the app's whole
 * layout once per message sent for a background nicety.
 */
export function subscribeSentRooms(listener: () => void): () => void {
  return cache.subscribe(listener);
}
