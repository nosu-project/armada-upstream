package buzz.armada.app;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Predicate;

/**
 * Installation-sharded self topic documents (the DM conversation index, GIF
 * favorites) waiting out a coalescing window, newest version per coordinate.
 * An account whose installations republish those pieces in a loop otherwise
 * costs a Schnorr verify and a store write per edition; here only the version
 * still newest when the window closes is filed.
 *
 * The first version of a piece in a window is staged unverified. Every
 * decision that DROPS a version is made against a verified one, because a
 * relay can serve an unsigned event under the user's pubkey: a forged newer
 * version must not displace the real one, a forged pending one must not make
 * the real one lose, and forged pieces holding the cap are evicted before a
 * new piece is refused. Mirrors {@code stageNewestPerCoordinate} in
 * {@code selfSyncKinds.ts}.
 */
final class SelfTopicWindow {
    enum Outcome { STAGED, SUPERSEDED, FORGED, OVERFLOW }

    static final class Pending {
        final JSONObject event;
        final String relayUrl;
        /** Already signature-checked here; the flush need not verify it again. */
        boolean verified;

        Pending(JSONObject event, String relayUrl, boolean verified) {
            this.event = event;
            this.relayUrl = relayUrl;
            this.verified = verified;
        }
    }

    private final LinkedHashMap<String, Pending> pending = new LinkedHashMap<>();
    private final int maxCoordinates;
    private final Predicate<JSONObject> verifier;

    SelfTopicWindow(int maxCoordinates, Predicate<JSONObject> verifier) {
        this.maxCoordinates = maxCoordinates;
        this.verifier = verifier;
    }

    /** Whether {@code event} beats {@code previous} under NIP-01's replaceable ordering. */
    static boolean isNewerReplaceable(JSONObject previous, JSONObject event) {
        long a = previous.optLong("created_at"), b = event.optLong("created_at");
        if (b != a) return b > a;
        return event.optString("id").compareTo(previous.optString("id")) < 0;
    }

    private boolean verify(Pending p) {
        if (!p.verified) p.verified = verifier.test(p.event);
        return p.verified;
    }

    Outcome stage(String coordinate, JSONObject event, String relayUrl) {
        Pending previous = pending.get(coordinate);
        if (previous == null) {
            if (pending.size() >= maxCoordinates) {
                for (Iterator<Map.Entry<String, Pending>> it = pending.entrySet().iterator(); it.hasNext(); ) {
                    if (!verify(it.next().getValue())) it.remove();
                }
                if (pending.size() >= maxCoordinates) return Outcome.OVERFLOW;
            }
            pending.put(coordinate, new Pending(event, relayUrl, false));
            return Outcome.STAGED;
        }
        if (previous.event.optString("id").equals(event.optString("id"))) return Outcome.SUPERSEDED;
        if (isNewerReplaceable(previous.event, event)) {
            if (!verifier.test(event)) return Outcome.FORGED;
            pending.put(coordinate, new Pending(event, relayUrl, true));
            return Outcome.STAGED;
        }
        if (verify(previous)) return Outcome.SUPERSEDED;
        pending.put(coordinate, new Pending(event, relayUrl, false));
        return Outcome.STAGED;
    }

    /** Take every pending version, oldest-staged coordinate first, and empty the window. */
    List<Pending> drain() {
        List<Pending> batch = new ArrayList<>(pending.values());
        pending.clear();
        return batch;
    }

    void clear() {
        pending.clear();
    }

    boolean isEmpty() {
        return pending.isEmpty();
    }

    /** The pending version of {@code coordinate}, or null (tests). */
    JSONObject pendingEvent(String coordinate) {
        Pending p = pending.get(coordinate);
        return p == null ? null : p.event;
    }

    int size() {
        return pending.size();
    }
}
