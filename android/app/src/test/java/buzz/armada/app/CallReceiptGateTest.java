package buzz.armada.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** The service's "ringing" receipt budget: one per call id, one per peer per interval. */
public class CallReceiptGateTest {
    private static final String ALICE = "a".repeat(64);
    private static final String BOB = "b".repeat(64);

    private static String call(int n) {
        return String.format("%064x", n);
    }

    @Test public void oncePerCallId() {
        CallReceiptGate gate = new CallReceiptGate();
        assertTrue(gate.admit(ALICE, call(1), 0L));
        assertFalse(gate.admit(ALICE, call(1), CallReceiptGate.PEER_INTERVAL_MS * 10));
    }

    @Test public void aBurstOfFreshCallIdsFromOnePeerSignsOnce() {
        CallReceiptGate gate = new CallReceiptGate();
        assertTrue(gate.admit(ALICE, call(1), 1_000L));
        for (int i = 2; i < 50; i++) assertFalse(gate.admit(ALICE, call(i), 1_000L + i));
        assertTrue(gate.admit(ALICE, call(99), 1_000L + CallReceiptGate.PEER_INTERVAL_MS));
    }

    @Test public void peersAreLimitedSeparately() {
        CallReceiptGate gate = new CallReceiptGate();
        assertTrue(gate.admit(ALICE, call(1), 0L));
        assertTrue(gate.admit(BOB, call(2), 0L));
    }

    @Test public void refusesMissingArguments() {
        CallReceiptGate gate = new CallReceiptGate();
        assertFalse(gate.admit(null, call(1), 0L));
        assertFalse(gate.admit(ALICE, null, 0L));
    }

    @Test public void forgetsTheOldestCallIdPastItsMemory() {
        CallReceiptGate gate = new CallReceiptGate();
        long t = 0L;
        for (int i = 0; i <= CallReceiptGate.MEMORY; i++) {
            assertTrue(gate.admit(ALICE, call(i), t));
            t += CallReceiptGate.PEER_INTERVAL_MS;
        }
        assertTrue(gate.admit(ALICE, call(0), t));
    }
}
