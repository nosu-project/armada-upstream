package pub.armada.app;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;

/**
 * Durable kind-0 profile cache for {@link NotificationRelayService}.
 *
 * The service's old profile cache was an in-memory map: every service restart
 * (Doze, OEM battery killers, reboots, START_STICKY relaunches) re-broadcast a
 * one-shot kind-0 REQ to EVERY relay for EVERY author that triggered a
 * notification, and a profile-less author re-broadcast on every message (a
 * null resolution was never recorded). This store fixes both:
 *
 *   - Positive entries persist (SharedPreferences JSON), newest kind-0
 *     {@code created_at} wins, so a profile is fetched once and reused across
 *     service lifetimes.
 *   - NEGATIVE entries (fetched, nothing found) suppress re-broadcasts for a
 *     caller-chosen TTL. A miss never erases a held profile — relays are
 *     lossy, so "this relay didn't have it" must not clobber "another relay
 *     had it last week".
 *   - Staleness is judged on {@code fetchedAt} (when we last asked the
 *     network), not the kind-0's static {@code created_at}; a refresh that
 *     returns the same event revalidates the entry (bumps {@code fetchedAt})
 *     so stale-while-revalidate loops terminate.
 *
 * Pure Java + org.json — no Android types — so the logic runs in JVM unit
 * tests. Thread-safety is the caller's (the service confines it to its
 * handler thread).
 */
final class ProfileStore {

    /** One cached resolution for a pubkey. */
    static final class Entry {
        final String name;      // display name (null for negative entries)
        final String picture;   // avatar URL (nullable)
        final String nip05;     // nip05 identifier (nullable)
        /** kind-0 created_at (seconds). 0 for negative entries. */
        final long ts;
        /** Wall-clock ms of the fetch that produced this entry. */
        final long fetchedAt;
        /** True = fetched and nothing was found (suppress refetch for the TTL). */
        final boolean negative;

        private Entry(String name, String picture, String nip05, long ts, long fetchedAt, boolean negative) {
            this.name = name;
            this.picture = picture;
            this.nip05 = nip05;
            this.ts = ts;
            this.fetchedAt = fetchedAt;
            this.negative = negative;
        }
    }

    private final Map<String, Entry> entries = new HashMap<>();

    /** Positive lookup. Returns null when absent or only a negative entry exists. */
    Entry get(String pubkey) {
        Entry e = entries.get(pubkey);
        return (e == null || e.negative) ? null : e;
    }

    /** True when a negative entry is fresh enough to suppress a refetch. */
    boolean isFreshMiss(String pubkey, long nowMs, long missTtlMs) {
        Entry e = entries.get(pubkey);
        return e != null && e.negative && nowMs - e.fetchedAt < missTtlMs;
    }

    /** True when a positive entry is old enough to warrant a background refresh. */
    boolean isStale(String pubkey, long nowMs, long staleTtlMs) {
        Entry e = entries.get(pubkey);
        return e != null && !e.negative && nowMs - e.fetchedAt >= staleTtlMs;
    }

    /**
     * Record a fetched kind-0. Newest created_at wins; an equal/older event
     * still revalidates the held entry (bumps fetchedAt) so a background
     * refresh that re-finds the same profile stops the entry being stale.
     */
    void put(String pubkey, String name, String picture, String nip05, long ts, long nowMs) {
        Entry prev = entries.get(pubkey);
        if (prev != null && !prev.negative && prev.ts >= ts) {
            entries.put(pubkey, new Entry(prev.name, prev.picture, prev.nip05, prev.ts, nowMs, false));
            return;
        }
        entries.put(pubkey, new Entry(name, picture, nip05, ts, nowMs, false));
    }

    /** Record a fetch that found no kind-0. Never erases a held profile. */
    void putMiss(String pubkey, long nowMs) {
        Entry prev = entries.get(pubkey);
        if (prev != null && !prev.negative) return;
        entries.put(pubkey, new Entry(null, null, null, 0, nowMs, true));
    }

    int size() {
        return entries.size();
    }

    /** Drop the least-recently-fetched entries until at most {@code max} remain. */
    void evictOldest(int max) {
        while (entries.size() > max) {
            String oldestKey = null;
            long oldestAt = Long.MAX_VALUE;
            for (Map.Entry<String, Entry> e : entries.entrySet()) {
                if (e.getValue().fetchedAt < oldestAt) {
                    oldestAt = e.getValue().fetchedAt;
                    oldestKey = e.getKey();
                }
            }
            if (oldestKey == null) return;
            entries.remove(oldestKey);
        }
    }

    String serialize() {
        JSONObject root = new JSONObject();
        for (Map.Entry<String, Entry> e : entries.entrySet()) {
            Entry v = e.getValue();
            JSONObject o = new JSONObject();
            try {
                if (v.name != null) o.put("n", v.name);
                if (v.picture != null) o.put("p", v.picture);
                if (v.nip05 != null) o.put("n05", v.nip05);
                o.put("ts", v.ts);
                o.put("at", v.fetchedAt);
                if (v.negative) o.put("neg", true);
                root.put(e.getKey(), o);
            } catch (JSONException ignored) {
                // Skip the entry; the rest still persist.
            }
        }
        return root.toString();
    }

    /** Rebuild from {@link #serialize} output. Corrupt input → empty store. */
    static ProfileStore deserialize(String json) {
        ProfileStore store = new ProfileStore();
        if (json == null || json.isEmpty()) return store;
        try {
            JSONObject root = new JSONObject(json);
            for (Iterator<String> it = root.keys(); it.hasNext(); ) {
                String pk = it.next();
                JSONObject o = root.optJSONObject(pk);
                if (o == null) continue;
                store.entries.put(pk, new Entry(
                        o.has("n") ? o.getString("n") : null,
                        o.has("p") ? o.getString("p") : null,
                        o.has("n05") ? o.getString("n05") : null,
                        o.optLong("ts", 0),
                        o.optLong("at", 0),
                        o.optBoolean("neg", false)));
            }
        } catch (JSONException ignored) {
            // Corrupt blob — start empty rather than crash the service.
        }
        return store;
    }
}
