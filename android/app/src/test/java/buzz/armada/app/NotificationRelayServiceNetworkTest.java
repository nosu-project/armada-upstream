package buzz.armada.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import buzz.armada.app.relayfleet.NetworkSettle;

/**
 * The unvalidated-network hold. The callback is registered for every network
 * with INTERNET, so background cellular reports capability changes (signal
 * strength among them) while the default Wi-Fi is still unvalidated.
 */
public class NotificationRelayServiceNetworkTest {

    @Test
    public void onlyTheDefaultNetworkCounts() {
        assertTrue(NotificationRelayService.isDefaultNetwork("wifi", "wifi"));
        assertFalse(NotificationRelayService.isDefaultNetwork("cellular", "wifi"));
        assertFalse(NotificationRelayService.isDefaultNetwork("cellular", null));
    }

    /**
     * Replays the service's hold: {@code unvalidatedSince} is cleared by a
     * validated callback and restarted by the next connect that finds the
     * default network still unvalidated.
     */
    @Test
    public void anotherNetworksCallbacksDoNotRestartTheHold() {
        String defaultNetwork = "wifi"; // associated, never validates
        long start = 0;
        long unvalidatedSince = start + 1; // first connect found it unvalidated
        long end = start + 5 * 60_000L;
        long firstConnectAt = -1;
        for (long now = start + 1; now <= end && firstConnectAt < 0; now += 1_000L) {
            // Cellular in the background reports a validated capability change every 20s.
            if ((now - start) % 20_000L == 1
                    && NotificationRelayService.isDefaultNetwork("cellular", defaultNetwork)) {
                unvalidatedSince = 0;
            }
            if (unvalidatedSince == 0) unvalidatedSince = now;
            long hold = NetworkSettle.unvalidatedDelayMs(false, now, unvalidatedSince, NetworkSettle.UNVALIDATED_GRACE_MS);
            if (hold == 0) firstConnectAt = now;
        }
        assertEquals(start + 1 + NetworkSettle.UNVALIDATED_GRACE_MS, firstConnectAt);
    }
}
