import { useNostr } from "@nostrify/react";
import { useCallback, useEffect, useRef } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import {
  getQueuedPublishes,
  markQueuedPublishFailure,
  recordQueuedPublishAttempt,
  removeQueuedPublish,
} from "@/lib/publishOutbox";
import { publishSignedEventToRelays } from "@/lib/nip65";
import { publishTimeoutMs } from "@/lib/publishTimeout";

function isOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

/** Retries signed events that were queued while offline or during relay errors. */
export function PublishOutbox() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const flushingRef = useRef(false);
  // The retry budget must absorb NIP-42 AUTH round-trips through a remote
  // NIP-46 signer on lossy links (#51). Read via ref so the flush callback
  // doesn't re-register the window listeners on every login change.
  const timeoutRef = useRef(publishTimeoutMs(user?.method));
  timeoutRef.current = publishTimeoutMs(user?.method);

  const flush = useCallback(async () => {
    if (flushingRef.current || isOffline()) return;
    flushingRef.current = true;
    try {
      const now = Date.now();
      const queued = await getQueuedPublishes();
      const due = queued.filter((item) => !item.nextAttemptAt || item.nextAttemptAt <= now);
      for (const item of due) {
        try {
          if (item.relay) {
            await nostr.relay(item.relay).event(item.event, { signal: AbortSignal.timeout(timeoutRef.current) });
          } else if (item.relays?.length) {
            const result = await publishSignedEventToRelays(
              nostr,
              item.event,
              item.relays,
              timeoutRef.current,
            );
            // Settle exactly the snapshot attempted above, even on full
            // success. Another writer may have appended a relay while the
            // network call was in flight; recordQueuedPublishAttempt preserves
            // that unattempted target instead of deleting the whole entry.
            await recordQueuedPublishAttempt(item.id, item.relays, result.rejected);
            if (result.rejected.length > 0) {
              throw new Error(
                result.accepted.length > 0
                  ? `${result.rejected.length} relay deliveries remain`
                  : "No requested relay accepted the event",
              );
            }
          } else {
            await nostr.event(item.event, { signal: AbortSignal.timeout(timeoutRef.current) });
          }
          if (!item.relays?.length) await removeQueuedPublish(item.id);
        } catch (error) {
          await markQueuedPublishFailure(item.id, error);
        }
      }
    } finally {
      flushingRef.current = false;
    }
  }, [nostr]);

  useEffect(() => {
    void flush();
    const onOnline = () => void flush();
    const onFocus = () => void flush();
    window.addEventListener("online", onOnline);
    window.addEventListener("focus", onFocus);
    const interval = window.setInterval(() => void flush(), 60_000);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("focus", onFocus);
      window.clearInterval(interval);
    };
  }, [flush]);

  return null;
}

export default PublishOutbox;
