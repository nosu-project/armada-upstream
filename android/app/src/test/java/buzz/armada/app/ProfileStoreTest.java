package buzz.armada.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * JVM tests for {@link ProfileStore} — the durable kind-0 cache behind
 * {@link NotificationRelayService}'s author resolution. These pin the
 * semantics that stop the notification service re-broadcasting one-shot
 * kind-0 REQs: fetch once and reuse (across service restarts via
 * serialize/deserialize), newest-wins, negative caching with TTL, and
 * staleness judged on fetch time (so refreshes terminate).
 */
public class ProfileStoreTest {

    private static final String PK = "ab".repeat(32);

    @Test
    public void fetchOnceThenReuse_foreverUntilStale() {
        ProfileStore store = new ProfileStore();
        assertNull(store.get(PK)); // unknown → caller fetches

        store.put(PK, "Alice", "https://img/a.png", null, 100, 1_000);

        ProfileStore.Entry e = store.get(PK);
        assertNotNull(e);
        assertEquals("Alice", e.name);
        assertEquals("https://img/a.png", e.picture);
        assertNull(e.nip05);
        assertEquals(100, e.ts);
        // Served without any TTL on the hit path — only staleness (7d in the
        // service) triggers a background refresh, never a blocking refetch.
        assertFalse(store.isStale(PK, 1_000 + 999, 1_000));
        assertTrue(store.isStale(PK, 1_000 + 1_000, 1_000));
    }

    @Test
    public void newestKind0Wins() {
        ProfileStore store = new ProfileStore();
        store.put(PK, "Old", null, null, 100, 1_000);
        store.put(PK, "New", null, null, 200, 2_000);
        assertEquals("New", store.get(PK).name);
        assertEquals(200, store.get(PK).ts);

        // An older event from a lagging relay must NOT clobber the newer one…
        store.put(PK, "Stale", null, null, 150, 3_000);
        assertEquals("New", store.get(PK).name);
        // …but it still revalidates (bumps fetchedAt), so the entry stops
        // being stale and the background-refresh loop terminates.
        assertFalse(store.isStale(PK, 3_000, 1_000));
    }

    @Test
    public void refreshFindingSameProfile_revalidates() {
        ProfileStore store = new ProfileStore();
        store.put(PK, "Alice", null, null, 100, 1_000);
        assertTrue(store.isStale(PK, 1_000 + 10_000, 5_000));

        // The background refresh re-fetches the SAME kind-0 (same created_at).
        store.put(PK, "Alice", null, null, 100, 1_000 + 10_000);
        assertFalse(store.isStale(PK, 1_000 + 10_000, 5_000));
        assertEquals("Alice", store.get(PK).name);
    }

    @Test
    public void negativeEntry_suppressesRefetchForTtl_only() {
        ProfileStore store = new ProfileStore();
        assertFalse(store.isFreshMiss(PK, 1_000, 60_000)); // never fetched

        store.putMiss(PK, 1_000);
        assertNull(store.get(PK)); // a miss is not a profile
        assertTrue(store.isFreshMiss(PK, 1_000 + 59_999, 60_000));
        assertFalse(store.isFreshMiss(PK, 1_000 + 60_000, 60_000)); // expired → refetch
    }

    @Test
    public void missNeverErasesAHeldProfile() {
        ProfileStore store = new ProfileStore();
        store.put(PK, "Alice", null, null, 100, 1_000);
        // Later, relays answer nothing (lossy relay, auth wall, downtime):
        store.putMiss(PK, 2_000);
        // The held profile survives — "this relay didn't have it" ≠ "no profile".
        assertEquals("Alice", store.get(PK).name);
        assertFalse(store.isFreshMiss(PK, 2_000, 60_000));
    }

    @Test
    public void hitReplacesNegativeEntry() {
        ProfileStore store = new ProfileStore();
        store.putMiss(PK, 1_000);
        // The author finally publishes a kind-0 (TTL not yet expired):
        store.put(PK, "Alice", null, null, 100, 2_000);
        assertEquals("Alice", store.get(PK).name);
        assertFalse(store.isFreshMiss(PK, 2_000, 60_000));
    }

    @Test
    public void serializeRoundTrip_preservesHitsAndMisses() {
        ProfileStore store = new ProfileStore();
        store.put(PK, "Ali\"ce\n", "https://img/a.png", "alice@x.com", 100, 1_000);
        store.putMiss("cd".repeat(32), 2_000);

        ProfileStore restored = ProfileStore.deserialize(store.serialize());

        ProfileStore.Entry hit = restored.get(PK);
        assertNotNull(hit);
        assertEquals("Ali\"ce\n", hit.name);
        assertEquals("https://img/a.png", hit.picture);
        assertEquals("alice@x.com", hit.nip05);
        assertEquals(100, hit.ts);
        assertEquals(1_000, hit.fetchedAt);
        assertTrue(restored.isFreshMiss("cd".repeat(32), 2_000, 60_000));
    }

    @Test
    public void deserializeGarbage_yieldsEmptyStore() {
        assertEquals(0, ProfileStore.deserialize(null).size());
        assertEquals(0, ProfileStore.deserialize("").size());
        assertEquals(0, ProfileStore.deserialize("{not json").size());
        assertEquals(0, ProfileStore.deserialize("[1,2,3]").size());
    }

    @Test
    public void evictOldest_dropsLeastRecentlyFetched() {
        ProfileStore store = new ProfileStore();
        for (int i = 0; i < 10; i++) {
            store.put("pk" + i, "n" + i, null, null, 100, 1_000 + i);
        }
        store.evictOldest(3);
        assertEquals(3, store.size());
        // The three most-recently-fetched survive.
        assertNotNull(store.get("pk7"));
        assertNotNull(store.get("pk8"));
        assertNotNull(store.get("pk9"));
        assertNull(store.get("pk0"));
    }
}
