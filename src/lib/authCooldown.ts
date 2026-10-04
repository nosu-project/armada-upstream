/**
 * Per-relay gap before the user's NEXT NIP-42 signature. A signer that prompts
 * (NIP-55 app, bunker, extension) shows the user every one, so a relay that keeps
 * re-challenging — reconnect flaps, a fresh challenge per refused REQ — backs off
 * geometrically instead of prompting forever. A local key only collapses bursts.
 */
export const AUTH_MIN_INTERVAL_MS = 5_000;
const PROMPT_MAX_INTERVAL_MS = 10 * 60_000;
/** A sign this long after the previous one starts a fresh streak. */
export const AUTH_STREAK_WINDOW_MS = 15 * 60_000;

export interface AuthStreak {
  count: number;
  at: number;
}

/** The streak after a sign at `now`. */
export function nextAuthStreak(prev: AuthStreak | undefined, now: number): AuthStreak {
  const count = prev && now - prev.at < AUTH_STREAK_WINDOW_MS ? prev.count + 1 : 1;
  return { count, at: now };
}

/** How long to hold the next sign after the `count`-th in a streak. */
export function authCooldownMs(count: number, prompts: boolean): number {
  if (!prompts) return AUTH_MIN_INTERVAL_MS;
  return Math.min(AUTH_MIN_INTERVAL_MS * 4 ** Math.max(0, count - 1), PROMPT_MAX_INTERVAL_MS);
}
