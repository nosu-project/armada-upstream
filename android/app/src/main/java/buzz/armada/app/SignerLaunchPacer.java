package buzz.armada.app;

import org.json.JSONObject;

import java.util.ArrayDeque;
import java.util.HashMap;
import java.util.Map;

/**
 * Paces launches of a NEW signer-app screen. Amber rate-limits intents that
 * open its approval activity to 5 per 30 s per (caller, type, event kind),
 * answering the rest with an immediate cancel and a "too many requests" toast;
 * requests merged into an already-open screen are exempt. Staying under that
 * ceiling turns a burst of fresh prompts (one AUTH per reconnecting relay) into
 * a short wait instead of dropped requests that get re-asked.
 */
final class SignerLaunchPacer {

    /** Amber's ceiling is 5; one under leaves room for a launch it counts that we didn't. */
    static final int MAX_PER_WINDOW = 4;
    static final long WINDOW_MS = 30_000;

    private final Map<String, ArrayDeque<Long>> launches = new HashMap<>();

    /** The bucket Amber keys by: the request type, plus the event kind of a sign. */
    static String keyOf(String type, String payload) {
        if (!"sign_event".equals(type)) return type;
        try {
            int kind = new JSONObject(payload).optInt("kind", -1);
            return kind >= 0 ? type + ":" + kind : type;
        } catch (Exception e) {
            return type;
        }
    }

    /** Record a launch at {@code nowMs} if the bucket allows one, returning 0; else the ms until it does. */
    long reserve(String key, long nowMs) {
        ArrayDeque<Long> recent = launches.get(key);
        if (recent == null) {
            recent = new ArrayDeque<>();
            launches.put(key, recent);
        }
        while (!recent.isEmpty() && recent.peekFirst() <= nowMs - WINDOW_MS) recent.pollFirst();
        if (recent.size() >= MAX_PER_WINDOW) return recent.peekFirst() + WINDOW_MS - nowMs;
        recent.addLast(nowMs);
        return 0;
    }
}
