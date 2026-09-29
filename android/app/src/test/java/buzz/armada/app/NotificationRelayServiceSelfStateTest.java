package buzz.armada.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.Set;

import org.junit.Test;

public class NotificationRelayServiceSelfStateTest {
    @Test
    public void selfStateUsesOnlyTheAccountRelaySet() {
        Set<String> accountRelays = new LinkedHashSet<>();
        accountRelays.add("wss://account.example");

        assertTrue(NotificationRelayService.shouldSyncSelfStateFromRelay(
                "wss://account.example", accountRelays));
        assertFalse(NotificationRelayService.shouldSyncSelfStateFromRelay(
                "wss://joined-nip29.example", accountRelays));
        assertFalse(NotificationRelayService.shouldSyncSelfStateFromRelay(
                "wss://app.example", Collections.emptySet()));
    }

    @Test
    public void aPersistedSelfCursorResumesUnlessMissingFutureOrStale() {
        long now = 1_790_700_000L;
        org.junit.Assert.assertNull(NotificationRelayService.persistedSelfSince(0, now));
        org.junit.Assert.assertEquals(Long.valueOf(now - 3_600), NotificationRelayService.persistedSelfSince(now - 3_600, now));
        org.junit.Assert.assertNull(NotificationRelayService.persistedSelfSince(now + 60, now));
        org.junit.Assert.assertNull(NotificationRelayService.persistedSelfSince(
                now - NotificationRelayService.SELF_SINCE_MAX_AGE_SEC - 1, now));
        // Account-scoped, so a different login never inherits a position.
        org.junit.Assert.assertNotEquals(
                NotificationRelayService.selfCursorKey("a".repeat(64), "wss://r"),
                NotificationRelayService.selfCursorKey("b".repeat(64), "wss://r"));
    }
}
