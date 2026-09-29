package buzz.armada.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class NotificationRelayServiceAccountTest {

    @Test
    public void anAccountChangeDropsEveryRelayPosition() {
        NotificationRelayService.AccountCursors cursors = new NotificationRelayService.AccountCursors();
        long now = 1_790_700_000_000L;
        cursors.relaySince.put("wss://r", now / 1000);
        cursors.relaysWithEvents.add("wss://r");
        cursors.selfSince.put("wss://r", now / 1000);
        cursors.dm17LiveUntil.put("wss://r", now - 3_600_000L);

        cursors.clear();

        assertTrue(cursors.relaySince.isEmpty());
        assertTrue(cursors.relaysWithEvents.isEmpty());
        assertTrue(cursors.selfSince.isEmpty());
        assertTrue(cursors.dm17LiveUntil.isEmpty());
    }

    /** The outgoing account's gap must not become the incoming one's catch-up floor. */
    @Test
    public void theNextAccountsFirstDmReadIsLiveOnly() {
        NotificationRelayService.AccountCursors cursors = new NotificationRelayService.AccountCursors();
        long now = 1_790_700_000_000L;
        cursors.dm17LiveUntil.put("wss://inbox", now - 3_600_000L);

        cursors.clear();

        assertEquals(0L, NotificationRelayService.dm17CatchUpFloorSec(cursors.dm17LiveUntil.get("wss://inbox"), now));
    }
}
