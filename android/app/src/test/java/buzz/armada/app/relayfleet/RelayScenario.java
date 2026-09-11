package buzz.armada.app.relayfleet;

import buzz.armada.app.relayfleet.RelayFleetPolicy.Outcome;
import buzz.armada.app.relayfleet.RelayFleetPolicy.RelayInfo;

/**
 * The intrinsic behavior of one relay in a benchmark scenario: given the time
 * a connection attempt begins, how does that attempt resolve? This is the
 * "ground truth" the policy cannot see — the simulator consults it to produce
 * the {@link RelayFleetPolicy.ConnectionResult}s the policy reacts to.
 *
 * <p>Behaviors are deliberately simple and deterministic so a run is
 * reproducible. {@link #NEVER} marks an attempt that opens and is never
 * expected to end within any horizon (a healthy, held socket).
 */
public interface RelayScenario {

    /** An attempt that opens and never ends on its own (healthy, held socket). */
    long NEVER = Long.MAX_VALUE / 4;

    RelayInfo relay();

    /** How the attempt that begins at {@code startMs} resolves. */
    Attempt attempt(long startMs);

    /**
     * @param endsAfterMs how long after the attempt starts the connection ends
     *                    ({@link #NEVER} if it never does)
     * @param opened      whether a socket opened at all (false for DNS/refused)
     * @param uptimeMs    how long the socket stayed up (0 if it never opened)
     * @param outcome     why the attempt stopped being productive
     */
    record Attempt(long endsAfterMs, boolean opened, long uptimeMs, Outcome outcome) {}

    // ── Factories ────────────────────────────────────────────────────────────

    /** Connects and stays connected; one attempt, then a held socket forever. */
    static RelayScenario healthy(String url, boolean deliverable) {
        RelayInfo info = new RelayInfo(url, deliverable);
        return new RelayScenario() {
            @Override public RelayInfo relay() { return info; }
            @Override public Attempt attempt(long startMs) {
                return new Attempt(NEVER, true, NEVER, Outcome.TRANSIENT_DROP);
            }
        };
    }

    /** Never resolves ("No address associated with hostname"). */
    static RelayScenario dnsDead(String url, boolean deliverable) {
        RelayInfo info = new RelayInfo(url, deliverable);
        return new RelayScenario() {
            @Override public RelayInfo relay() { return info; }
            @Override public Attempt attempt(long startMs) {
                return new Attempt(50, false, 0, Outcome.DNS_FAILURE);
            }
        };
    }

    /**
     * Opens, but its standing subscription is {@code auth-required} and cannot
     * be satisfied in the background; the relay closes the unproductive socket
     * after {@code holdMs}, and the service reconnects and re-REQs into the
     * same wall. Models the {@code relay.damus.io a2-} churn in the log.
     */
    static RelayScenario authWalled(String url, boolean deliverable, long holdMs) {
        RelayInfo info = new RelayInfo(url, deliverable);
        return new RelayScenario() {
            @Override public RelayInfo relay() { return info; }
            @Override public Attempt attempt(long startMs) {
                return new Attempt(holdMs, true, holdMs, Outcome.AUTH_UNSATISFIABLE);
            }
        };
    }

    /** A live but unreliable relay: opens, holds {@code holdMs}, drops. */
    static RelayScenario flaky(String url, boolean deliverable, long holdMs) {
        RelayInfo info = new RelayInfo(url, deliverable);
        return new RelayScenario() {
            @Override public RelayInfo relay() { return info; }
            @Override public Attempt attempt(long startMs) {
                return new Attempt(holdMs, true, holdMs, Outcome.TRANSIENT_DROP);
            }
        };
    }

    /** Behaves like {@code before} until {@code switchMs}, then like {@code after}. */
    static RelayScenario recoversAt(long switchMs, RelayScenario before, RelayScenario after) {
        return new RelayScenario() {
            @Override public RelayInfo relay() { return before.relay(); }
            @Override public Attempt attempt(long startMs) {
                return (startMs < switchMs ? before : after).attempt(startMs);
            }
        };
    }
}
