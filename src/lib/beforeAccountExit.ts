/** Why the active account is about to disappear. */
export type AccountExitReason = "account-change" | "final-logout";

/** A bounded, best-effort teardown registered by a platform notification controller. */
export type BeforeAccountExitHandler = (reason: AccountExitReason) => Promise<void>;

// Token-keyed rather than Set<handler>: two mounted controllers can register
// the same exported/deduped function. Unmounting one must not delete the other.
const handlers = new Map<symbol, BeforeAccountExitHandler>();
const DEFAULT_TIMEOUT_MS = 4_000;

/**
 * Register work that needs the OUTGOING signer/session before account storage
 * changes or a hard reload tears it down. Returns the ordinary unregister fn.
 */
export function registerBeforeAccountExit(handler: BeforeAccountExitHandler): () => void {
  const token = Symbol("before-account-exit");
  handlers.set(token, handler);
  return () => { handlers.delete(token); };
}

/**
 * Give every active platform controller one bounded chance to clean up.
 *
 * Account exit is never trapped by a broken gateway/native bridge: failures
 * are swallowed and the whole cohort is capped. Controllers must persist
 * incomplete cleanup before rejecting so a non-final account switch can retry
 * it when that account next becomes active.
 */
export async function runBeforeAccountExit(
  reason: AccountExitReason,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  const work = Promise.allSettled(
    [...handlers.values()].map((handler) => Promise.resolve().then(() => handler(reason))),
  ).then(() => undefined);
  if (timeoutMs <= 0) return;

  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    work,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
}

/** Test-only reset; production registrations unregister with their owner. */
export function _resetBeforeAccountExitForTests(): void {
  handlers.clear();
}
