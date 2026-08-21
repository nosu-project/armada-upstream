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
}
