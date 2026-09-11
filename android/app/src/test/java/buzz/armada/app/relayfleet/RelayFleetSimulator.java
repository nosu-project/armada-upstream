package buzz.armada.app.relayfleet;

import buzz.armada.app.relayfleet.RelayFleetPolicy.ConnectionResult;
import buzz.armada.app.relayfleet.RelayFleetPolicy.FleetDecision;
import buzz.armada.app.relayfleet.RelayFleetPolicy.FleetEdge;
import buzz.armada.app.relayfleet.RelayFleetPolicy.RelayInfo;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.PriorityQueue;

/**
 * A deterministic, network-free discrete-event simulator for a
 * {@link RelayFleetPolicy}. It advances a virtual clock through scripted relay
 * behaviors ({@link RelayScenario}) and external edges, executing the policy's
 * decisions, and records the cost metrics that stand in for battery: how many
 * connect attempts a policy makes, whether the fleet ever goes quiet, and how
 * many sockets it holds.
 *
 * <p>Every time value the policy sees is the simulator's virtual clock, so a
 * run is fully reproducible and there is no {@code Handler}, {@code Looper}, or
 * real time involved.
 */
public final class RelayFleetSimulator {

    /** A scripted external event at a fixed virtual time. */
    public record ScriptedEdge(long timeMs, FleetEdge edge) {}

    private enum Kind { ATTEMPT, END, EDGE }

    private record Event(long timeMs, long seq, Kind kind, int relay, int gen,
                         ConnectionResult result, FleetEdge edge) {}

    /** Per-policy run results, with the metrics used by the benchmark. */
    public static final class Result {
        public final String policyName;
        public final long horizonMs;
        public final List<String> urls;
        public final List<List<Long>> attemptTimes; // parallel to urls
        public final boolean[] heldSocketAtHorizon;
        public final boolean[] quarantinedAtHorizon;
        public final boolean[] deliverable;

        Result(String policyName, long horizonMs, List<String> urls, List<List<Long>> attemptTimes,
               boolean[] heldSocketAtHorizon, boolean[] quarantinedAtHorizon, boolean[] deliverable) {
            this.policyName = policyName;
            this.horizonMs = horizonMs;
            this.urls = urls;
            this.attemptTimes = attemptTimes;
            this.heldSocketAtHorizon = heldSocketAtHorizon;
            this.quarantinedAtHorizon = quarantinedAtHorizon;
            this.deliverable = deliverable;
        }

        private int indexOf(String url) {
            int i = urls.indexOf(url);
            if (i < 0) throw new IllegalArgumentException("no such relay: " + url);
            return i;
        }

        public int attemptsOn(String url) { return attemptTimes.get(indexOf(url)).size(); }

        public int totalAttempts() {
            int n = 0;
            for (List<Long> t : attemptTimes) n += t.size();
            return n;
        }

        public int attemptsOnAny(Iterable<String> relayUrls) {
            int n = 0;
            for (String u : relayUrls) n += attemptsOn(u);
            return n;
        }

        /** Attempts that started within the last {@code windowMs} of the horizon. */
        public int finalWindowAttempts(long windowMs) {
            long cutoff = horizonMs - windowMs;
            int n = 0;
            for (List<Long> times : attemptTimes) {
                for (long t : times) if (t >= cutoff) n++;
            }
            return n;
        }

        public int socketsHeld() {
            int n = 0;
            for (boolean held : heldSocketAtHorizon) if (held) n++;
            return n;
        }

        public long lastAttemptMs() {
            long last = -1;
            for (List<Long> times : attemptTimes) {
                for (long t : times) last = Math.max(last, t);
            }
            return last;
        }

        public boolean heldSocket(String url) { return heldSocketAtHorizon[indexOf(url)]; }
    }

