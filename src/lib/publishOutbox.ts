/**
 * Durable outbox of signed events not yet accepted by a relay — the ONLY place
 * a signed event keeps its `sig` (the event store drops it), so retries must
 * source from here. One KV entry per event (`outbox:<eventId>`): KV is async,
 * so a shared array's read-modify-write would lose entries. Wiped on logout.
 * Without IndexedDB, KV is a no-op and the queue doesn't survive reloads.
 */
import { getArmadaDB } from "@/lib/db/armadaDB";
import { uniqueRelayUrls } from "@/lib/nip65";
import { isSigned } from "@/lib/nostrRumor";

import type { NostrEvent } from "@nostrify/nostrify";
import type { NostrRumor } from "@/lib/nostrRumor";

const KEY_PREFIX = "outbox:";
/** Pre-ArmadaDB localStorage key, drained by {@link migrateLegacyOutbox}. */
const LEGACY_KEY = "armada:publish-outbox";
const DONE_KEY = "outbox:migrated";

export interface QueuedPublish {
  id: string;
  event: NostrEvent;
  relay?: string;
  /**
   * Exact account-state destinations still pending (separate from group `relay`).
   * Never fall back to the generic pool: one unrelated ack would hide a missing NIP-65 relay.
   */
  relays?: string[];
  enqueuedAt: number;
  attempts: number;
  nextAttemptAt?: number;
  lastError?: string;
  /** Drop undelivered after this time — for best-effort traffic whose relays may be gone. Absent for user-expected sends. */
  expiresAt?: number;
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

/** A lossy addressable rewrite must stop and rebuild from a fresh source read. */
export class PublishOutboxConflictError extends Error {
  constructor() {
    super("A newer queued edition requires a fresh source read");
    this.name = "PublishOutboxConflictError";
  }
}

/**
 * Serialize outbox edits globally: different ids can share a replaceable
 * coordinate, so per-id locks could lose a destination.
 */
let mutationChain: Promise<void> = Promise.resolve();

async function mutateOutbox(change: () => Promise<void>): Promise<void> {
  const current = mutationChain.then(change, change);
  mutationChain = current.catch(() => undefined);
  await current;
}

export function isPublishQueuedError(error: unknown): error is PublishQueuedError {
  return error instanceof PublishQueuedError || (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: string }).name === "PublishQueuedError"
  );
}

export function isPublishOutboxConflictError(
  error: unknown,
): error is PublishOutboxConflictError {
  return error instanceof PublishOutboxConflictError || (
    typeof error === "object"
    && error !== null
    && (error as { name?: string }).name === "PublishOutboxConflictError"
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
    // An entry without a signature can never be delivered.
    typeof item.event.sig === "string" &&
    item.event.sig.length > 0 &&
    Array.isArray(item.event.tags) &&
    !(item.relay && item.relays) &&
    (item.relays === undefined || (
      Array.isArray(item.relays)
      && item.relays.length > 0
      && item.relays.every((relay) => typeof relay === "string")
    ))
  );
}

