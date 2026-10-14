package buzz.armada.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class AlertPolicyTest {

    @Test
    public void nothingHeldUntilAnotherDeviceIsUsed() {
        AlertPolicy p = new AlertPolicy();
        assertFalse(p.holding(0));
        assertFalse(p.holding(1_000_000));
    }

    @Test
    public void holdsForAMinuteAfterActivityElsewhere() {
        AlertPolicy p = new AlertPolicy();
        p.noteOtherDeviceActivity(10_000);
        assertTrue(p.holding(10_000));
        assertTrue(p.holding(69_999));
        assertFalse(p.holding(70_000));
    }

    @Test
    public void channelAlertsOncePerTwentySeconds() {
        AlertPolicy p = new AlertPolicy();
        assertTrue(p.shouldAlert("c2:a", false, 0));
        assertFalse(p.shouldAlert("c2:a", false, 5_000));
        assertFalse(p.shouldAlert("c2:a", false, 19_999));
        assertTrue(p.shouldAlert("c2:a", false, 20_000));
    }

    @Test
    public void silentPostsDoNotExtendTheThrottle() {
        AlertPolicy p = new AlertPolicy();
        assertTrue(p.shouldAlert("c2:a", false, 0));
        assertFalse(p.shouldAlert("c2:a", false, 15_000));
        assertTrue(p.shouldAlert("c2:a", false, 21_000));
    }

    @Test
    public void directMessagesAndMentionsUseTheShortThrottle() {
        AlertPolicy p = new AlertPolicy();
        assertTrue(p.shouldAlert("dm:x", true, 0));
        assertFalse(p.shouldAlert("dm:x", true, 4_999));
        assertTrue(p.shouldAlert("dm:x", true, 5_000));
        assertTrue(p.shouldAlert("c2:a", false, 0));
        assertTrue(p.shouldAlert("c2:a", true, 6_000));
    }

    @Test
    public void roomsAreThrottledIndependently() {
        AlertPolicy p = new AlertPolicy();
        assertTrue(p.shouldAlert("c2:a", false, 0));
        assertTrue(p.shouldAlert("c2:b", false, 1));
    }

    @Test
    public void channelsOfOneCommunityShareTheThrottleButMentionsDoNot() {
        AlertPolicy p = new AlertPolicy();
        assertTrue(p.shouldAlert("group:c2:soapbox", false, 0));
        assertFalse(p.shouldAlert("group:c2:soapbox", false, 10_000));
        assertTrue(p.shouldAlert("c2:ngit", true, 10_000));
        assertTrue(p.shouldAlert("group:c2:other", false, 10_000));
    }

    @Test
    public void aBackwardClockStepDoesNotSilenceARoom() {
        AlertPolicy p = new AlertPolicy();
        assertTrue(p.shouldAlert("c2:a", false, 100_000));
        assertTrue(p.shouldAlert("c2:a", false, 50_000));
    }
}
