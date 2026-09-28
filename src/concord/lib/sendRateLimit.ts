/**
 * Client-side send rate limit for Concord communities — a speed bump against
 * paste-and-enter floods, not a defense (any patched client bypasses it).
 *
 *  1. A token bucket ({@link SEND_BURST}, one back per {@link SEND_REFILL_MS}).
 *  2. An escalating lockout ({@link LOCKOUT_TIERS}) per fresh violation (sending
 *     with an empty bucket after the last lockout expired), so pacing to the
 *     refill doesn't work. Decays one tier per {@link TIER_DECAY_MS} of clean time.
 *
 * Scoped PER COMMUNITY so channel-hopping doesn't reset it. Only lockouts persist,
 * in localStorage (the check is synchronous; throwaway state, no migrations).
 * Only posts count ({@link RATE_LIMITED_KINDS}); reactions/edits/deletes are exempt.
 */

import { KIND_COMMENT, KIND_MESSAGE, KIND_POLL } from "@/concord/lib/kinds";

/** Messages allowed back-to-back before the refill rate governs. */
export const SEND_BURST = 5;
/** One token returns this often. */
export const SEND_REFILL_MS = 3_000;

const SECOND = 1_000;
const MINUTE = 60 * SECOND;

/** Lockout length by recurrence count; the last entry is the ceiling. */
export const LOCKOUT_TIERS: readonly number[] = [15 * SECOND, MINUTE, 5 * MINUTE, 15 * MINUTE, 60 * MINUTE];

/** Clean time (measured from the end of a lockout) that walks the tier back one step. */
export const TIER_DECAY_MS = 10 * MINUTE;

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
  /** Violations survived so far, indexing {@link LOCKOUT_TIERS}. 0 = clean. */
  tier: number;
  /** Timestamp the current lockout ends; 0 when not locked out. */
  lockedUntil: number;
}

const buckets = new Map<string, Bucket>();

/**
 * Where penalties survive a reload. Only tier and lockout persist, never tokens
 * (they refill within the shortest tier), so ordinary sends never touch storage.
 */
const STORAGE_KEY = "concord2:send-limit";

/** The persisted form: `{ [communityIdHex]: { tier, lockedUntil } }`. */
interface StoredPenalty {
  tier: number;
  lockedUntil: number;
}

let hydrated = false;

function readStored(): Record<string, unknown> {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    // Unparseable, or storage denied (private mode).
    return {};
  }
}

/** A stored entry read back, or undefined when it isn't a penalty we'd write. */
function parsePenalty(value: unknown, now: number): StoredPenalty | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { tier, lockedUntil } = value as Partial<StoredPenalty>;
  if (typeof tier !== "number" || !Number.isInteger(tier) || tier < 1) return undefined;
  if (typeof lockedUntil !== "number" || !Number.isFinite(lockedUntil) || lockedUntil <= 0) return undefined;
  // Clamp to the longest tier, so a fast clock or hand edit can't lock out for years.
  const ceiling = now + LOCKOUT_TIERS[LOCKOUT_TIERS.length - 1];
  return {
    tier: Math.min(tier, LOCKOUT_TIERS.length),
    lockedUntil: Math.min(lockedUntil, ceiling),
  };
}

/**
 * Fold stored penalties into memory, keeping the STRICTER — idempotent, so it
 * also syncs other tabs via the `storage` event.
 */
function hydrate(now: number): void {
  hydrated = true;
  for (const [id, value] of Object.entries(readStored())) {
    const stored = parsePenalty(value, now);
    if (!stored) continue;
    const bucket = buckets.get(id);
    if (!bucket) {
      buckets.set(id, { tokens: SEND_BURST, refilledAt: now, tier: stored.tier, lockedUntil: stored.lockedUntil });
      continue;
    }
    bucket.tier = Math.max(bucket.tier, stored.tier);
    bucket.lockedUntil = Math.max(bucket.lockedUntil, stored.lockedUntil);
  }
}

/** Write the penalties back. Called only when one changes, never on a send. */
function persist(): void {
  if (typeof localStorage === "undefined") return;
  const out: Record<string, StoredPenalty> = {};
  for (const [id, bucket] of buckets) {
    if (bucket.tier > 0) out[id] = { tier: bucket.tier, lockedUntil: bucket.lockedUntil };
  }
  try {
    if (Object.keys(out).length === 0) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(out));
  } catch {
    // Quota or a denied store: the limiter still holds for this session.
  }
}