function replaceableKey(event: NostrEvent, relay?: string, relays?: string[]): string | null {
  const kind = event.kind;
  // Explicit relay-set deliveries share one coordinate, so a newer replaceable
  // inherits the old one's pending targets when the NIP-65 set changes.
  const relayPart = relay ?? (relays ? "@explicit" : "*");
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
  const entries = await getArmadaDB().kv.list<QueuedPublish>({ prefix: KEY_PREFIX });
  const now = Date.now();
  const items = entries
    .map(({ value }) => value)
    // `outbox:migrated` shares the prefix, and is a boolean rather than an entry.
    .filter(isQueuedPublish);
  const expired = items.filter((item) => item.expiresAt !== undefined && item.expiresAt <= now);
  // Not awaited: this is also read inside an outbox mutation, which would deadlock.
  if (expired.length > 0) {
    void mutateOutbox(async () => {
      const { kv } = getArmadaDB();
      await Promise.all(expired.map((item) => kv.delete(itemKey(item.id))));
    }).catch(() => undefined);
  }
  return items
    .filter((item) => !expired.includes(item))
    // `list()` returns event-id order; sort by enqueue time.
    .sort((a, b) => a.enqueuedAt - b.enqueuedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Queue a signed event for delivery. A repeat of the same id is a no-op. */
export async function queueSignedEvent(
  event: NostrEvent,
  relay?: string,
  relays?: string[],
  options: { inheritPendingTargets?: boolean; expiresAt?: number } = {},
): Promise<void> {
  const { kv } = getArmadaDB();
  await migrateLegacyOutbox();
  if (!isSigned(event)) return;

  if (relay && relays) throw new Error("Specify either one relay or an explicit relay set");
  const exactRelays = relays ? uniqueRelayUrls(relays) : undefined;
  if (relays && exactRelays?.length === 0) {
    throw new Error("Cannot queue an explicit publish without a relay destination");
  }

  await mutateOutbox(async () => {
    const verify = async (
      id: string,
      requiredRelay?: string,
      requiredRelays?: readonly string[],
    ): Promise<QueuedPublish> => {
      const stored = await kv.get<QueuedPublish>(itemKey(id));
      const targets = new Set(stored?.relays ?? []);
      if (
        !isQueuedPublish(stored)
        || (requiredRelay !== undefined && stored.relay !== requiredRelay)
        || (requiredRelays !== undefined
          && requiredRelays.some((target) => !targets.has(target)))
      ) {
        // The degraded adapter resolves writes as no-ops; only a read-back proves durability.
        throw new Error("Publish outbox write could not be verified");
      }
      return stored;
    };

    const same = await kv.get<QueuedPublish>(itemKey(event.id));
    if (isQueuedPublish(same)) {
      if (exactRelays) {
        const mergedRelays = uniqueRelayUrls([...(same.relays ?? []), ...exactRelays]);
        await kv.set(itemKey(event.id), {
          ...same,
          relay: undefined,
          relays: mergedRelays,
        });
        await verify(event.id, undefined, mergedRelays);
      } else {
        await verify(event.id, relay);
      }
      return;
    }

    // Only the newest edition of a replaceable coordinate needs delivery; it
    // inherits the superseded event's targets.
    const coord = replaceableKey(event, relay, exactRelays);
    const conflicting = coord
      ? (await getQueuedPublishes()).filter(
          (item) => replaceableKey(item.event, item.relay, item.relays) === coord,
        )
      : [];
    const existingWinner = conflicting.sort(
      (a, b) => b.event.created_at - a.event.created_at || a.event.id.localeCompare(b.event.id),
    )[0];
    const existingWins = existingWinner && (
      existingWinner.event.created_at > event.created_at
      || (existingWinner.event.created_at === event.created_at && existingWinner.event.id < event.id)
    );
    const inheritPendingTargets = options.inheritPendingTargets !== false;
    if (existingWins) {
      if (!inheritPendingTargets) {
        // Sending this older signed mutation would regress relays; force a re-read/merge/sign.
        throw new PublishOutboxConflictError();
      }
      if (exactRelays) {
        const mergedRelays = uniqueRelayUrls([
          ...(existingWinner.relays ?? []),
          ...exactRelays,
        ]);
        await kv.set(itemKey(existingWinner.id), {
          ...existingWinner,
          relay: undefined,
          relays: mergedRelays,
        });
        await verify(existingWinner.id, undefined, mergedRelays);
      } else {
        await verify(existingWinner.id, relay);
      }
      return;
    }

    const inheritedRelays = exactRelays
      ? uniqueRelayUrls([
          ...exactRelays,
          ...(inheritPendingTargets
            ? conflicting.flatMap((item) => item.relays ?? [])
            : []),
        ])
      : undefined;
    const entry = {
      id: event.id,
      event,
      relay,
      relays: inheritedRelays,
      enqueuedAt: Date.now(),
      attempts: 0,
      ...(options.expiresAt !== undefined ? { expiresAt: options.expiresAt } : {}),
    } satisfies QueuedPublish;
    // Write and verify the replacement before removing its predecessor.
    await kv.set(itemKey(event.id), entry);
    await verify(event.id, relay, inheritedRelays);
    // Without inheritance, keep predecessor obligations for targets outside this source read.
    const replacementTargets = new Set(exactRelays ?? []);
    const cleanup = conflicting.map(async (item) => {
      if (!inheritPendingTargets && item.relays) {
        const remaining = item.relays.filter((target) => !replacementTargets.has(target));
        if (remaining.length > 0) {
          await kv.set(itemKey(item.id), { ...item, relays: remaining });
          return;
        }
      }
      await kv.delete(itemKey(item.id));
    });
    // A failed cleanup only leaves a redundant older retry; relays reject older editions anyway.
    await Promise.all(cleanup)
      .catch(() => undefined);
  });
}

/** Apply one exact-relay attempt: only attempted destinations that accepted are removed. */
export async function recordQueuedPublishAttempt(
  id: string,
  attemptedRelays: string[],
  rejectedRelays: string[],
): Promise<void> {
  const { kv } = getArmadaDB();
  const attempted = new Set(uniqueRelayUrls(attemptedRelays));
  const rejected = new Set(uniqueRelayUrls(rejectedRelays));
  await mutateOutbox(async () => {
    const item = await kv.get<QueuedPublish>(itemKey(id));
    if (!isQueuedPublish(item) || !item.relays) return;
    const remaining = item.relays.filter((relay) => !attempted.has(relay) || rejected.has(relay));
    if (remaining.length === 0) {
      await kv.delete(itemKey(id));
      return;
    }
    await kv.set(itemKey(id), { ...item, relay: undefined, relays: uniqueRelayUrls(remaining) });
  });
}

/**
 * `rumor` itself if still signed, else the outbox's signed copy (timelines come
 * from the store, which drops `sig`). Throws when no signed copy exists.
 */
export async function withSignature(rumor: NostrRumor): Promise<NostrEvent> {
  if (isSigned(rumor)) return rumor;
  await migrateLegacyOutbox();
  const item = await getArmadaDB().kv.get<QueuedPublish>(itemKey(rumor.id));
  if (isQueuedPublish(item)) return item.event;
  throw new Error("This message can no longer be sent: its signature was not kept.");
}

export async function removeQueuedPublish(id: string): Promise<void> {
  await mutateOutbox(() => getArmadaDB().kv.delete(itemKey(id)));
}

/** Record a failed attempt and back the next one off (capped at 5 minutes). */
export async function markQueuedPublishFailure(id: string, error: unknown): Promise<void> {
  await mutateOutbox(async () => {
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
  });
}

export async function clearPublishOutbox(): Promise<void> {
  await mutateOutbox(async () => {
    const { kv } = getArmadaDB();
    const entries = await kv.list({ prefix: KEY_PREFIX });
    await Promise.all(entries.map(({ key }) => kv.delete(key)));
  });
}

let drain: Promise<void> | undefined;

/**
 * Copy the legacy localStorage queue into KV, once per session, awaited by
 * every accessor. The legacy key is removed only after the copy is read back:
 * KV silently no-ops without IndexedDB.
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
    if (await kv.get<boolean>(DONE_KEY)) localStorage.removeItem(LEGACY_KEY);
  } catch {
    drain = undefined;
  }
}

/** Test seam: forget the memoised drain so the next access runs it again. */
export function __resetOutboxForTests(): void {
  drain = undefined;
  mutationChain = Promise.resolve();
}
