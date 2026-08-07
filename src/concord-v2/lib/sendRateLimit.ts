/**
 * Client-side send rate limit for Concord communities.
 *
 * A speed bump, not a defense. Concord has no host to enforce a posting rate,
 * so a member holding the channel's stream key can wrap and broadcast as fast
 * as they can sign — the observed abuse being literally Ctrl+V, Enter, repeat.
 * The real fix belongs in the protocol; this only makes the lazy version of it
 * annoying enough to stop, and any patched client bypasses it trivially.
 *
 * Scoped PER COMMUNITY, not per channel: the unit a person spams is the place,
 * and hopping channels to reset the budget would defeat the point. Deliberately
 * in-memory — a reload clears it, which is fine for something already
 * bypassable, and keeps the send path free of a storage round-trip.
 *
 * Only the kinds a reader sees as a post count ({@link RATE_LIMITED_KINDS}):
 * messages, thread replies and polls. Reactions, edits and deletes are exempt —
 * a fast pass of emoji over a backlog is ordinary behavior, and a delete must
 * never be the thing the budget refuses.
 */

import { KIND_COMMENT, KIND_MESSAGE, KIND_POLL } from "@/concord-v2/lib/kinds";

/** Messages allowed back-to-back before the refill rate governs. */
export const SEND_BURST = 5;
/** One token returns this often, so the sustained ceiling is 20/minute. */
export const SEND_REFILL_MS = 3_000;

/** The chat kinds a send budget applies to. */
export const RATE_LIMITED_KINDS: ReadonlySet<number> = new Set([KIND_MESSAGE, KIND_COMMENT, KIND_POLL]);

/** Whether a chat rumor of `kind` spends from the community's send budget. */
export function isRateLimitedKind(kind: number): boolean {
  return RATE_LIMITED_KINDS.has(kind);
}

interface Bucket {
  /** Fractional tokens, so a partial refill isn't rounded away on every read. */
  tokens: number;
  refilledAt: number;
}

const buckets = new Map<string, Bucket>();

/** Bring `id`'s bucket up to date at `now`, creating a full one if unseen. */
function refill(id: string, now: number): Bucket {
  const bucket = buckets.get(id);
  if (!bucket) {
    const fresh: Bucket = { tokens: SEND_BURST, refilledAt: now };
    buckets.set(id, fresh);
    return fresh;
  }
  // A clock that jumped backwards (NTP correction, sleep/wake) must not mint
  // tokens or freeze the bucket: treat it as no elapsed time and re-anchor.
  const elapsed = Math.max(0, now - bucket.refilledAt);
  bucket.tokens = Math.min(SEND_BURST, bucket.tokens + elapsed / SEND_REFILL_MS);
  bucket.refilledAt = now;
  return bucket;
}

/** Milliseconds until `bucket` holds a whole token (0 when it already does). */
function waitFor(bucket: Bucket): number {
  if (bucket.tokens >= 1) return 0;
  return Math.ceil((1 - bucket.tokens) * SEND_REFILL_MS);
}

/**
 * How long the community must wait to send, without spending anything — for a
 * pre-flight check that has to run BEFORE the composer clears itself, so a
 * refusal doesn't cost the user the text they typed.
 */
export function peekSend(communityId: string, now: number = Date.now()): number {
  return waitFor(refill(communityId, now));
}

/**
 * Spend one token, returning 0 on success or the milliseconds to wait when the
 * budget is exhausted (in which case nothing is spent). The publish path is the
 * only caller that should spend.
 */
export function consumeSend(communityId: string, now: number = Date.now()): number {
  const bucket = refill(communityId, now);
  const wait = waitFor(bucket);
  if (wait === 0) bucket.tokens -= 1;
  return wait;
}

/** Drop every bucket. Tests only. */
export function resetSendLimits(): void {
  buckets.clear();
}

/** A wait in whole seconds, rounded up so it never reads as "in 0 seconds". */
export function formatRetryAfter(ms: number): string {
  const secs = Math.max(1, Math.ceil(ms / 1000));
  return `${secs} second${secs === 1 ? "" : "s"}`;
}

/**
 * The refusal, thrown from the publish path and shown verbatim to the user
 * (`relayRejectionMessage` passes a plain message through, so no caller needs
 * to special-case the type to render it).
 */
export class SendRateLimitError extends Error {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super(`You're sending messages too quickly. Try again in ${formatRetryAfter(retryAfterMs)}.`);
    this.name = "SendRateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

/** The refusal message a pre-flight check surfaces, or null when sending is allowed. */
export function sendRefusal(communityId: string, now: number = Date.now()): string | null {
  const wait = peekSend(communityId, now);
  return wait === 0 ? null : new SendRateLimitError(wait).message;
}
