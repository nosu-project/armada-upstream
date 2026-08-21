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
import { uniqueRelayUrls } from "@/lib/nip65";
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
  /**
   * Exact account-state destinations still awaiting this signed event.
   * Kept separate from `relay`, which is the single host of group-scoped
   * traffic. A retry must not fall back to the generic pool: doing so can get
   * one unrelated acknowledgement while the missing NIP-65 relay remains
   * empty.
   */
  relays?: string[];
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

/** A lossy addressable rewrite must stop and rebuild from a fresh source read. */
export class PublishOutboxConflictError extends Error {
  constructor() {
    super("A newer queued edition requires a fresh source read");
    this.name = "PublishOutboxConflictError";
  }
}

/**
 * Serialize outbox edits. Different event ids can still name one replaceable
 * coordinate, so an id-scoped lock is insufficient: two same-coordinate
 * writes could both inspect the old queue, then independently delete/replace
 * it and lose a destination. The queue is tiny and mutations are local KV I/O,
 * making one short global chain the honest atomic boundary.
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
    // A signature is the whole point of this queue: an entry without one can
    // never be delivered, so it is not a valid entry.
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
  // All explicit relay-set deliveries share one logical coordinate. When the
  // NIP-65 set changes, a newer replaceable inherits every still-pending old
  // target instead of leaving an older event queued for the previous set.
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
  return entries
    .map(({ value }) => value)
    // `outbox:migrated` shares the prefix, and is a boolean rather than an entry.
    .filter(isQueuedPublish)
    // `list()` comes back in key order, i.e. by event id — meaningless here.
    .sort((a, b) => a.enqueuedAt - b.enqueuedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Queue a signed event for delivery. A repeat of the same id is a no-op. */
export async function queueSignedEvent(
  event: NostrEvent,
  relay?: string,
  relays?: string[],
  options: { inheritPendingTargets?: boolean } = {},
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
        // IndexedDB's degraded adapter deliberately resolves a write as a
        // no-op. Only a read-back makes "queued" a durable claim.
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

    // A replaceable coordinate only ever needs its newest edition delivered.
    // Explicit multi-relay state also INHERITS targets from the superseded
    // event, so rotating NIP-65 relays cannot strand an old version for an old
    // destination while only the new set receives the replacement.
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
        // Even a subset cohort is unsafe: `event` is an older signed mutation,
        // and sending it would regress any relay that does not yet hold the
        // newer queued winner. Force the caller back through read/merge/sign.
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
    } satisfies QueuedPublish;
    // Establish and verify the replacement before removing its predecessor.
    // If this write fails, the old signed obligation remains recoverable.
    await kv.set(itemKey(event.id), entry);
    await verify(event.id, relay, inheritedRelays);
    // With inheritance disabled, preserve predecessor obligations for every
    // target that did NOT participate in this document's source read. They can
    // coexist by event id until a later complete merge supersedes them.
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
    // A failed cleanup can only leave a redundant older retry. The verified
    // winner carries every destination it is allowed to receive; relays reject
    // an older addressable edition after accepting this one.
    await Promise.all(cleanup)
      .catch(() => undefined);
  });
}

/**
 * Apply one exact-relay delivery attempt. Relays added after the attempt began
 * remain queued; only attempted destinations that accepted are removed.
 */
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
  mutationChain = Promise.resolve();
}
