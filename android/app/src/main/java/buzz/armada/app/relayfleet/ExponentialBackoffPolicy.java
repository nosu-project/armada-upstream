package buzz.armada.app.relayfleet;

import buzz.armada.app.relayfleet.RelayFleetPolicy.ConnectionResult;
import buzz.armada.app.relayfleet.RelayFleetPolicy.FleetDecision;
import buzz.armada.app.relayfleet.RelayFleetPolicy.FleetEdge;
import buzz.armada.app.relayfleet.RelayFleetPolicy.RelayInfo;

/**
 * The baseline: a faithful port of {@code NotificationRelayService}'s current
 * {@code RelayConnection.scheduleReconnect()} (and its immediate-reconnect on
 * connectivity return). It exists so the benchmark has a green record of what
 * the app does today — including the wart that it never terminates: every
 * failure mode converges to "retry, forever," capped at five minutes.
 *
 * <p>Mirrors the service constants exactly (lines 242-249): 1s initial, 5min
 * cap, and a backoff reset only after a connection survived
 * {@code STABLE_CONNECTION_MS}. Connects to the entire relay union
 * ({@code shouldConnect} is unconditionally true), so its cost scales with
 * relay count regardless of relay health.
 */
public final class ExponentialBackoffPolicy implements RelayFleetPolicy {

    static final long INITIAL_BACKOFF_MS = 1_000L;
    static final long MAX_BACKOFF_MS = 5 * 60 * 1_000L;
    static final long STABLE_CONNECTION_MS = 60_000L;

    static final class State {
        long backoffMs = INITIAL_BACKOFF_MS;
    }

    @Override public String name() { return "exponential-backoff (current behavior)"; }

    @Override public Object newRelayState() { return new State(); }

    @Override public boolean shouldConnect(Object state, RelayInfo relay, long nowMs) {
        return true; // the whole union gets a 24/7 socket
    }

    @Override
    public FleetDecision onConnectionEnded(Object state, RelayInfo relay, ConnectionResult result, long nowMs) {
        State st = (State) state;
        // Only a connection that stayed up long enough earns a reset; instant
        // drops keep doubling toward the cap. Note this treats an
        // AUTH_UNSATISFIABLE socket that stayed up as "stable", so it resets to
        // a 1s reconnect — which is exactly the fast auth-walled churn.
        if (result.opened() && result.uptimeMs() >= STABLE_CONNECTION_MS) {
            st.backoffMs = INITIAL_BACKOFF_MS;
        }
        long delay = st.backoffMs;
        st.backoffMs = Math.min(st.backoffMs * 2, MAX_BACKOFF_MS);
        return new FleetDecision.RetryAfter(delay);
    }

    @Override
    public void onEdge(Object state, RelayInfo relay, FleetEdge edge, long nowMs) {
        // "Network-aware: reconnects immediately when connectivity returns."
        if (edge == FleetEdge.CONNECTIVITY_REGAINED) {
            ((State) state).backoffMs = INITIAL_BACKOFF_MS;
        }
    }
}
