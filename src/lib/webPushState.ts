/**
 * Push state the page hands `src/sw/worker.ts` (`pushState.ts`). It contains
 * no plaintext or keys: only event ids created on this device that may be
 * echoed back through Web Push.
 */

import { trimPushState, writePushState } from "@/lib/pushState";

const OWN_EVENT_PREFIX = "own/";
const MAX_OWN_EVENTS = 512;

/** Record a just-created event before it is published. */
export async function markOwnWebPushEvent(eventId: string): Promise<void> {
  if (!eventId) return;
  try {
    await writePushState(`${OWN_EVENT_PREFIX}${encodeURIComponent(eventId)}`, true);
    await trimPushState(OWN_EVENT_PREFIX, MAX_OWN_EVENTS);
  } catch {
    // A missing marker may cause one generic notification, but must not block a send.
  }
}
