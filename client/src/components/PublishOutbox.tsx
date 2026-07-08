import { useNostr } from "@nostrify/react";
import { useCallback, useEffect, useRef } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import {
  getQueuedPublishes,
  markQueuedPublishFailure,
  removeQueuedPublish,
} from "@/lib/publishOutbox";
import { publishLive } from "@/lib/publishLive";
import { notifyPublishConfirmed } from "@/lib/publishConfirm";
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
      const due = getQueuedPublishes().filter((item) => !item.nextAttemptAt || item.nextAttemptAt <= now);
      for (const item of due) {
        try {
          if (item.relay) {
            // Liveness-gated: a retry that reuses the same severed socket would
            // buffer into the void and time out again (backing off toward 5min).
            // publishLive forces a fresh connection when the socket isn't open.
            await publishLive(nostr, item.relay, item.event, {
              signal: AbortSignal.timeout(timeoutRef.current),
              timeoutMs: timeoutRef.current,
            });
          } else {
            await nostr.event(item.event, { signal: AbortSignal.timeout(timeoutRef.current) });
          }
          removeQueuedPublish(item.id);
          // A delayed delivery must reconcile back to the UI so a message the
          // composer already marked "failed"/"pending" flips to "sent" instead
          // of looking eaten. Keyed by event id; useGroupMessages/DMs listen.
          notifyPublishConfirmed(item.event.id);
        } catch (error) {
          markQueuedPublishFailure(item.id, error);
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
