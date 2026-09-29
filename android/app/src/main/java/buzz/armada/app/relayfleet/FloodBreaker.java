package buzz.armada.app.relayfleet;

/**
 * Pauses a relay's subscription to the account's own documents while another
 * client floods them.
 *
 * <p>Every new edition of a self document is a full download, 38 KB for a
 * Concord community-list fragment. A client stuck republishing one (measured:
 * 2,762 editions in under two hours, up to 85 a minute) costs every other
 * device that bandwidth no matter how cheaply each copy is then handled. So a
 * relay that delivers more than {@link #LIMIT} new editions inside
 * {@link #WINDOW_MS} has its subscription closed, and re-opened after a
 * cooldown that doubles while the flood persists. Resuming asks from the pause
 * with a small per-filter limit, newest first, so what changed while paused is
 * caught up in one bounded read rather than every edition in between.
 *
 * <p>One instance per relay; clock-injected. Synchronized: the service checks
 * {@link #paused} from the socket thread that sends REQs on open.
 */
public final class FloodBreaker {

    public static final int LIMIT = 6;
    public static final long WINDOW_MS = 60_000L;
    public static final long FIRST_COOLDOWN_MS = 5 * 60_000L;
    public static final long MAX_COOLDOWN_MS = 30 * 60_000L;
    /** Editions a resumed subscription may replay, per filter. */
    public static final int RESUME_LIMIT = 10;

    private final long[] recent = new long[LIMIT + 1];
    private int count = 0;
    private long cooldownMs = FIRST_COOLDOWN_MS;
    private long pausedUntil = 0;
    private long lastTripAt = -1;

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
        if (paused(nowMs)) return 0;
        recent[count % recent.length] = nowMs;
        count++;
        if (count < recent.length) return 0;
        long oldest = recent[count % recent.length];
        if (nowMs - oldest > WINDOW_MS) return 0;
        // A flood that resumes right after its last pause escalates; one that
        // stayed quiet for a full cooldown starts over.
        if (lastTripAt >= 0 && nowMs - pausedUntil > cooldownMs) cooldownMs = FIRST_COOLDOWN_MS;
        else if (lastTripAt >= 0) cooldownMs = Math.min(cooldownMs * 2, MAX_COOLDOWN_MS);
        lastTripAt = nowMs;
        pausedUntil = nowMs + cooldownMs;
        count = 0;
        return cooldownMs;
    }
}
