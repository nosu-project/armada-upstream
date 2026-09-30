package buzz.armada.app.relayfleet;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** The byte budget: a slow flood of a large document, which the count limit never sees. */
public class FloodBreakerBytesTest {
    private static final long MIN = 60_000L;
    private static final long READ_STATE = 76_548;

    @Test
    public void aLargeDocumentOnceAMinuteTripsTheByteBudget() {
        FloodBreaker b = new FloodBreaker();
        long pause = 0;
        int delivered = 0;
        for (long t = 0; pause == 0 && t < 15 * MIN; t += MIN) {
            pause = b.onEdition(t, READ_STATE);
            delivered++;
        }
        assertEquals(FloodBreaker.FIRST_COOLDOWN_MS, pause);
        assertEquals((int) (FloodBreaker.BYTE_LIMIT / READ_STATE) + 1, delivered);
    }

    @Test
    public void anHourOfThatFloodCostsAFractionOfItsBytes() {
        FloodBreaker b = new FloodBreaker();
        long downloaded = 0;
        for (long t = 0; t < 60 * MIN; t += MIN) {
            if (b.paused(t)) continue;
            downloaded += READ_STATE;
            b.onEdition(t, READ_STATE);
        }
        // Unguarded: 60 editions, 4.5 MB.
        assertTrue("downloaded " + downloaded, downloaded <= 12 * READ_STATE);
    }

    @Test
    public void smallDeltasAndAnOccasionalRolloverNeverTrip() {
        FloodBreaker b = new FloodBreaker();
        for (long t = 0; t < 120 * MIN; t += MIN / 2) assertEquals(0, b.onEdition(t, 700));
        assertEquals(0, b.onEdition(120 * MIN, READ_STATE));
    }

    @Test
    public void bytesAgeOutOfTheWindow() {
        FloodBreaker b = new FloodBreaker();
        for (int i = 0; i < 6; i++) {
            assertEquals(0, b.onEdition(i * (FloodBreaker.BYTE_WINDOW_MS + 1), READ_STATE));
        }
    }
}
