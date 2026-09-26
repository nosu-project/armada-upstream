package buzz.armada.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.junit.Test;

/**
 * Pure DM-call ownership policy: the service stays silent about a peer's offer
 * while the WebView (or a sibling device of ours) is dialing or in a call with
 * that same peer — the other half of two people dialing each other.
 */
public class NotificationRelayServiceDmCallTest {
    private static final String ALICE = "a".repeat(64);
    private static final String BOB = "b".repeat(64);

    @Test public void reportedCallPeerIsOwnedWhileFresh() {
        long at = 5_000L;
        assertTrue(NotificationRelayService.isOwnCallPeer(ALICE, ALICE, at, at));
        assertTrue(NotificationRelayService.isOwnCallPeer(
                ALICE, ALICE, at, at + NotificationRelayService.CALL_PEER_TTL_MS));
    }

    @Test public void reportedCallPeerExpiresWithoutAHeartbeat() {
        long at = 5_000L;
        assertFalse(NotificationRelayService.isOwnCallPeer(
                ALICE, ALICE, at, at + NotificationRelayService.CALL_PEER_TTL_MS + 1L));
        assertFalse(NotificationRelayService.isOwnCallPeer(ALICE, ALICE, 0L, at));
        assertFalse(NotificationRelayService.isOwnCallPeer(ALICE, ALICE, at, at - 1L));
    }

    @Test public void onlyTheReportedPeerIsSilenced() {
        long at = 5_000L;
        assertFalse(NotificationRelayService.isOwnCallPeer(BOB, ALICE, at, at));
        assertFalse(NotificationRelayService.isOwnCallPeer(ALICE, null, at, at));
        assertFalse(NotificationRelayService.isOwnCallPeer(null, ALICE, at, at));
    }

    @Test public void siblingDialOwnsThePeerForTheRingWindow() {
        long at = 1_000_000L;
        assertTrue(NotificationRelayService.isSiblingDialFresh(ALICE, ALICE, at, at + 30_000L));
        assertFalse(NotificationRelayService.isSiblingDialFresh(ALICE, ALICE, at, at + 61_000L));
        assertFalse(NotificationRelayService.isSiblingDialFresh(BOB, ALICE, at, at));
        assertFalse(NotificationRelayService.isSiblingDialFresh(ALICE, null, at, at));
    }

    @Test public void ringingReceiptOnlyWithALocalKey() {
        NativeSigner key = new NativeSigner.DirectKey(new byte[32]);
        try {
            assertTrue(NotificationRelayService.maySendCallReceipt(key));
        } finally {
            key.close();
        }
        assertFalse(NotificationRelayService.maySendCallReceipt(null));
        // Amber and NIP-46 inherit the default: a signature there may prompt.
        NativeSigner remote = new NativeSigner() {
            @Override void decrypt44(String peerPk, String ciphertext, DecryptCallback cb) { }
            @Override void encrypt44(String peerPk, String plaintext, EncryptCallback cb) { }
            @Override void signEvent(int kind, String content, JSONArray tags, long createdAt, SignCallback cb) { }
        };
        try {
            assertFalse(NotificationRelayService.maySendCallReceipt(remote));
        } finally {
            remote.close();
        }
    }
}
