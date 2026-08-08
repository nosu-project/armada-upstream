/**
 * Client-side send rate limit for Concord communities.
 *
 * A speed bump, not a defense. Concord has no host to enforce a posting rate,
 * so a member holding the channel's stream key can wrap and broadcast as fast
 * as they can sign — the observed abuse being literally Ctrl+V, Enter, repeat.
 * The real fix belongs in the protocol; this only makes the lazy version of it
 * annoying enough to stop, and any patched client bypasses it trivially.
 *
 * Two layers, because a plain bucket sets a spam RATE rather than stopping
 * spam: whoever wants to flood simply paces to the refill and keeps going.
 *
 *  1. A token bucket ({@link SEND_BURST} messages, one back per
 *     {@link SEND_REFILL_MS}) — the part a normal fast conversation lives
 *     inside and never notices.
 *  2. An escalating lockout on top. Sending with an empty bucket is a
 *     violation, and each fresh one moves the community up
 *     {@link LOCKOUT_TIERS}: seconds the first time, minutes if it keeps
 *     happening. Hammering DURING a lockout doesn't escalate — only a
 *     violation after the last one expired does — so the penalty tracks
 *     repeated bouts of flooding, not how hard the key is being held down.
 *
 * The tier decays one step per {@link TIER_DECAY_MS} of clean time after the
 * lockout ends, so someone who trips it once in a lively argument is back to
 * a clean slate rather than permanently on a short fuse.
 *
 * Scoped PER COMMUNITY, not per channel: the unit a person spams is the place,
 * and hopping channels to reset the budget would defeat the point.
 *
 * Lockouts persist to localStorage, and only lockouts (see {@link STORAGE_KEY})
 * — a penalty measured in minutes that a page reload erased would just teach
 * the flooder to reload. localStorage rather than the ArmadaDB KV because the
 * check is on the send path and synchronous, where the KV is async; the state
 * is a few bytes of throwaway bookkeeping, not user data, so losing it costs
 * nothing and none of the migration machinery in `db/schema.ts` applies.
 *
 * Only the kinds a reader sees as a post count ({@link RATE_LIMITED_KINDS}):
 * messages, thread replies and polls. Reactions, edits and deletes are exempt —
 * a fast pass of emoji over a backlog is ordinary behavior, and a delete must
 * never be the thing the budget refuses.
 */

import { KIND_COMMENT, KIND_MESSAGE, KIND_POLL } from "@/concord/lib/kinds";

/** Messages allowed back-to-back before the refill rate governs. */
export const SEND_BURST = 5;
/** One token returns this often. */
export const SEND_REFILL_MS = 3_000;

const SECOND = 1_000;
const MINUTE = 60 * SECOND;

/**
 * How long a send is refused for, by how many times the flooding has recurred.
 * The last entry is the ceiling. Tier 1 is a nuisance a fast talker shrugs off;
 * reaching the end takes five separate bouts, each after serving the previous
 * penalty, which no ordinary conversation does by accident.
 */
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
 * Where the penalties survive a reload. Only the PENALTY is persisted — tier
 * and lockout — never the token bucket: it refills inside the shortest tier, so
 * carrying it across a reload would buy nothing, and keeping it out means an
 * ordinary send never touches storage. A reload during a lockout therefore
 * costs the flooder five messages before the restored tier bites again, and
 * escalates them a tier for the trouble.
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
    // Unparseable, or storage denied outright (private mode, blocked cookies).
    return {};
  }
}

/** A stored entry read back, or undefined when it isn't a penalty we'd write. */
function parsePenalty(value: unknown, now: number): StoredPenalty | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { tier, lockedUntil } = value as Partial<StoredPenalty>;
  if (typeof tier !== "number" || !Number.isInteger(tier) || tier < 1) return undefined;
  if (typeof lockedUntil !== "number" || !Number.isFinite(lockedUntil) || lockedUntil <= 0) return undefined;
  // A lockout written while the clock was running fast (or edited by hand)
  // could otherwise hold someone out for years. Nothing legitimate exceeds the
  // longest tier, so that's the ceiling a restored penalty is clamped to.
  const ceiling = now + LOCKOUT_TIERS[LOCKOUT_TIERS.length - 1];
  return {
    tier: Math.min(tier, LOCKOUT_TIERS.length),
    lockedUntil: Math.min(lockedUntil, ceiling),
  };
}

