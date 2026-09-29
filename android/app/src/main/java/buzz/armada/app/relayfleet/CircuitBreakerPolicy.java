package buzz.armada.app.relayfleet;

import buzz.armada.app.relayfleet.RelayFleetPolicy.ConnectionResult;
import buzz.armada.app.relayfleet.RelayFleetPolicy.FleetDecision;
import buzz.armada.app.relayfleet.RelayFleetPolicy.FleetEdge;
import buzz.armada.app.relayfleet.RelayFleetPolicy.Outcome;
import buzz.armada.app.relayfleet.RelayFleetPolicy.RelayInfo;

/**
 * The recommended background-fleet policy. It fixes the two properties of the
 * current model that make its cost scale with relay count and ignore relay
 * health, and it does so without ever sacrificing a relay that delivers:
 *
 * <ol>
 *   <li><b>Fleet curation.</b> Only a relay that can deliver a notification —
 *       a group host, a DM-inbox relay, a Concord carrier — earns a 24/7
 *       background socket. A read-pool-only relay never does. The fleet's cost
 *       stops scaling with the full read union.</li>
 *   <li><b>Circuit breaker.</b> A failure is classified permanent-given-
 *       conditions (DNS did not resolve, connection refused, or every
 *       subscription is {@code auth-required} and unsatisfiable in the
 *       background) or transient (a drop after a working session). After
 *       {@link #PERMANENT_FAILURE_THRESHOLD} consecutive permanent failures the
 *       relay is <b>quarantined</b> — no automatic retry — and only an external
 *       {@link FleetEdge} (connectivity regained, config changed, app
 *       foregrounded) re-arms it. Transient drops keep a bounded exponential
 *       backoff, so a flaky-but-live relay is never abandoned. This is what
 *       lets the fleet reach a terminal quiet state instead of retrying a dead
 *       relay every five minutes forever.</li>
 * </ol>
 *
 * <p>Quarantine loses nothing by construction: DNS/refused means the relay is
 * unreachable, and {@link Outcome#AUTH_UNSATISFIABLE} is only reported when a
 * whole session delivered nothing (see its contract). A relay with any live
 * subscription reports {@link Outcome#TRANSIENT_DROP} and is kept.
 */
public final class CircuitBreakerPolicy implements RelayFleetPolicy {

    static final long INITIAL_BACKOFF_MS = 1_000L;
    static final long MAX_BACKOFF_MS = 5 * 60 * 1_000L;
    static final long STABLE_CONNECTION_MS = 60_000L;
    static final int PERMANENT_FAILURE_THRESHOLD = 3;
    /**
     * Minimum spacing between connectivity-driven re-arms of a quarantined
     * relay. A flapping network fires an edge every few seconds, and each
     * re-arm is another round of doomed handshakes; an edge inside the spacing
     * defers the re-arm to its end rather than dropping it, so the network
     * settling still earns the relay a fresh look within the spacing.
     */
    public static final long CONNECTIVITY_REARM_SPACING_MS = 2 * 60 * 1_000L;

    static final class State {
        long backoffMs = INITIAL_BACKOFF_MS;
        int consecutivePermanent = 0;
        boolean quarantined = false;
        /** Earliest time a connectivity edge may re-arm this relay again. */
        long nextRearmAt = 0;
        boolean rearmPending = false;
    }

    private final long rearmSpacingMs;

    public CircuitBreakerPolicy() {
        this(CONNECTIVITY_REARM_SPACING_MS);
    }

    /** {@code rearmSpacingMs} 0 re-arms on every connectivity edge. */
    public CircuitBreakerPolicy(long rearmSpacingMs) {
        this.rearmSpacingMs = rearmSpacingMs;
    }

    private static boolean isPermanent(Outcome outcome) {
        return outcome == Outcome.DNS_FAILURE
                || outcome == Outcome.CONNECT_REFUSED
                || outcome == Outcome.AUTH_UNSATISFIABLE;
    }

    @Override public String name() { return "circuit-breaker + fleet-curation"; }

    @Override public Object newRelayState() { return new State(); }

    @Override
    public boolean shouldConnect(Object state, RelayInfo relay, long nowMs) {
        if (!relay.deliverable()) return false;
        State st = (State) state;
        if (st.quarantined && st.rearmPending && nowMs >= st.nextRearmAt) rearm(st, nowMs);
        return !st.quarantined;
    }

    private void rearm(State st, long nowMs) {
        st.quarantined = false;
        st.rearmPending = false;
        st.backoffMs = INITIAL_BACKOFF_MS;
        st.consecutivePermanent = 0;
        st.nextRearmAt = nowMs + rearmSpacingMs;
    }

    @Override
    public FleetDecision onConnectionEnded(Object state, RelayInfo relay, ConnectionResult result, long nowMs) {
        State st = (State) state;
        if (!isPermanent(result.outcome())) {
            // Transient: bounded backoff, and a stable session clears the
            // permanent-failure tally too (the relay proved it can work).
            if (result.opened() && result.uptimeMs() >= STABLE_CONNECTION_MS) {
                st.backoffMs = INITIAL_BACKOFF_MS;
                st.consecutivePermanent = 0;
            }
            long delay = st.backoffMs;
            st.backoffMs = Math.min(st.backoffMs * 2, MAX_BACKOFF_MS);
            return new FleetDecision.RetryAfter(delay);
        }
        // Permanent-given-conditions. Counts toward the breaker regardless of
        // how long the socket stayed up — an auth-walled socket that lived four
        // minutes still delivered nothing.
        st.consecutivePermanent++;
        if (st.consecutivePermanent >= PERMANENT_FAILURE_THRESHOLD) {
            st.quarantined = true;
            return new FleetDecision.Quarantine();
        }
        long delay = st.backoffMs;
        st.backoffMs = Math.min(st.backoffMs * 2, MAX_BACKOFF_MS);
        return new FleetDecision.RetryAfter(delay);
    }

    @Override
    public long onEdge(Object state, RelayInfo relay, FleetEdge edge, long nowMs) {
        // Any edge that could change the outcome re-arms: a quarantined relay
        // is worth one fresh look when the network returns, the relay set
        // changes, or the app comes forward (which can wake a signer). Only
        // connectivity is spaced; the other edges are rare and user-driven.
        State st = (State) state;
        if (st.quarantined && edge == FleetEdge.CONNECTIVITY_REGAINED && nowMs < st.nextRearmAt) {
            st.rearmPending = true;
            return st.nextRearmAt - nowMs;
        }
        rearm(st, nowMs);
        return 0;
    }
}
