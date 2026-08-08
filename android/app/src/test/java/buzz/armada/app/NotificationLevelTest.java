package buzz.armada.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

/**
 * The per-room "mentions only" gate. The level is decided in the WebView and
 * shipped down as {@code groupSubs[].mentionOnly} / {@code concordSubs[]
 * .mentionOnly}; this covers what the service does with it once an event has
 * arrived. Like the Git guards, these avoid an Android runtime so they run on
 * CI hosts — hence the static overload taking prefs explicitly.
 */
public class NotificationLevelTest {
    /** All per-kind prefs at their defaults (every one on). */
    private static final JSONObject DEFAULTS = new JSONObject();

    private static JSONObject prefs(String key, boolean value) throws Exception {
        return new JSONObject().put(key, value);
    }

    @Test public void mentionsOnlyDropsAnOrdinaryGroupMessage() {
        // The bug this exists for: the room's level was ignored entirely, so a
        // message that names nobody notified anyway.
        assertFalse(NotificationRelayService.wantsNotification(
                9, /*mentionsMe=*/false, /*mentionOnly=*/true, DEFAULTS));
        assertTrue(NotificationRelayService.wantsNotification(
                9, /*mentionsMe=*/false, /*mentionOnly=*/false, DEFAULTS));
    }

    @Test public void mentionsOnlyStillLetsAMentionThrough() {
        assertTrue(NotificationRelayService.wantsNotification(
                9, /*mentionsMe=*/true, /*mentionOnly=*/true, DEFAULTS));
    }

    @Test public void mentionsOnlyDropsThreadRepliesThatDontNameYou() {
        // A NIP-22 reply to your own message carries your pubkey in a `p` tag,
        // so the ones that survive are the ones actually directed at you.
        assertFalse(NotificationRelayService.wantsNotification(
                1111, /*mentionsMe=*/false, /*mentionOnly=*/true, DEFAULTS));
        assertTrue(NotificationRelayService.wantsNotification(
                1111, /*mentionsMe=*/true, /*mentionOnly=*/true, DEFAULTS));
    }

    @Test public void mentionsOnlyKeepsReactionsToYourOwnMessage() {
        // A reaction only reaches the gate having `p`-tagged you (NIP-25), so
        // it is a mention by construction and outlives the room's level.
        assertTrue(NotificationRelayService.wantsNotification(
                7, /*mentionsMe=*/true, /*mentionOnly=*/true, DEFAULTS));
    }

    @Test public void theRoomLevelOutranksTheGlobalPref() throws Exception {
        // "mentions only" wins over an allGroupMessages that is explicitly on…
        assertFalse(NotificationRelayService.wantsNotification(
                9, false, true, prefs("allGroupMessages", true)));
        // …and the global pref still wins where the room says nothing special.
        assertFalse(NotificationRelayService.wantsNotification(
                9, false, false, prefs("allGroupMessages", false)));
    }

    @Test public void aMentionStillObeysTheMentionsPrefBeingOff() throws Exception {
        assertFalse(NotificationRelayService.wantsNotification(
                9, /*mentionsMe=*/true, /*mentionOnly=*/true, prefs("mentions", false)));
    }

    @Test public void dmsAreUnaffected() {
        // A DM has no `h` tag, so mentionOnly is never set for one; and it
        // `p`-tags the recipient, so it reads as a mention regardless.
        assertTrue(NotificationRelayService.wantsNotification(
                4, /*mentionsMe=*/true, /*mentionOnly=*/true, DEFAULTS));
    }
}
