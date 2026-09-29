package buzz.armada.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import buzz.armada.app.relayfleet.CursorGate;

import org.junit.Test;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Random;
import java.util.Set;

/**
 * Replays one relay's traffic through reconnect churn to compare how the
 * service's per-relay {@code since} cursor moves.
 *
 * <p>Shaped on the device trace: 476 connectivity changes in 11h (a session
 * lasts ~83s on average), a busy NIP-29 group the user only wants mentions
 * from, and a quiet subscription beside it. The relay answers each REQ with its
 * stored matches newest first at a finite rate, then EOSE, then streams live,
 * and a socket can drop mid-replay. Each redelivered event costs a Schnorr
 * verify and a store write on the phone; each missed wanted event is a
 * notification that never fires.
 */
public class CursorReplayBenchmarkTest {

    private static final long HORIZON_S = 11 * 3600;
    private static final long GROUP_EVERY_S = 10;
    private static final int WANTED_EVERY = 50;          // 2% of the group mentions the user
    private static final long QUIET_EVERY_S = 1800;       // the second, all-wanted subscription
    private static final double MEAN_SESSION_S = 83;
    private static final long OFFLINE_S = 3;
    /** Events a phone on poor LTE takes in per second (transfer + verify + store). */
    private static final double REPLAY_PER_S = 5;
    /** Dead zones: the phone is offline this long at these times. */
    private static final long[] DEAD_ZONE_AT_S = {3 * 3600, 7 * 3600};
    private static final long DEAD_ZONE_S = 45 * 60;

    enum Strategy {
        /** The shipped rule: only an event that notifies moves the cursor. */
        WANTED_ONLY,
        /** Every accepted event moves the cursor as it arrives. */
        EVERY_EVENT,
        /** Every accepted event, held until the session's backfill completes. */
        EVERY_EVENT_GATED
    }

    record Event(int id, long createdAt, int sub, boolean wanted) {}

    static final class Result {
        final Strategy strategy;
        int delivered, redelivered, sessions, droppedMidReplay;
        final Set<Integer> missedWanted = new HashSet<>();
        Result(Strategy s) { strategy = s; }
    }

    private static List<Event> traffic() {
        List<Event> events = new ArrayList<>();
        int id = 0;
        for (long t = 1; t < HORIZON_S; t++) {
            if (t % GROUP_EVERY_S == 0) {
                events.add(new Event(id, t, 0, id % WANTED_EVERY == 0));
                id++;
            }
            if (t % QUIET_EVERY_S == 7) events.add(new Event(id++, t, 1, true));
        }
        return events;
    }

    private static List<long[]> sessions(long seed) {
        Random rnd = new Random(seed);
        List<long[]> out = new ArrayList<>();
        long t = 0;
        while (t < HORIZON_S) {
            long len = Math.max(5, Math.round(-Math.log(1 - rnd.nextDouble()) * MEAN_SESSION_S));
            out.add(new long[] {t, Math.min(HORIZON_S, t + len)});
            t += len + OFFLINE_S;
            for (long dz : DEAD_ZONE_AT_S) if (t - len - OFFLINE_S < dz && t >= dz) t = dz + DEAD_ZONE_S;
        }
        return out;
    }

