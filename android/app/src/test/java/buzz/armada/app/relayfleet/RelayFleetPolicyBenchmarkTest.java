package buzz.armada.app.relayfleet;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import buzz.armada.app.relayfleet.RelayFleetPolicy.FleetEdge;
import buzz.armada.app.relayfleet.RelayFleetSimulator.Result;
import buzz.armada.app.relayfleet.RelayFleetSimulator.ScriptedEdge;

import org.junit.Test;

import java.util.List;

/**
 * Benchmarks candidate background-fleet reconnection policies on a scenario
 * modeled on the battery-drain log (session e779aabe263b): a healthy delivering
 * relay, an auth-walled relay ({@code relay.damus.io}), two dead-DNS relays
 * ({@code chat.soapbox.pub}, {@code chat.shakespeare.diy}), and a flaky
 * read-pool relay. One connectivity flap at the half-hour mark, one virtual
 * hour.
 *
 * <p>Battery can't be measured in a unit test, but the properties that separate
 * these policies are deterministic and countable: total connect attempts (each
 * a DNS/TLS/radio wakeup), attempts against relays that can never succeed,
 * whether the fleet ever reaches a quiet steady state, and how many sockets it
 * holds. The assertions pin those; the printed table is the benchmark output.
 */
public class RelayFleetPolicyBenchmarkTest {

    private static final long MINUTE = 60_000L;
    private static final long HORIZON = 60 * MINUTE;
    private static final long FINAL_WINDOW = 10 * MINUTE;

    private static final String PRIMARY = "wss://relay.primary.example";
    private static final String DAMUS = "wss://relay.damus.io";
    private static final String SOAPBOX = "wss://chat.soapbox.pub";
    private static final String SHAKESPEARE = "wss://chat.shakespeare.diy";
    private static final String READPOOL = "wss://read.pool.example";

    /** The three relays that can never succeed under current conditions. */
    private static final List<String> DEAD_OR_WALLED = List.of(DAMUS, SOAPBOX, SHAKESPEARE);

    private static List<RelayScenario> scenario() {
        return List.of(
                RelayScenario.healthy(PRIMARY, true),
                RelayScenario.authWalled(DAMUS, true, 4 * MINUTE),
                RelayScenario.dnsDead(SOAPBOX, true),
                RelayScenario.dnsDead(SHAKESPEARE, true),
                RelayScenario.flaky(READPOOL, false, 15_000L));
    }

    private static List<ScriptedEdge> edges() {
        // A wifi/cellular flap 30 minutes in: connectivity returns.
        return List.of(new ScriptedEdge(30 * MINUTE, FleetEdge.CONNECTIVITY_REGAINED));
    }

    private static Result run(RelayFleetPolicy policy) {
        return new RelayFleetSimulator().run(policy, scenario(), edges(), HORIZON);
    }

    @Test
    public void benchmark() {
        Result baseline = run(new ExponentialBackoffPolicy());
        Result policy = run(new CircuitBreakerPolicy());

        printTable(baseline);
        printTable(policy);

        // ── Baseline is the problem being reproduced ─────────────────────────
        // It never goes quiet: it is still opening sockets in the final window.
        assertTrue("baseline should still be churning at the horizon",
                baseline.finalWindowAttempts(FINAL_WINDOW) > 0);
        // Its wasted work against the dead/walled relays is large.
        assertTrue("baseline should hammer the dead/walled relays",
                baseline.attemptsOnAny(DEAD_OR_WALLED) > 30);

        // ── The policy: dead/walled relays are quarantined ───────────────────
        // Quarantined after a few tries and only re-armed by the one
        // connectivity edge, so their attempt count collapses
        // (3 per relay per arming = 6 each with one flap).
        assertTrue("policy should quarantine dead/walled relays quickly",
                policy.attemptsOnAny(DEAD_OR_WALLED) <= 20);
        assertTrue("policy should cut dead/walled attempts by well over 3x",
                policy.attemptsOnAny(DEAD_OR_WALLED) * 3 < baseline.attemptsOnAny(DEAD_OR_WALLED));
        // The auth-walled relay's fast reconnect churn is bounded, not endless.
        assertTrue("policy should bound the auth-walled churn",
                policy.attemptsOn(DAMUS) <= 8);

        // ── Curation sheds the read-pool socket; the fleet goes quiet ────────
        // The flaky, non-deliverable relay never gets a background socket, so
        // after the flap nothing is left to retry.
        assertEquals("policy should never connect the read-pool relay",
                0, policy.attemptsOn(READPOOL));
        assertEquals("policy fleet should be silent in the final window",
                0, policy.finalWindowAttempts(FINAL_WINDOW));
        assertTrue("policy should make far fewer attempts overall",
                policy.totalAttempts() * 4 < baseline.totalAttempts());

        // ── A live relay is never sacrificed ─────────────────────────────────
        for (Result r : List.of(baseline, policy)) {
            assertTrue(r.policyName + " must keep the primary relay's socket",
                    r.heldSocket(PRIMARY));
        }
    }

    private static void printTable(Result r) {
        StringBuilder sb = new StringBuilder();
        sb.append("\n=== ").append(r.policyName).append(" ===\n");
        sb.append(String.format("  %-32s %8s  %s%n", "relay", "attempts", "state@horizon"));
        for (int i = 0; i < r.urls.size(); i++) {
            String stateStr = r.heldSocketAtHorizon[i] ? "socket held"
                    : r.quarantinedAtHorizon[i] ? "quarantined"
                    : "idle/backoff";
            if (!r.deliverable[i]) stateStr += " (non-deliverable)";
            sb.append(String.format("  %-32s %8d  %s%n",
                    r.urls.get(i), r.attemptTimes.get(i).size(), stateStr));
        }
        sb.append(String.format("  %-32s %8d%n", "TOTAL attempts", r.totalAttempts()));
        sb.append(String.format("  %-32s %8d%n",
                "attempts in final 10 min", r.finalWindowAttempts(FINAL_WINDOW)));
        sb.append(String.format("  %-32s %8d%n", "sockets held", r.socketsHeld()));
        sb.append(String.format("  %-32s %8.1f min%n",
                "last attempt at", r.lastAttemptMs() / 60000.0));
        System.out.print(sb);
    }
}
