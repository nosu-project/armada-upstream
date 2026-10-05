package buzz.armada.app.relayfleet;

/**
 * Pauses a relay's subscription to the account's own documents while another
 * client floods them.
 *
 * <p>Every new edition of a self document is a full download, 38 KB for a
 * Concord community-list fragment. A client stuck republishing one costs every
 * other device that bandwidth no matter how cheaply each copy is then handled.
 * So a relay that delivers more than {@link #LIMIT} new editions inside
 * {@link #WINDOW_MS}, or more than {@link #BYTE_LIMIT} bytes of them inside
 * {@link #BYTE_WINDOW_MS}, has its subscription closed, and re-opened after a
 * cooldown that doubles while the flood persists. The byte budget is what
 * bounds a slow flood of a large document, which never reaches the count limit
 * (one 76 KB edition a minute is 4.5 MB an hour per relay). Any client holding
 * the key can write these, so the budget assumes nothing about their
 * behaviour. Resuming asks from the pause with a small per-filter limit, newest
 * first, so what changed while paused is caught up in one bounded read rather
 * than every edition in between.
 *
 * <p>One instance per relay; clock-injected. Synchronized: the service checks
 * {@link #paused} from the socket thread that sends REQs on open.
 */
public final class FloodBreaker {

    public static final int LIMIT = 6;
    public static final long WINDOW_MS = 60_000L;
    public static final long FIRST_COOLDOWN_MS = 5 * 60_000L;
    public static final long MAX_COOLDOWN_MS = 30 * 60_000L;
    /** Bytes of self-document frames one relay may deliver per {@link #BYTE_WINDOW_MS}. */
    public static final long BYTE_LIMIT = 128 * 1024;
    public static final long BYTE_WINDOW_MS = 15 * 60_000L;
    /** Editions a resumed subscription may replay, per filter. */
    public static final int RESUME_LIMIT = 10;

    private final long[] recent = new long[LIMIT + 1];
    private int count = 0;
    private long cooldownMs = FIRST_COOLDOWN_MS;
    private long pausedUntil = 0;
    private long lastTripAt = -1;
    /** (arrival ms, bytes) of the deliveries inside the byte window, oldest first. */
    private final java.util.ArrayDeque<long[]> byteLog = new java.util.ArrayDeque<>();
    private long byteSum = 0;

    /** Whether the subscription is paused at {@code nowMs}. */
    public synchronized boolean paused(long nowMs) {
        return nowMs < pausedUntil;
    }

    public synchronized long pausedUntil() {
        return pausedUntil;
    }

    /**
     * A new edition arrived. Returns how long to pause for, or 0 to keep the
     * subscription open.
     */
    public synchronized long onEdition(long nowMs) {
        return onEdition(nowMs, 0);
    }

    /**
     * A self-document frame of {@code bytes} arrived live. Every relay's copy
     * counts, a duplicate of an edition another relay already delivered
     * included: each was downloaded. Returns how long to pause for, or 0.
     */
    public synchronized long onEdition(long nowMs, long bytes) {
        if (paused(nowMs)) return 0;
        recent[count % recent.length] = nowMs;
        count++;
        while (!byteLog.isEmpty() && nowMs - byteLog.peekFirst()[0] > BYTE_WINDOW_MS) {
            byteSum -= byteLog.pollFirst()[1];
        }
        if (bytes > 0) {
            byteLog.addLast(new long[] { nowMs, bytes });
            byteSum += bytes;
        }
        boolean overBytes = byteSum > BYTE_LIMIT;
        boolean overCount = count >= recent.length && nowMs - recent[count % recent.length] <= WINDOW_MS;
        if (!overBytes && !overCount) return 0;
        // A flood that resumes right after its last pause escalates; one that
        // stayed quiet for a full cooldown starts over.
        if (lastTripAt >= 0 && nowMs - pausedUntil > cooldownMs) cooldownMs = FIRST_COOLDOWN_MS;
        else if (lastTripAt >= 0) cooldownMs = Math.min(cooldownMs * 2, MAX_COOLDOWN_MS);
        lastTripAt = nowMs;
        pausedUntil = nowMs + cooldownMs;
        count = 0;
        byteLog.clear();
        byteSum = 0;
        return cooldownMs;
    }
}
