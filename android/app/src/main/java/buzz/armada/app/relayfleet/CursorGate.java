package buzz.armada.app.relayfleet;

import java.util.HashSet;
import java.util.Set;

/**
 * Holds a relay's {@code since} cursor still while a session's backfill is in
 * flight.
 *
 * <p>A relay answers a REQ with its stored matches NEWEST first, then EOSE. A
 * cursor that followed those events as they arrived would jump to the newest
 * one at the start of the replay, and a socket dropped before the replay
 * finished would reconnect past the older events it never delivered. So an
 * event seen while any standing subscription is still replaying only raises a
 * held high-water mark, committed once every subscription has reached EOSE (or
 * was closed). After that, live events move the cursor directly.
 *
 * <p>Synchronized: the service sends REQs from okhttp's socket thread on open
 * and handles frames on its own handler thread.
 */
public final class CursorGate {

    private final Set<String> backfilling = new HashSet<>();
    private long held = -1;

    /** A new socket session: nothing is replaying and nothing is held. */
    public synchronized void reset() {
        backfilling.clear();
        held = -1;
    }

    /** A standing REQ went out (or was re-sent) and will replay before its EOSE. */
    public synchronized void onReqSent(String subId) {
        backfilling.add(subId);
    }

    /**
     * An accepted event with this {@code created_at}.
     *
     * @return the timestamp to commit to the cursor now, or -1 if it is held
     */
    public synchronized long onEvent(long createdAtSec) {
        if (backfilling.isEmpty()) return createdAtSec;
        held = Math.max(held, createdAtSec);
        return -1;
    }

    /**
     * A subscription finished replaying (EOSE) or will never finish (CLOSED).
     *
     * @return the held timestamp to commit now, or -1 if nothing is due
     */
    public synchronized long onBackfillEnded(String subId) {
        if (!backfilling.remove(subId) || !backfilling.isEmpty() || held < 0) return -1;
        long commit = held;
        held = -1;
        return commit;
    }
}
