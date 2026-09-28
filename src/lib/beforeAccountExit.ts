/** Why the active account is about to disappear. */
export type AccountExitReason = "account-change" | "final-logout";

/** A bounded, best-effort teardown registered by a platform notification controller. */
export type BeforeAccountExitHandler = (reason: AccountExitReason) => Promise<void>;

// Token-keyed: two controllers may register the same function.
const handlers = new Map<symbol, BeforeAccountExitHandler>();
const DEFAULT_TIMEOUT_MS = 4_000;

/**
 * Teardown window for interactive logout/switch; the cap only bites a dead
 * gateway, where the local kill switch and the endpoint's 410 stop pushes anyway.
 */
export const EXIT_TEARDOWN_MS = 1_500;

/**
 * Absolute deadline after which an exit navigates regardless, backstopping
 * awaits with no timeout of their own (e.g. the native `wipe()` bridge).
 */
export const EXIT_NAV_DEADLINE_MS = 3_000;

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
 * Give every platform controller one bounded chance to clean up; failures are
 * swallowed. Controllers must persist incomplete cleanup before rejecting so it
 * can be retried when that account is next active.
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
