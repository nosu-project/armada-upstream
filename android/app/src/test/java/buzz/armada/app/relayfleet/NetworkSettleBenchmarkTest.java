package buzz.armada.app.relayfleet;

import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * The fleet across a real night of network changes: the 476 connectivity
 * changes batterystats recorded on the measured device over 11h (seconds from
 * the first), each assumed to drop every socket. A connect takes
 * {@link #CONNECT_MS} on that weak network and fails if the network changes
 * before it completes, retrying on the fleet's 1s-doubling backoff.
 *
 * <p>Two costs pull against each other: handshakes (each a DNS lookup, TLS,
 * the REQs and AUTH round, and radio time) and the time a relay is not
 * listening while the network is up. Settling trades a little of the second
 * for most of the first.
 */
public class NetworkSettleBenchmarkTest {

    private static final int FLEET = 15;
    /** DM-inbox relays reconnect at once (their NIP-17/call subs are live-only); the rest settle. */
    private static final int LIVE_ONLY = 3;
    private static final long CONNECT_MS = 1_500L;
    private static final long[] CHANGES_S = {
            0, 3, 5, 188, 191, 195, 198, 201, 288, 383, 542, 708, 752, 817, 823, 919, 922, 928, 931, 962,
            1728, 1853, 1859, 3118, 5570, 5601, 5607, 5610, 5626, 6646, 6649, 6652, 6753, 6756, 7227, 7231, 7243, 7262, 7265, 7268,
            7312, 7403, 7418, 7421, 7428, 7431, 7440, 7446, 7453, 7459, 7465, 7468, 7471, 7474, 7493, 7496, 7499, 7503, 7525, 7549,
            7584, 7593, 7627, 7637, 7640, 7643, 7646, 7649, 7652, 7665, 7671, 7715, 7721, 7724, 7727, 7736, 7740, 7749, 7764, 7777,
            7780, 8870, 8874, 8880, 8889, 8892, 8895, 8901, 8911, 8920, 8923, 8932, 8935, 8963, 8972, 8975, 8988, 8991, 9009, 9037,
            9062, 9074, 9084, 9096, 9109, 9134, 9180, 9202, 9215, 9218, 9246, 9314, 9317, 9324, 9327, 9330, 9333, 9346, 9348, 9358,
            9362, 9368, 9377, 9387, 9390, 9399, 9402, 9405, 9412, 9431, 9449, 9452, 9459, 9462, 9465, 9478, 9481, 9512, 9515, 9562,
            9569, 9572, 9575, 9578, 9584, 9590, 9600, 9637, 9643, 9646, 9655, 9677, 9680, 9690, 9699, 9702, 9724, 9740, 9743, 9749,
            9752, 9758, 9761, 9764, 9774, 9777, 9780, 9783, 9789, 9792, 9795, 9801, 9804, 9808, 9814, 9826, 9832, 9835, 9838, 9851,
            9854, 9864, 9870, 9876, 9879, 9892, 9895, 9898, 9901, 9904, 9911, 9914, 9917, 9923, 9933, 9939, 9948, 9951, 9989, 9995,
            10001, 10013, 10017, 10041, 10048, 10082, 10095, 10098, 10117, 10120, 10126, 10129, 10132, 10135, 10154, 10157, 10164, 10167, 10195, 10251,
            10254, 10257, 10279, 10292, 10310, 10313, 10316, 10335, 10372, 10378, 10382, 10391, 10397, 10400, 10403, 10410, 10416, 10431, 10435, 10450,
            10453, 10468, 10472, 10490, 10493, 10496, 10500, 10531, 10546, 10549, 10562, 10577, 10580, 10593, 10599, 10609, 10612, 10640, 10652, 10658,
            10668, 10674, 10705, 10749, 10755, 10764, 10786, 10789, 10804, 10807, 10820, 10826, 10832, 10836, 10845, 10854, 10857, 10864, 10867, 10873,
            10876, 10882, 10888, 10892, 10904, 10907, 10910, 11032, 11035, 11057, 11075, 11106, 11109, 11112, 11220, 11229, 11232, 11242, 11245, 11248,
            11251, 11302, 11308, 11321, 11330, 11339, 11396, 11421, 11427, 17070, 17074, 21323, 27032, 27036, 32413, 32416, 32428, 32526, 32548, 32554,
            32600, 32628, 32641, 32709, 32743, 32747, 32753, 32756, 32768, 32778, 32787, 32797, 32800, 32809, 32816, 32819, 32881, 32900, 32903, 32927,
            32940, 32943, 32953, 32959, 32962, 32965, 32968, 32971, 32996, 32999, 33005, 33008, 33011, 33014, 33049, 33055, 33070, 33076, 33083, 33086,
            33089, 33110, 33126, 33135, 33138, 33141, 33150, 33157, 33160, 33163, 33166, 33169, 33187, 33191, 33194, 33200, 33203, 33206, 33213, 33219,
            33225, 33228, 33231, 33250, 33253, 33274, 33281, 33287, 33290, 33299, 33302, 33305, 33308, 33311, 33315, 33318, 33321, 33324, 33327, 33330,
            33333, 33336, 33348, 33351, 33358, 33361, 33364, 33367, 33373, 33376, 33379, 33391, 33394, 33397, 33407, 33410, 33492, 33510, 33523, 33529,
            33548, 33551, 33554, 33570, 33573, 33601, 33637, 33640, 33643, 33647, 33649, 33655, 33658, 33661, 33677, 33686, 33689, 33708, 33711, 33717,
            33720, 33727, 33730, 33732, 33736, 33742, 33745, 33748, 33758, 33761, 33766, 33769, 33795, 33798, 33804, 33858, 33862, 33865, 33873, 33873,
            33873, 35581, 36715, 38242, 38342, 38345, 38386, 38392, 38599, 39753, 39765, 39770, 39786, 39828, 39840, 39846,
    };

    record Cost(int attempts, long downMs) {}

    /** One relay's life across the trace; the fleet is FLEET of these. */
    static Cost run(long settleMs) {
        long[] changes = new long[CHANGES_S.length];
        for (int i = 0; i < changes.length; i++) changes[i] = CHANGES_S[i] * 1000L;
        long end = changes[changes.length - 1] + 600_000L;
        int attempts = 0;
        long down = 0;
        int next = 0;          // index of the next network change
        long lastChange = 0;
        long attemptAt = 0;
        long backoff = 1_000L;
        long t = 0;
        while (t < end) {
            long nextChange = next < changes.length ? changes[next] : Long.MAX_VALUE;
            long start = Math.max(attemptAt, lastChange + NetworkSettle.delayMs(lastChange, lastChange, settleMs));
            if (start >= nextChange) {                       // a change comes first
                down += nextChange - t;
                t = lastChange = nextChange; next++;
                attemptAt = t;                               // the edge reconnects now…
                backoff = 1_000L;
                continue;
            }
            if (start >= end) { down += end - t; break; }
            attempts++;
            long done = start + CONNECT_MS;
            if (done >= nextChange) {                        // …and the next change kills it
                down += nextChange - t;
                t = lastChange = nextChange; next++;
                attemptAt = t + backoff;
                backoff = Math.min(backoff * 2, 300_000L);
                continue;
            }
            down += done - t;                                // connected until the next change
            backoff = 1_000L;
            if (nextChange == Long.MAX_VALUE) break;
            t = lastChange = nextChange; next++;
            attemptAt = t;
        }
        return new Cost(attempts * FLEET, down * FLEET);
    }

    @Test
    public void benchmark() {
        long spanMs = (CHANGES_S[CHANGES_S.length - 1] + 600) * 1000L * FLEET;
        Cost now = run(0);
        System.out.printf("%n=== fleet of %d over the device's 11h of network changes (%d) ===%n", FLEET, CHANGES_S.length);
        System.out.printf("  %-26s %10s %24s%n", "", "handshakes", "relay-time not listening");
        System.out.printf("  %-26s %10d %23.1f%%%n", "reconnect on every change", now.attempts(), 100.0 * now.downMs() / spanMs);
        for (long settle : new long[] {3_000, 5_000, NetworkSettle.SETTLE_MS, 20_000}) {
            Cost c = run(settle);
            System.out.printf("  %-26s %10d %23.1f%%%n", "settle " + settle / 1000 + "s first"
                    , c.attempts(), 100.0 * c.downMs() / spanMs);
        }
        Cost settled = run(NetworkSettle.SETTLE_MS);
        Cost shipped = new Cost(
                (now.attempts() * LIVE_ONLY + settled.attempts() * (FLEET - LIVE_ONLY)) / FLEET,
                (now.downMs() * LIVE_ONLY + settled.downMs() * (FLEET - LIVE_ONLY)) / FLEET);
        System.out.printf("  %-26s %10d %23.1f%%  (DM inboxes: %d of %d relays, no settle)%n", "shipped: 10s, DM inboxes 0",
                shipped.attempts(), 100.0 * shipped.downMs() / spanMs, LIVE_ONLY, FLEET);
        assertTrue("settling should cut handshakes by more than half", shipped.attempts() * 2 < now.attempts());
        // Settled relays resume from their cursors, so this is delay, not loss.
        assertTrue("at under six points of listening time",
                (shipped.downMs() - now.downMs()) * 100 < 6 * spanMs);
    }

    @Test
    public void delayIsMeasuredFromTheLastChange() {
        assertTrue(NetworkSettle.delayMs(5_000, 0, 10_000) == 0);
        assertTrue(NetworkSettle.delayMs(12_000, 10_000, 10_000) == 8_000);
        assertTrue(NetworkSettle.delayMs(25_000, 10_000, 10_000) == 0);
    }
}
