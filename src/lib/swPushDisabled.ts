/**
 * The Web Push kill switch, enforced by the service worker: written FIRST on
 * disable (the network teardown is best-effort), the worker then shows nothing
 * and unsubscribes itself so the gateway gets 410s. Key must match
 * `PUSH_DISABLED_KEY` in `src/sw/worker.ts`.
 */

import { deletePushState, writePushState } from "@/lib/pushState";

const DISABLED_KEY = "disabled";

/** Assert "push is off" where the worker can read it. */
export async function writePushDisabledFlag(): Promise<void> {
  try {
    await writePushState(DISABLED_KEY, true);
  } catch {
    // Storage unavailable (private mode); the network teardown still runs.
  }
}

/** Lift the kill switch; called on the enable path before pushes can resume. */
export async function clearPushDisabledFlag(): Promise<void> {
  try {
    await deletePushState(DISABLED_KEY);
  } catch {
    // ignore
  }
}
