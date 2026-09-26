package buzz.armada.app;

import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashSet;
import java.util.Map;

/**
 * Rate limit for the "ringing" receipt the service signs on a caller's say-so,
 * mirroring {@code sendReceipt} in DmCallProvider.tsx: at most one per call id,
 * and at most one per peer per {@link #PEER_INTERVAL_MS}. Each receipt is a
 * signature with the user's key and a publish, triggered by nothing but an
 * incoming offer, so a burst of offers under fresh call ids must not turn into
 * a burst of both.
 */
final class CallReceiptGate {
    static final long PEER_INTERVAL_MS = 3_000L;
    /** Call ids remembered; the oldest is forgotten first (RECEIPT_MEMORY on the web). */
    static final int MEMORY = 256;

    private final LinkedHashSet<String> callIds = new LinkedHashSet<>();
    private final Map<String, Long> lastAtByPeer = new HashMap<>();

    /** Whether a receipt to {@code peer} for {@code callId} may go out now; records it if so. */
    synchronized boolean admit(String peer, String callId, long nowMs) {
        if (peer == null || callId == null) return false;
        if (callIds.contains(callId)) return false;
        Long last = lastAtByPeer.get(peer);
        if (last != null && nowMs - last < PEER_INTERVAL_MS && nowMs >= last) return false;
        callIds.add(callId);
        if (callIds.size() > MEMORY) {
            Iterator<String> oldest = callIds.iterator();
            oldest.next();
            oldest.remove();
        }
        if (lastAtByPeer.size() >= MEMORY) {
            lastAtByPeer.values().removeIf(at -> nowMs - at >= PEER_INTERVAL_MS);
        }
        lastAtByPeer.put(peer, nowMs);
        return true;
    }
}
