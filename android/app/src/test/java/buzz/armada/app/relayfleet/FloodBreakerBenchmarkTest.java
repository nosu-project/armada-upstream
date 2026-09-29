package buzz.armada.app.relayfleet;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

/**
 * The recorded storm: every new edition of the account's community-list
 * fragment that relay.ditto.pub broadcast while another client was stuck
 * republishing it — 2,762 editions in 1.9 hours, arrival times in tenths of a
 * second (resources/self-doc-storm-deciseconds.txt). Each is a 38 KB download.
 */
public class FloodBreakerBenchmarkTest {

    private static final long EDITION_BYTES = 38_700L;

    private static long[] storm() throws Exception {
        try (InputStream in = FloodBreakerBenchmarkTest.class.getClassLoader()
                .getResourceAsStream("self-doc-storm-deciseconds.txt")) {
            String text = new String(in.readAllBytes(), StandardCharsets.UTF_8).trim();
            return Arrays.stream(text.split(",")).mapToLong(s -> Long.parseLong(s.trim()) * 100L).toArray();
        }
    }

    record Cost(long downloaded, long worstStaleMs) {}

    /** Editions downloaded, and the longest the device went without the newest edition. */
    static Cost run(long[] arrivals, boolean breaker) {
        FloodBreaker b = new FloodBreaker();
        long downloaded = 0, worstStale = 0;
        long pausedAt = -1;
        int missedWhilePaused = 0;
        long firstMissedAt = 0;
        for (long t : arrivals) {
            if (breaker && pausedAt >= 0 && t >= b.pausedUntil()) {
                // Resume: one bounded read, newest first, from the pause.
                downloaded += Math.min(missedWhilePaused, FloodBreaker.RESUME_LIMIT);
                if (missedWhilePaused > 0) worstStale = Math.max(worstStale, b.pausedUntil() - firstMissedAt);
                pausedAt = -1;
                missedWhilePaused = 0;
            }
            if (breaker && b.paused(t)) {
                if (missedWhilePaused++ == 0) firstMissedAt = t;
                continue;
            }
            downloaded++;
            if (breaker && b.onEdition(t) > 0) pausedAt = t;
        }
        if (missedWhilePaused > 0) {
            downloaded += Math.min(missedWhilePaused, FloodBreaker.RESUME_LIMIT);
            worstStale = Math.max(worstStale, b.pausedUntil() - firstMissedAt);
        }
        return new Cost(downloaded, worstStale);
    }

    @Test
    public void benchmark() throws Exception {
        long[] arrivals = storm();
        Cost open = run(arrivals, false);
        Cost broken = run(arrivals, true);
        System.out.printf("%n=== self-document flood: %d editions over %.1f h from one relay ===%n",
                arrivals.length, arrivals[arrivals.length - 1] / 3_600_000.0);
        System.out.printf("  %-24s %9s %9s %16s%n", "", "editions", "MB", "newest late by");
        System.out.printf("  %-24s %9d %9.1f %16s%n", "subscription left open", open.downloaded(),
                open.downloaded() * EDITION_BYTES / 1e6, "0");
        System.out.printf("  %-24s %9d %9.1f %15dm%n", "flood breaker", broken.downloaded(),
                broken.downloaded() * EDITION_BYTES / 1e6, broken.worstStaleMs() / 60_000);
        assertEquals(arrivals.length, open.downloaded());
        assertTrue("the breaker should cut downloads twentyfold", broken.downloaded() * 20 < open.downloaded());
        assertTrue("and never leave the newest edition more than the longest cooldown behind",
                broken.worstStaleMs() <= FloodBreaker.MAX_COOLDOWN_MS);
    }

    @Test
    public void ordinaryEditingNeverTrips() {
        FloodBreaker b = new FloodBreaker();
        // A burst of joins: six editions a few seconds apart, then quiet.
        for (int i = 0; i < FloodBreaker.LIMIT; i++) assertEquals(0, b.onEdition(i * 5_000L));
        // An hour of edits every ten minutes.
        for (long t = 600_000; t < 3_600_000; t += 600_000) assertEquals(0, b.onEdition(t));
    }

    @Test
    public void aSustainedFloodEscalatesAndAQuietOneResets() {
        FloodBreaker b = new FloodBreaker();
        long t = 0;
        long pause = 0;
        for (int i = 0; i <= FloodBreaker.LIMIT; i++) pause = Math.max(pause, b.onEdition(t += 1_000));
        assertEquals(FloodBreaker.FIRST_COOLDOWN_MS, pause);
        t = b.pausedUntil();
        pause = 0;
        for (int i = 0; i <= FloodBreaker.LIMIT; i++) pause = Math.max(pause, b.onEdition(t += 1_000));
        assertEquals(2 * FloodBreaker.FIRST_COOLDOWN_MS, pause);
        t = b.pausedUntil() + FloodBreaker.MAX_COOLDOWN_MS + 1;
        pause = 0;
        for (int i = 0; i <= FloodBreaker.LIMIT; i++) pause = Math.max(pause, b.onEdition(t += 1_000));
        assertEquals(FloodBreaker.FIRST_COOLDOWN_MS, pause);
    }
}