    /**
     * Run {@code policy} against {@code scenarios} (with {@code edges}) out to
     * {@code horizonMs}.
     */
    public Result run(RelayFleetPolicy policy, List<RelayScenario> scenarios,
                      List<ScriptedEdge> edges, long horizonMs) {
        int n = scenarios.size();
        Object[] state = new Object[n];
        int[] gen = new int[n];
        boolean[] quarantined = new boolean[n];
        boolean[] socketOpen = new boolean[n];
        boolean[] lastOpened = new boolean[n];
        long[] lastEndAt = new long[n];
        boolean[] deliverable = new boolean[n];
        List<String> urls = new ArrayList<>(n);
        List<List<Long>> attempts = new ArrayList<>(n);

        PriorityQueue<Event> pq = new PriorityQueue<>(
                Comparator.comparingLong(Event::timeMs).thenComparingLong(Event::seq));
        long[] seq = {0};

        for (int i = 0; i < n; i++) {
            state[i] = policy.newRelayState();
            lastEndAt[i] = -1;
            RelayInfo info = scenarios.get(i).relay();
            urls.add(info.url());
            deliverable[i] = info.deliverable();
            attempts.add(new ArrayList<>());
            if (policy.shouldConnect(state[i], info, 0)) {
                pq.add(new Event(0, seq[0]++, Kind.ATTEMPT, i, gen[i], null, null));
            }
        }
        for (ScriptedEdge e : edges) {
            pq.add(new Event(e.timeMs(), seq[0]++, Kind.EDGE, -1, 0, null, e.edge()));
        }

        while (!pq.isEmpty()) {
            Event ev = pq.poll();
            if (ev.timeMs() > horizonMs) break;

            switch (ev.kind()) {
                case ATTEMPT -> {
                    int i = ev.relay();
                    if (ev.gen() != gen[i]) continue; // cancelled by a later edge
                    RelayInfo info = scenarios.get(i).relay();
                    if (!policy.shouldConnect(state[i], info, ev.timeMs())) continue;
                    attempts.get(i).add(ev.timeMs());
                    RelayScenario.Attempt a = scenarios.get(i).attempt(ev.timeMs());
                    if (a.endsAfterMs() >= RelayScenario.NEVER) {
                        lastOpened[i] = true;
                        lastEndAt[i] = RelayScenario.NEVER;
                        socketOpen[i] = true;
                    } else {
                        lastOpened[i] = a.opened();
                        socketOpen[i] = a.opened();
                        long endAt = ev.timeMs() + a.endsAfterMs();
                        lastEndAt[i] = endAt;
                        ConnectionResult res =
                                new ConnectionResult(a.opened(), a.uptimeMs(), a.outcome());
                        pq.add(new Event(endAt, seq[0]++, Kind.END, i, gen[i], res, null));
                    }
                }
                case END -> {
                    int i = ev.relay();
                    if (ev.gen() != gen[i]) continue;
                    socketOpen[i] = false;
                    FleetDecision d = policy.onConnectionEnded(
                            state[i], scenarios.get(i).relay(), ev.result(), ev.timeMs());
                    if (d instanceof FleetDecision.RetryAfter r) {
                        long at = ev.timeMs() + r.delayMs();
                        if (at <= horizonMs) {
                            pq.add(new Event(at, seq[0]++, Kind.ATTEMPT, i, gen[i], null, null));
                        }
                    } else if (d instanceof FleetDecision.Quarantine) {
                        quarantined[i] = true;
                    }
                }
                case EDGE -> {
                    for (int i = 0; i < n; i++) {
                        RelayInfo info = scenarios.get(i).relay();
                        policy.onEdge(state[i], info, ev.edge(), ev.timeMs());
                        // Reconnect an idle relay immediately (as the service
                        // does on connectivity return). A relay currently
                        // holding a socket is left alone. Bumping the generation
                        // cancels any pending backoff attempt so it comes
                        // forward to now rather than firing twice.
                        if (!socketOpen[i] && policy.shouldConnect(state[i], info, ev.timeMs())) {
                            quarantined[i] = false;
                            gen[i]++;
                            pq.add(new Event(ev.timeMs(), seq[0]++, Kind.ATTEMPT, i, gen[i], null, null));
                        }
                    }
                }
            }
        }

        boolean[] held = new boolean[n];
        for (int i = 0; i < n; i++) {
            held[i] = lastOpened[i] && lastEndAt[i] > horizonMs;
        }
        return new Result(policy.name(), horizonMs, urls, attempts, held, quarantined, deliverable);
    }
}
