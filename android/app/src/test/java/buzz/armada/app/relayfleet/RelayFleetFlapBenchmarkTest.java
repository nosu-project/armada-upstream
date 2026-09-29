package buzz.armada.app.relayfleet;

import static org.junit.Assert.assertTrue;

import buzz.armada.app.relayfleet.RelayFleetPolicy.FleetEdge;
import buzz.armada.app.relayfleet.RelayFleetPolicy.Outcome;
import buzz.armada.app.relayfleet.RelayFleetPolicy.RelayInfo;
import buzz.armada.app.relayfleet.RelayFleetSimulator.Result;
import buzz.armada.app.relayfleet.RelayFleetSimulator.ScriptedEdge;

import org.junit.Test;

import java.util.ArrayList;
import java.util.List;

/**
 * The fleet on a flapping network, shaped on the device trace: 476
 * connectivity changes in 11h, arriving in bursts while the phone hovered at
 * the edge of a weak Wi-Fi. Every edge used to re-arm every quarantined relay,
 * so a relay behind a dead proxy (relay.armada.buzz answering 502) or a dead
 * name took three doomed handshakes per flap. A relay whose name only fails
 * while the network is bad must still come back promptly once it settles.
 */
public class RelayFleetFlapBenchmarkTest {

    private static final long SEC = 1_000L;
    private static final long MIN = 60 * SEC;
    private static final long HORIZON = 11 * 60 * MIN;
    private static final long FLAP_EVERY_MS = 15 * SEC;
    private static final long[] BURSTS_AT = {60 * MIN, 180 * MIN, 300 * MIN, 390 * MIN, 480 * MIN, 600 * MIN};
    /** Uneven, so a burst's settling edge lands anywhere in the re-arm spacing. */
    private static final long[] BURST_MS = {20 * MIN, 29 * MIN / 4, 39 * MIN / 2, 3 * MIN, 47 * MIN / 4, 55 * MIN / 2};

    private static final String PRIMARY = "wss://relay.primary.example";
    private static final String PROXY_502 = "wss://relay.armada.buzz";
    private static final String DNS_DEAD_A = "wss://dead-a.example";
    private static final String DNS_DEAD_B = "wss://dead-b.example";
    private static final String FLAKY_DNS = "wss://resolves-when-settled.example";
    private static final List<String> DEAD = List.of(PROXY_502, DNS_DEAD_A, DNS_DEAD_B);

    private static boolean inBurst(long t) {
        for (int i = 0; i < BURSTS_AT.length; i++) if (t >= BURSTS_AT[i] && t < BURSTS_AT[i] + BURST_MS[i]) return true;
        return false;
    }

    private static long nextBurstStart(long t) {
        for (long b : BURSTS_AT) if (b > t) return b;
        return RelayScenario.NEVER;
    }

    private static List<ScriptedEdge> edges() {
        List<ScriptedEdge> out = new ArrayList<>();
        for (int i = 0; i < BURSTS_AT.length; i++) {
            for (long t = BURSTS_AT[i]; t < BURSTS_AT[i] + BURST_MS[i]; t += FLAP_EVERY_MS) {
                out.add(new ScriptedEdge(t, FleetEdge.CONNECTIVITY_REGAINED));
            }
            // The network settles: one last edge.
            out.add(new ScriptedEdge(BURSTS_AT[i] + BURST_MS[i], FleetEdge.CONNECTIVITY_REGAINED));
        }
        return out;
    }

    /** Fails to resolve while the network flaps; otherwise holds until the next burst drops it. */
    private static RelayScenario flakyDns() {
        RelayInfo info = new RelayInfo(FLAKY_DNS, true);
        return new RelayScenario() {
            @Override public RelayInfo relay() { return info; }
            @Override public Attempt attempt(long startMs) {
                if (inBurst(startMs)) return new Attempt(50, false, 0, Outcome.DNS_FAILURE);
                long up = nextBurstStart(startMs) - startMs;
                return new Attempt(up, true, up, Outcome.TRANSIENT_DROP);
            }
        };
    }

    private static Result run(RelayFleetPolicy policy) {
        List<RelayScenario> scenario = List.of(
                RelayScenario.healthy(PRIMARY, true),
                new RelayScenario() {
                    final RelayInfo info = new RelayInfo(PROXY_502, true);
                    @Override public RelayInfo relay() { return info; }
                    @Override public Attempt attempt(long startMs) {
                        return new Attempt(400, false, 0, Outcome.CONNECT_REFUSED);
                    }
                },
                RelayScenario.dnsDead(DNS_DEAD_A, true),
                RelayScenario.dnsDead(DNS_DEAD_B, true),
                flakyDns());
        return new RelayFleetSimulator().run(policy, scenario, edges(), HORIZON);
    }

    /** The longest a settled network waited for the flaky relay to be retried. */
    private static long worstRecoveryMs(Result r) {
        List<Long> attempts = r.attemptTimes.get(r.urls.indexOf(FLAKY_DNS));
        long worst = 0;
        for (int i = 0; i < BURSTS_AT.length; i++) {
            long settled = BURSTS_AT[i] + BURST_MS[i];
            long next = Long.MAX_VALUE;
            for (long t : attempts) if (t >= settled && t < next) next = t;
            worst = Math.max(worst, next - settled);
        }
        return worst;
    }

    @Test
    public void benchmark() {
        Result everyEdge = run(new CircuitBreakerPolicy(0));
        Result spaced = run(new CircuitBreakerPolicy());

        StringBuilder out = new StringBuilder(String.format(
                "%n=== fleet on a flapping network: 11h, %d connectivity edges ===%n", edges().size()));
        out.append(String.format("  %-40s %14s %12s %9s %13s%n",
                "policy", "dead attempts", "flaky tries", "total", "recovery max"));
        for (Result r : List.of(everyEdge, spaced)) {
            out.append(String.format("  %-40s %14d %12d %9d %12ds%n",
                    r == everyEdge ? "re-arm on every edge (current)" : "re-arm spaced "
                            + CircuitBreakerPolicy.CONNECTIVITY_REARM_SPACING_MS / MIN + " min",
                    r.attemptsOnAny(DEAD), r.attemptsOn(FLAKY_DNS), r.totalAttempts(),
                    worstRecoveryMs(r) / SEC));
        }
        System.out.print(out);

        assertTrue("spacing should cut doomed handshakes by at least 3x",
                spaced.attemptsOnAny(DEAD) * 3 < everyEdge.attemptsOnAny(DEAD));
        assertTrue("a relay that recovers when the network settles is retried within the spacing",
                worstRecoveryMs(spaced) <= CircuitBreakerPolicy.CONNECTIVITY_REARM_SPACING_MS);
        assertTrue("the live relay keeps its socket", spaced.heldSocket(PRIMARY));
        assertTrue("the recovered relay holds a socket at the horizon", spaced.heldSocket(FLAKY_DNS));
    }
}
