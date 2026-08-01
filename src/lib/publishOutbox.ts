/**
 * The publish outbox: signed events that have not yet been accepted by a relay.
 *
 * This is the app's durable record of events the user has actually authored —
 * a message written offline, a profile edit made while every relay was down. It
 * is the ONLY place a signed event survives with its signature intact: the
 * event store drops `sig` (see `db/mainEventStore.ts`), so an event read back
 * from there can never be re-published. Retry paths must source from here.
 *
 * Stored in ArmadaDB's KV as ONE ENTRY PER EVENT, keyed `outbox:<eventId>`,
 * rather than a single array under one key. The array shape was safe only
 * because localStorage is synchronous, which made its read-modify-write atomic
 * within a tick; KV is async, so two concurrent `queueSignedEvent` calls would
 * both read the same array and one would lose its entry — dropping a message
 * the user believes was sent. Per-event keys remove the shared cell entirely.
 *
 * Wiped on logout by `purgeArmadaDB`. One behavior change from the localStorage
 * era: where IndexedDB is unavailable (iOS Lockdown Mode, some private-browsing
 * contexts) the KV degrades to a no-op, so the queue no longer survives a
 * reload there. Delivery still works; only the retry-after-restart does not.
 */
import { getArmadaDB } from "@/lib/db/armadaDB";
import { isSigned } from "@/lib/nostrRumor";

import type { NostrEvent } from "@nostrify/nostrify";
import type { NostrRumor } from "@/lib/nostrRumor";

/** Key prefix for one queued publish; the suffix is the event id. */
const KEY_PREFIX = "outbox:";
/** Pre-ArmadaDB localStorage key, drained by {@link migrateLegacyOutbox}. */
const LEGACY_KEY = "armada:publish-outbox";
const DONE_KEY = "outbox:migrated";

export interface QueuedPublish {
  id: string;
  event: NostrEvent;
  relay?: string;
  enqueuedAt: number;
  attempts: number;
  nextAttemptAt?: number;
  lastError?: string;
}

export class PublishQueuedError extends Error {
  readonly event: NostrEvent;
  readonly cause: unknown;

  constructor(event: NostrEvent, cause: unknown) {
    super("Event was signed and queued for retry");
    this.name = "PublishQueuedError";
    this.event = event;
    this.cause = cause;
  }
}

export function isPublishQueuedError(error: unknown): error is PublishQueuedError {
  return error instanceof PublishQueuedError || (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: string }).name === "PublishQueuedError"
  );
}

function itemKey(id: string): string {
  return `${KEY_PREFIX}${id}`;
}

function isQueuedPublish(value: unknown): value is QueuedPublish {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<QueuedPublish>;
  return Boolean(
    item.id &&
    typeof item.id === "string" &&
    item.event &&
    typeof item.event === "object" &&
    typeof item.event.id === "string" &&
    typeof item.event.pubkey === "string" &&
    typeof item.event.kind === "number" &&
    // A signature is the whole point of this queue: an entry without one can
    // never be delivered, so it is not a valid entry.
    typeof item.event.sig === "string" &&
    item.event.sig.length > 0 &&
    Array.isArray(item.event.tags)
  );
}

function replaceableKey(event: NostrEvent, relay?: string): string | null {
  const kind = event.kind;
  const relayPart = relay ?? "*";
  if (kind === 0 || kind === 3 || (kind >= 10000 && kind < 20000)) {
    return `${relayPart}:${kind}:${event.pubkey}`;
  }
  if (kind >= 30000 && kind < 40000) {
    const d = event.tags.find(([name]) => name === "d")?.[1] ?? "";
    return `${relayPart}:${kind}:${event.pubkey}:${d}`;
  }
  return null;
}

