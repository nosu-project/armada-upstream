package buzz.armada.app.relayfleet;

/**
 * Hold reconnects until the network has stopped changing.
 *
 * <p>A phone at the edge of a weak Wi-Fi changes networks in bursts — on the
 * measured device, 476 changes in 11h, two thirds of them within ten seconds
 * of the previous one — and every change drops every relay socket. Reconnecting
 * the whole fleet at once on each change meant a round of DNS, TLS, REQs and
 * AUTH per relay that the next change, seconds later, threw away. Waiting until
 * the network has been quiet for {@link #SETTLE_MS} spends that round once per
 * burst instead of once per change.
 */
public final class NetworkSettle {

    public static final long SETTLE_MS = 10_000L;

    private NetworkSettle() {}

    /** How long a connect must still wait, or 0 if the network has settled. */
    public static long delayMs(long nowMs, long lastChangeAtMs, long settleMs) {
        if (lastChangeAtMs <= 0) return 0;
        return Math.max(0, lastChangeAtMs + settleMs - nowMs);
    }
}
