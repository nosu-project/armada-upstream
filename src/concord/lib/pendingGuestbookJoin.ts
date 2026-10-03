/**
 * This account's Guestbook Joins (CORD-02 §5) that no relay has accepted yet,
 * persisted so they are retried rather than dropped.
 *
 * The rumor is dated by the CLICK (`ms`), so a re-sign reproduces it and a later
 * Leave still outranks it. A sealed wrap is re-sent verbatim (relays dedupe it);
 * it is re-sealed only when the community's root epoch has moved on.
 */
import { buildJoinRumor, currentGuestbookGroup, sealGuestbook } from "@/concord/lib/guestbook";
import { KvPrefixCache } from "@/lib/db/kvCache";
import { logSync } from "@/lib/syncLog";

import type { NostrEvent } from "nostr-tools/pure";
import type { StreamSigner } from "@/concord/lib/stream";
import type { Community } from "@/concord/lib/types";

export interface PendingGuestbookJoin {
  viewer: string;
  communityIdHex: string;
  /** The Join's date: when the user chose to join. */
  ms: number;
  attribution?: { creator: string; label?: string };
  /** The sealed wrap and the root epoch it was sealed under. */
  wrap?: NostrEvent;
  epoch?: string;
  failures: number;
  nextAttemptAt: number;
  lastError?: string;
}

export interface JoinPublisher {
  relay(url: string): { event(event: NostrEvent, opts?: { signal?: AbortSignal }): Promise<unknown> };
}

/** Delay before the next attempt after `failures` misses. A re-sign asks the signer again, so it is slow. */
const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000, 60 * 60_000];
const PUBLISH_TIMEOUT_MS = 8000;

const cache = new KvPrefixCache<PendingGuestbookJoin>({ prefix: "c2gbjoin:" });
const keyOf = (viewer: string, communityIdHex: string) => `${viewer}:${communityIdHex}`;

/** Attempts running in this page, by key. */
const inFlight = new Set<string>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) {
    try {
      l();
    } catch {
      // A listener must never break a write.
    }
  }
}
cache.subscribe(notify);

export function subscribePendingGuestbookJoins(listener: () => void): () => void {
  void cache.ready();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function pendingGuestbookJoinsReady(): Promise<void> {
  return cache.ready();
}

export function getPendingGuestbookJoin(viewer: string, communityIdHex: string): PendingGuestbookJoin | undefined {
  return cache.get(keyOf(viewer, communityIdHex));
}

export function pendingGuestbookJoinsFor(viewer: string): PendingGuestbookJoin[] {
  return cache
    .ids()
    .map((id) => cache.get(id)!)
    .filter((r) => r && r.viewer === viewer);
}

export function isGuestbookJoinInFlight(viewer: string, communityIdHex: string): boolean {
  return inFlight.has(keyOf(viewer, communityIdHex));
}

/**
 * Record a Join to publish. The same Join (same date) queued again — a join
 * chain re-run — keeps its signed wrap and is just made due; a different one
 * replaces it.
 */
export function queueGuestbookJoin(join: Pick<PendingGuestbookJoin, "viewer" | "communityIdHex" | "ms" | "attribution">): void {
  const key = keyOf(join.viewer, join.communityIdHex);
  const prior = cache.get(key);
  if (prior && prior.ms === join.ms) {
    if (prior.nextAttemptAt !== 0) cache.set(key, { ...prior, nextAttemptAt: 0 });
    return;
  }
  cache.set(key, { ...join, failures: 0, nextAttemptAt: 0 });
}

/** The user left (or the community is gone): the Join must not go out after the Leave. */
export function forgetGuestbookJoin(viewer: string, communityIdHex: string): void {
  const key = keyOf(viewer, communityIdHex);
  if (cache.get(key) !== undefined) cache.delete(key);
}

/**
 * Seal (if needed) and publish the pending Join for `community`. Resolves true
 * once a relay accepts it, at which point the record is gone. Never throws;
 * concurrent calls for one community collapse into the first.
 */
export async function attemptGuestbookJoin(
  nostr: JoinPublisher,
  community: Community,
  signer: StreamSigner,
  viewer: string,
): Promise<boolean> {
  const key = keyOf(viewer, community.idHex);
  if (inFlight.has(key)) return false;
  const rec = cache.get(key);
  if (!rec) return false;
  inFlight.add(key);
  notify();
  try {
    const epoch = String(community.rootEpoch);
    let wrap = rec.wrap && rec.epoch === epoch ? rec.wrap : undefined;
    if (!wrap) {
      wrap = await sealGuestbook(
        buildJoinRumor(viewer, rec.ms, rec.attribution),
        currentGuestbookGroup(community),
        signer,
      );
      // A Leave while the signer was asked forgot the record: walk away.
      const now = cache.get(key);
      if (!now) return false;
      cache.set(key, { ...now, wrap, epoch });
    }
    const signed = wrap;
    const results = await Promise.allSettled(
      community.relays.map((url) =>
        nostr
          .relay(url)
          .event(signed, { signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS) })
          .catch((reason) => {
            // NIP-01 says a duplicate is OK true, but relays that answer false still HAVE it.
            if (reason instanceof Error && /^duplicate:/.test(reason.message)) return;
            throw reason;
          }),
      ),
    );
    if (results.some((r) => r.status === "fulfilled")) {
      forgetGuestbookJoin(viewer, community.idHex);
      logSync("guestbook", `join ${community.idHex.slice(0, 8)} accepted`);
      return true;
    }
    throw new Error(community.relays.length === 0 ? "no relays" : "no relay accepted the join");
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    const now = cache.get(key);
    if (now) {
      const failures = now.failures + 1;
      const delay = BACKOFF_MS[Math.min(failures - 1, BACKOFF_MS.length - 1)];
      cache.set(key, { ...now, failures, nextAttemptAt: Date.now() + delay, lastError: error });
    }
    logSync("guestbook", `join ${community.idHex.slice(0, 8)} not published (${error}); retrying later`);
    return false;
  } finally {
    inFlight.delete(key);
    notify();
  }
}

/** Logout: forget running attempts (the KV map is reset by `resetKvCaches`). */
export function clearPendingGuestbookJoinMemory(): void {
  inFlight.clear();
  notify();
}