// Another tab's penalty is this tab's, or a second tab is the bypass.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEY) hydrated = false;
  });
}

/** Bring `id`'s bucket up to date at `now`, creating a clean one if unseen. */
function sync(id: string, now: number): Bucket {
  if (!hydrated) hydrate(now);
  const bucket = buckets.get(id);
  if (!bucket) {
    const fresh: Bucket = { tokens: SEND_BURST, refilledAt: now, tier: 0, lockedUntil: 0 };
    buckets.set(id, fresh);
    return fresh;
  }
  // A backwards clock jump must not mint tokens or freeze the bucket.
  const elapsed = Math.max(0, now - bucket.refilledAt);
  bucket.tokens = Math.min(SEND_BURST, bucket.tokens + elapsed / SEND_REFILL_MS);
  bucket.refilledAt = now;
  // Decay only after the penalty has been served.
  if (bucket.tier > 0 && bucket.lockedUntil > 0 && now > bucket.lockedUntil) {
    const steps = Math.floor((now - bucket.lockedUntil) / TIER_DECAY_MS);
    if (steps > 0) {
      bucket.tier = Math.max(0, bucket.tier - steps);
      // Re-anchor so the leftover remainder doesn't decay a second step early.
      bucket.lockedUntil = bucket.tier === 0 ? 0 : bucket.lockedUntil + steps * TIER_DECAY_MS;
      // Persist forgiveness too, or a reload restores the old tier.
      persist();
    }
  }
  return bucket;
}

/** Milliseconds `bucket` must wait to send at `now` (0 when it may). */
function waitFor(bucket: Bucket, now: number): number {
  const locked = Math.max(0, bucket.lockedUntil - now);
  if (locked > 0) return locked;
  if (bucket.tokens >= 1) return 0;
  return Math.ceil((1 - bucket.tokens) * SEND_REFILL_MS);
}

/**
 * Record an empty-bucket send and return the wait. During a lockout it serves
 * the existing penalty rather than compounding it.
 */
function violate(bucket: Bucket, now: number): number {
  if (bucket.lockedUntil > now) return bucket.lockedUntil - now;
  const lockMs = LOCKOUT_TIERS[Math.min(bucket.tier, LOCKOUT_TIERS.length - 1)];
  bucket.tier = Math.min(bucket.tier + 1, LOCKOUT_TIERS.length);
  bucket.lockedUntil = now + lockMs;
  // The lockout supersedes the bucket's wait; refill runs through it.
  bucket.tokens = 0;
  persist();
  return lockMs;
}

/**
 * Register one send attempt WITHOUT spending a token: 0 if allowed, else the
 * wait. The composer's pre-flight (before it clears the text); call exactly once
 * per attempt. {@link consumeSend} spends on publish.
 */
export function attemptSend(communityId: string, now: number = Date.now()): number {
  const bucket = sync(communityId, now);
  const wait = waitFor(bucket, now);
  return wait === 0 ? 0 : violate(bucket, now);
}

/** Spend one token: 0 on success, else the wait. Only the publish path spends. */
export function consumeSend(communityId: string, now: number = Date.now()): number {
  const bucket = sync(communityId, now);
  const wait = waitFor(bucket, now);
  if (wait === 0) {
    bucket.tokens -= 1;
    return 0;
  }
  return violate(bucket, now);
}

/** Drop every bucket, in memory and in storage. Tests only. */
export function resetSendLimits(): void {
  buckets.clear();
  hydrated = false;
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to undo if the store was never writable.
  }
}

/** A wait in the largest natural whole unit, rounded up (never "0"). */
export function formatRetryAfter(ms: number): string {
  const secs = Math.max(1, Math.ceil(ms / SECOND));
  if (secs < 60) return `${secs} second${secs === 1 ? "" : "s"}`;
  const mins = Math.ceil(secs / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"}`;
  const hours = Math.ceil(mins / 60);
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

/** The refusal, thrown from the publish path; its message is shown verbatim. */
export class SendRateLimitError extends Error {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super(`You're sending messages too quickly. Try again in ${formatRetryAfter(retryAfterMs)}.`);
    this.name = "SendRateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Composer pre-flight: the refusal message, or null. Counts the attempt, so call
 * once per real send — never for rendering.
 */
export function sendRefusal(communityId: string, now: number = Date.now()): string | null {
  const wait = attemptSend(communityId, now);
  return wait === 0 ? null : new SendRateLimitError(wait).message;
}
