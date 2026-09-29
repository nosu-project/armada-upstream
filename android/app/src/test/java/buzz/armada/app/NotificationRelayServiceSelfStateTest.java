package buzz.armada.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.Set;

import org.junit.Test;

import buzz.armada.app.relayfleet.FloodBreaker;

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

    /**
     * A windowed document passes the counter twice: once when it is staged, and
     * again when the window closes and replays it for filing.
     */
    @Test
    public void aWindowedDocumentCountsOnceTowardTheFloodBreaker() {
        FloodBreaker breaker = new FloodBreaker();
        long t = 1_000_000L;
        int pieces = 4; // one republish touching four DM-index pieces
        long paused = 0;
        for (int i = 0; i < pieces; i++) {
            if (NotificationRelayService.countsTowardSelfFlood(true, false)) paused += breaker.onEdition(t + i);
        }
        long flushAt = t + NotificationRelayService.SELF_TOPIC_WINDOW_MS;
        for (int i = 0; i < pieces; i++) {
            if (NotificationRelayService.countsTowardSelfFlood(true, true)) paused += breaker.onEdition(flushAt + i);
        }
        org.junit.Assert.assertEquals(0L, paused);
        assertFalse(breaker.paused(flushAt + pieces));
    }

    @Test
    public void aFloodResumeReopensTheSubscriptionItPaused() {
        long until = 1_300_000L;
        assertTrue(NotificationRelayService.resumesSelfAfterPause(true, false, until, until));
        // The socket is down: its next session sends the REQ.
        assertFalse(NotificationRelayService.resumesSelfAfterPause(false, false, until, until));
    }

    @Test
    public void aFloodResumeDoesNotReplaceTheNextAccountsFullRead() {
        long until = 1_300_000L;
        // An account switch cleared the breakers; the next account's is fresh.
        long nextAccountsBreaker = new FloodBreaker().pausedUntil();
        assertFalse(NotificationRelayService.resumesSelfAfterPause(true, true, until, nextAccountsBreaker));
        assertFalse(NotificationRelayService.resumesSelfAfterPause(true, false, until, nextAccountsBreaker));
    }

    @Test
    public void aFloodResumeDoesNotReplaceASubscriptionAReconnectReopened() {
        long until = 1_300_000L;
        assertFalse(NotificationRelayService.resumesSelfAfterPause(true, true, until, until));
    }

    @Test
    public void aFloodResumeYieldsToALaterPause() {
        long until = 1_300_000L;
        long later = until + FloodBreaker.FIRST_COOLDOWN_MS * 2;
        assertFalse(NotificationRelayService.resumesSelfAfterPause(true, false, until, later));
    }
}
