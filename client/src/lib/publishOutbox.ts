import type { NostrEvent } from "@nostrify/nostrify";

const OUTBOX_KEY = "armada:publish-outbox";

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

function readRaw(): QueuedPublish[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(OUTBOX_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isQueuedPublish);
  } catch {
    return [];
  }
}

function writeRaw(items: QueuedPublish[]): void {
  if (typeof localStorage === "undefined") return;
  try {
    if (items.length === 0) {
      localStorage.removeItem(OUTBOX_KEY);
    } else {
      localStorage.setItem(OUTBOX_KEY, JSON.stringify(items));
    }
  } catch {
    // Best-effort. A failed write should not block local signing or UI updates.
  }
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
    typeof item.event.sig === "string" &&
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

export function getQueuedPublishes(): QueuedPublish[] {
  return readRaw();
}

export function queueSignedEvent(event: NostrEvent, relay?: string): void {
  const now = Date.now();
  const existing = readRaw();
  const key = replaceableKey(event, relay);

  if (existing.some((item) => item.id === event.id)) return;

  let next = existing;
  if (key) {
    const conflicting = existing.filter((item) => replaceableKey(item.event, item.relay) === key);
    const newest = conflicting.sort((a, b) => b.event.created_at - a.event.created_at)[0];
    if (newest && newest.event.created_at > event.created_at) return;
    next = existing.filter((item) => replaceableKey(item.event, item.relay) !== key);
  }

  next.push({
    id: event.id,
    event,
    relay,
    enqueuedAt: now,
    attempts: 0,
  });
  writeRaw(next);
}

export function removeQueuedPublish(id: string): void {
  writeRaw(readRaw().filter((item) => item.id !== id));
}

export function markQueuedPublishFailure(id: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const now = Date.now();
  const next = readRaw().map((item) => {
    if (item.id !== id) return item;
    const attempts = item.attempts + 1;
    const backoff = Math.min(5 * 60_000, 2 ** Math.min(attempts, 8) * 1000);
    return {
      ...item,
      attempts,
      lastError: message,
      nextAttemptAt: now + backoff,
    };
  });
  writeRaw(next);
}

export function clearPublishOutbox(): void {
  writeRaw([]);
}