    static Result run(Strategy strategy, List<Event> events, List<long[]> sessions) {
        Result r = new Result(strategy);
        Set<Integer> seen = new HashSet<>();
        long cursor = 0;
        boolean cursorHasEvent = false;
        CursorGate gate = new CursorGate();
        for (long[] session : sessions) {
            long start = session[0], end = session[1];
            r.sessions++;
            gate.reset();
            gate.onReqSent("group");
            gate.onReqSent("quiet");
            long since = NotificationRelayService.subscriptionSince(cursor, cursorHasEvent);

            // Backfill: each sub's stored matches, newest first, then its EOSE.
            double clock = start;
            boolean dropped = false;
            for (int sub = 0; sub < 2 && !dropped; sub++) {
                for (int i = events.size() - 1; i >= 0; i--) {
                    Event e = events.get(i);
                    if (e.sub != sub || e.createdAt > start || e.createdAt < since) continue;
                    clock += 1 / REPLAY_PER_S;
                    if (clock >= end) { dropped = true; break; }
                    if (!seen.add(e.id)) r.redelivered++;
                    r.delivered++;
                    long now = (long) clock;
                    long commit = switch (strategy) {
                        case WANTED_ONLY -> e.wanted ? e.createdAt : -1;
                        case EVERY_EVENT -> e.createdAt;
                        case EVERY_EVENT_GATED -> gate.onEvent(e.createdAt);
                    };
                    if (commit >= 0) {
                        cursor = NotificationRelayService.advanceInclusiveSince(cursor, commit, now);
                        cursorHasEvent = true;
                    }
                }
                if (!dropped && strategy == Strategy.EVERY_EVENT_GATED) {
                    long commit = gate.onBackfillEnded(sub == 0 ? "group" : "quiet");
                    if (commit >= 0) {
                        cursor = NotificationRelayService.advanceInclusiveSince(cursor, commit, (long) clock);
                        cursorHasEvent = true;
                    }
                }
            }
            if (dropped) { r.droppedMidReplay++; continue; }

            // Live: everything created while the socket is up.
            for (Event e : events) {
                if (e.createdAt <= start || e.createdAt >= end || e.createdAt < clock) continue;
                if (!seen.add(e.id)) r.redelivered++;
                r.delivered++;
                long commit = switch (strategy) {
                    case WANTED_ONLY -> e.wanted ? e.createdAt : -1;
                    case EVERY_EVENT -> e.createdAt;
                    case EVERY_EVENT_GATED -> gate.onEvent(e.createdAt);
                };
                if (commit >= 0) {
                    cursor = NotificationRelayService.advanceInclusiveSince(cursor, commit, e.createdAt);
                    cursorHasEvent = true;
                }
            }
        }
        for (Event e : events) if (e.wanted && !seen.contains(e.id)) r.missedWanted.add(e.id);
        return r;
    }

    @Test
    public void benchmark() {
        List<Event> events = traffic();
        StringBuilder out = new StringBuilder(String.format(
                "%n=== relay cursor under reconnect churn: 11h, %d events, ~%.0fs sessions, two %d-min dead zones ===%n",
                events.size(), MEAN_SESSION_S, DEAD_ZONE_S / 60));
        out.append(String.format("  %-20s %9s %11s %12s %13s%n",
                "strategy", "delivered", "redelivered", "mid-replay", "missed wanted"));
        List<Result[]> runs = new ArrayList<>();
        for (long seed = 1; seed <= 3; seed++) {
            List<long[]> sessions = sessions(seed);
            Result wantedOnly = run(Strategy.WANTED_ONLY, events, sessions);
            Result every = run(Strategy.EVERY_EVENT, events, sessions);
            Result gated = run(Strategy.EVERY_EVENT_GATED, events, sessions);
            for (Result r : List.of(wantedOnly, every, gated)) {
                out.append(String.format("  %-20s %9d %11d %8d/%-4d %13d%n", r.strategy.name().toLowerCase(),
                        r.delivered, r.redelivered, r.droppedMidReplay, r.sessions, r.missedWanted.size()));
            }
            out.append("  --\n");
            runs.add(new Result[] {wantedOnly, every, gated});
        }
        System.out.print(out);
        for (Result[] run : runs) {
            Result wantedOnly = run[0], every = run[1], gated = run[2];
            assertTrue("the shipped rule should redeliver heavily under churn",
                    wantedOnly.redelivered > 3 * gated.redelivered);
            assertTrue("moving the cursor as a replay arrives loses wanted events",
                    every.missedWanted.size() > 0 && wantedOnly.missedWanted.size() > 0);
            assertEquals("the gated cursor never skips a wanted event", 0, gated.missedWanted.size());
        }
    }

    @Test
    public void aDropMidReplayDoesNotAdvanceTheCursor() {
        CursorGate gate = new CursorGate();
        gate.onReqSent("a");
        gate.onReqSent("b");
        assertEquals(-1, gate.onEvent(500));      // newest replayed first: held
        assertEquals(-1, gate.onEvent(100));
        assertEquals(-1, gate.onBackfillEnded("a"));
        // The socket dies before b's EOSE: a new session starts from scratch.
        gate.reset();
        gate.onReqSent("a");
        assertEquals(-1, gate.onEvent(200));
        assertEquals(200, gate.onBackfillEnded("a"));
        assertEquals(700, gate.onEvent(700));     // live: immediate
    }

    @Test
    public void aResentSubscriptionHoldsTheCursorAgain() {
        CursorGate gate = new CursorGate();
        gate.onReqSent("a");
        assertEquals(-1, gate.onBackfillEnded("a"));
        assertEquals(300, gate.onEvent(300));
        gate.onReqSent("walled");                 // re-sent after AUTH: replays again
        assertEquals(-1, gate.onEvent(400));
        assertEquals(400, gate.onBackfillEnded("walled"));
        assertEquals(-1, gate.onBackfillEnded("walled"));
    }
}
