package buzz.armada.app;

import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;

/**
 * When a message notification may make noise and light the screen:
 * <ul>
 *   <li><b>Another device is in use.</b> The user's own message or a read-state
 *       update arriving from elsewhere means they are reading on that device.
 *       While that was within {@link #OTHER_DEVICE_ACTIVE_MS}, posts are held
 *       and re-checked every {@link #HOLD_RECHECK_MS}; one read there in the
 *       meantime never posts at all.</li>
 *   <li><b>One alert per key per throttle.</b> A community's channels share
 *       one key and alert at most once per {@link #CHANNEL_THROTTLE_MS} between
 *       them; a DM or a mention is keyed by its room and alerts once per
 *       {@link #DIRECT_THROTTLE_MS}. Posts in between are silent updates.</li>
 * </ul>
 * Not thread-safe: the service calls it on its handler thread.
 */
final class AlertPolicy {

    static final long OTHER_DEVICE_ACTIVE_MS = 60_000L;
    static final long HOLD_RECHECK_MS = 5_000L;
    static final long CHANNEL_THROTTLE_MS = 20_000L;
    static final long DIRECT_THROTTLE_MS = 5_000L;
    private static final int SWEEP_AT = 128;

    private volatile long otherDeviceActiveAt = Long.MIN_VALUE / 2;
    private final Map<String, Long> lastAlertByKey = new HashMap<>();

    /** The user acted on another device (sent a message, advanced read state). */
    void noteOtherDeviceActivity(long nowMs) {
        otherDeviceActiveAt = nowMs;
    }

    /** Whether new posts wait for the other device to go quiet. */
    boolean holding(long nowMs) {
        return nowMs - otherDeviceActiveAt < OTHER_DEVICE_ACTIVE_MS;
    }

    /**
     * Whether this message may alert, recording it when it does.
     *
     * @param key    the community for a channel message, else the room
     * @param direct a DM, or a message that mentions or replies to the user
     */
    boolean shouldAlert(String key, boolean direct, long nowMs) {
        if (key == null) return true;
        long throttle = direct ? DIRECT_THROTTLE_MS : CHANNEL_THROTTLE_MS;
        Long last = lastAlertByKey.get(key);
        // A clock that stepped backwards must not silence a key for good.
        if (last != null && last <= nowMs && nowMs - last < throttle) return false;
        lastAlertByKey.put(key, nowMs);
        if (lastAlertByKey.size() > SWEEP_AT) sweep(nowMs);
        return true;
    }

    private void sweep(long nowMs) {
        Iterator<Long> it = lastAlertByKey.values().iterator();
        while (it.hasNext()) {
            if (nowMs - it.next() >= CHANNEL_THROTTLE_MS) it.remove();
        }
    }
}