/**
 * Fold the stored penalties into memory, taking the STRICTER of the two so it
 * is safe to run more than once — which is what makes it a fix for a second tab
 * as well as for a reload: a tab that was already open re-reads on the
 * `storage` event and adopts the lockout the other one earned.
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

// Another tab's penalty is this tab's penalty — otherwise opening a second one
// is the whole bypass.
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
  // A clock that jumped backwards (NTP correction, sleep/wake) must not mint
  // tokens or freeze the bucket: treat it as no elapsed time and re-anchor.
  const elapsed = Math.max(0, now - bucket.refilledAt);
  bucket.tokens = Math.min(SEND_BURST, bucket.tokens + elapsed / SEND_REFILL_MS);
  bucket.refilledAt = now;
  // Behaving costs tiers, but only once the penalty has actually been served —
  // time spent locked out is not credit toward forgiveness.
  if (bucket.tier > 0 && bucket.lockedUntil > 0 && now > bucket.lockedUntil) {
    const steps = Math.floor((now - bucket.lockedUntil) / TIER_DECAY_MS);
    if (steps > 0) {
      bucket.tier = Math.max(0, bucket.tier - steps);
      // Re-anchor so the leftover remainder doesn't decay a second step early.
      bucket.lockedUntil = bucket.tier === 0 ? 0 : bucket.lockedUntil + steps * TIER_DECAY_MS;
      // Forgiveness has to reach storage too, or a reload restores the tier
      // that was just walked back.
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
 * Record that a send was attempted with nothing left to spend, and return the
 * resulting wait. A violation while already locked out serves the existing
 * penalty rather than compounding it — mashing the key during a lockout is one
 * bout, not fifty.
 */
function violate(bucket: Bucket, now: number): number {
  if (bucket.lockedUntil > now) return bucket.lockedUntil - now;
  const lockMs = LOCKOUT_TIERS[Math.min(bucket.tier, LOCKOUT_TIERS.length - 1)];
  bucket.tier = Math.min(bucket.tier + 1, LOCKOUT_TIERS.length);
  bucket.lockedUntil = now + lockMs;
  // The lockout supersedes the bucket's own wait, and refill runs through it —
  // every tier outlasts a full refill, so serving one hands back a whole burst.
  // The penalty is the wait, not a crippled bucket afterwards.
  bucket.tokens = 0;
  persist();
  return lockMs;
}

/**
 * Register one send attempt WITHOUT spending a token: 0 when it may proceed,
 * else the wait (escalating the lockout if this is a fresh violation).
 *
 * This is the composer's pre-flight — it has to run before the composer clears
 * itself, or a refusal costs the user the text they typed — and it must be
 * called exactly once per attempt, since a refusal counts against the sender.
 * The publish path then spends the token via {@link consumeSend}.
 */
export function attemptSend(communityId: string, now: number = Date.now()): number {
  const bucket = sync(communityId, now);
  const wait = waitFor(bucket, now);
  return wait === 0 ? 0 : violate(bucket, now);
}

/**
 * Spend one token: 0 on success, else the wait (escalating the lockout if this
 * is a fresh violation). Nothing is spent on a refusal. The publish path is the
 * only caller that should spend.
 */
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

/**
 * A wait in the largest whole unit that reads naturally, rounded up so it never
 * says "0" and never asks someone to count out "900 seconds".
 */
export function formatRetryAfter(ms: number): string {
  const secs = Math.max(1, Math.ceil(ms / SECOND));
  if (secs < 60) return `${secs} second${secs === 1 ? "" : "s"}`;
  const mins = Math.ceil(secs / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"}`;
  const hours = Math.ceil(mins / 60);
  return `${hours} hour${hours === 1 ? "" : "s"}`;
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

/**
 * The composer's pre-flight: the refusal message to show, or null when the send
 * may proceed. Counts the attempt ({@link attemptSend}), so call it once per
 * send the user actually asked for — never to decide whether to render a button.
 */
export function sendRefusal(communityId: string, now: number = Date.now()): string | null {
  const wait = attemptSend(communityId, now);
  return wait === 0 ? null : new SendRateLimitError(wait).message;
}