/** Every queued publish, oldest first (the order the flush should deliver in). */
export async function getQueuedPublishes(): Promise<QueuedPublish[]> {
  await migrateLegacyOutbox();
  const { kv } = getArmadaDB();
  const keys = await kv.keys(KEY_PREFIX);
  const items = await Promise.all(keys.map((key) => kv.get<QueuedPublish>(key)));
  return items
    .filter(isQueuedPublish)
    // `keys()` comes back in key order, i.e. by event id — meaningless here.
    .sort((a, b) => a.enqueuedAt - b.enqueuedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Queue a signed event for delivery. A repeat of the same id is a no-op. */
export async function queueSignedEvent(event: NostrEvent, relay?: string): Promise<void> {
  const { kv } = getArmadaDB();
  await migrateLegacyOutbox();

  if (await kv.get(itemKey(event.id))) return;

  // A replaceable coordinate only ever needs its newest edition delivered, so a
  // fresh one supersedes whatever is queued (and an older one is dropped).
  // Concurrent queues of the SAME coordinate can still both survive this
  // read-modify-write; that is self-healing — the flush delivers both and the
  // relay keeps the newer — unlike the lost writes the old shared array had.
  const coord = replaceableKey(event, relay);
  if (coord) {
    const conflicting = (await getQueuedPublishes()).filter(
      (item) => replaceableKey(item.event, item.relay) === coord,
    );
    const newest = conflicting.sort((a, b) => b.event.created_at - a.event.created_at)[0];
    if (newest && newest.event.created_at > event.created_at) return;
    await Promise.all(conflicting.map((item) => kv.delete(itemKey(item.id))));
  }

  await kv.set(itemKey(event.id), {
    id: event.id,
    event,
    relay,
    enqueuedAt: Date.now(),
    attempts: 0,
  } satisfies QueuedPublish);
}

/**
 * The signed form of `rumor` — itself when it still carries a signature, or the
 * outbox's copy when it does not.
 *
 * A retry hands back whatever the UI is holding, and timelines are fed from the
 * event store, which drops `sig`. This is the lookup that turns such a copy
 * back into something a relay will accept, and unlike the timeline it survives
 * a reload. Throws when no signed copy exists anywhere: that is a dead end for
 * the caller, and saying so beats handing a relay an event it will reject.
 */
export async function withSignature(rumor: NostrRumor): Promise<NostrEvent> {
  if (isSigned(rumor)) return rumor;
  await migrateLegacyOutbox();
  const item = await getArmadaDB().kv.get<QueuedPublish>(itemKey(rumor.id));
  if (isQueuedPublish(item)) return item.event;
  throw new Error("This message can no longer be sent: its signature was not kept.");
}

export async function removeQueuedPublish(id: string): Promise<void> {
  await getArmadaDB().kv.delete(itemKey(id));
}

/** Record a failed attempt and back the next one off (capped at 5 minutes). */
export async function markQueuedPublishFailure(id: string, error: unknown): Promise<void> {
  const { kv } = getArmadaDB();
  const item = await kv.get<QueuedPublish>(itemKey(id));
  if (!isQueuedPublish(item)) return;

  const attempts = item.attempts + 1;
  const backoff = Math.min(5 * 60_000, 2 ** Math.min(attempts, 8) * 1000);
  await kv.set(itemKey(id), {
    ...item,
    attempts,
    lastError: error instanceof Error ? error.message : String(error),
    nextAttemptAt: Date.now() + backoff,
  });
}

export async function clearPublishOutbox(): Promise<void> {
  const { kv } = getArmadaDB();
  const keys = await kv.keys(KEY_PREFIX);
  await Promise.all(keys.map((key) => kv.delete(key)));
}

// ── migration ─────────────────────────────────────────────────────────────────

let drain: Promise<void> | undefined;

/**
 * Copy the pre-ArmadaDB localStorage queue into KV. Idempotent; runs at most
 * once per session, and is awaited by every accessor rather than driven by the
 * startup migration gate — that catalogue deletes IndexedDB *databases*, and
 * this legacy store is a localStorage key.
 *
 * The legacy key is removed only after the copy is confirmed readable. KV
 * degrades to a silent no-op when IndexedDB is unavailable, so deleting on the
 * strength of an unverified write would discard undelivered messages on exactly
 * the devices least able to spare them.
 */
export function migrateLegacyOutbox(): Promise<void> {
  drain ??= drainLegacyOutbox();
  return drain;
}

async function drainLegacyOutbox(): Promise<void> {
  if (typeof localStorage === "undefined") return;
  const { kv } = getArmadaDB();

  try {
    if (await kv.get<boolean>(DONE_KEY)) return;

    const raw = localStorage.getItem(LEGACY_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) {
      for (const item of parsed.filter(isQueuedPublish)) {
        await kv.set(itemKey(item.id), item);
      }
    }

    await kv.set(DONE_KEY, true);
    // Confirm the write actually landed before dropping the only other copy.
    if (await kv.get<boolean>(DONE_KEY)) localStorage.removeItem(LEGACY_KEY);
  } catch {
    // Retry next launch rather than marking a partial copy done.
    drain = undefined;
  }
}

/** Test seam: forget the memoised drain so the next access runs it again. */
export function __resetOutboxForTests(): void {
  drain = undefined;
}
