package buzz.armada.app.relayfleet;

/**
 * A pure, transport-free decision layer for the background relay fleet —
 * extracted so competing reconnection strategies can be benchmarked in
 * isolation (see {@code RelayFleetSimulator} in the test source set) rather
 * than measured only on a phone's battery graph.
 *
 * <p>The live service ({@code NotificationRelayService}) entangles the
 * reconnect decision inside {@code RelayConnection}: {@code scheduleReconnect()}
 * reads the wall clock, mutates {@code backoffMs}, and calls
 * {@code handler.postDelayed(...)} against a real socket. That cannot be unit
 * tested, which is part of why the "never reaches a quiet state" battery
 * behavior was never caught. This interface is the seam: every decision is a
 * pure function of an injected {@code nowMs} and a per-relay opaque state
 * object, so a policy can be driven by a deterministic event trace with no
 * {@code Handler}, no {@code Looper}, and no network.
 *
 * <p>A candidate solution is just an implementation of this interface; the
 * simulator replays one relay-behavior trace through each and reports the
 * cost metrics (connect attempts, steady-state churn, whether the fleet ever
 * goes quiet, sockets held) that stand in for battery.
 */
public interface RelayFleetPolicy {

    /**
     * Why a connection attempt stopped being productive. The split that
     * matters is permanent-given-current-conditions vs transient:
     *
     * <ul>
     *   <li>{@link #DNS_FAILURE} — the host did not resolve ("No address
     *       associated with hostname"). Retrying changes nothing until the
     *       relay set or the network changes.</li>
     *   <li>{@link #CONNECT_REFUSED} — TCP/TLS refused or reset. Same shape as
     *       DNS for our purposes: the relay is simply not reachable now.</li>
     *   <li>{@link #AUTH_UNSATISFIABLE} — the socket opened, but EVERY standing
     *       subscription on this relay was closed {@code auth-required} and no
     *       signer available to this background process can satisfy any of
     *       them (NIP-46 bunker asleep, stream key not authorized here). The
     *       transport must only report this when the whole session delivered
     *       nothing; a relay with even one live subscription reports
     *       {@link #TRANSIENT_DROP} when it drops, and is kept. That is what
     *       makes quarantining on this outcome lose nothing.</li>
     *   <li>{@link #TRANSIENT_DROP} — opened then dropped (ping timeout, relay
     *       restart, a real network blip). The one outcome worth retrying on a
     *       growing-but-bounded backoff.</li>
     * </ul>
     */
    enum Outcome { DNS_FAILURE, CONNECT_REFUSED, AUTH_UNSATISFIABLE, TRANSIENT_DROP }

    /**
     * A relay the background fleet could connect to.
     *
     * @param url         the (already normalized) relay websocket URL
     * @param deliverable whether this relay can actually deliver a
     *                    notification — it hosts one of the user's groups, is
     *                    a DM-inbox relay, or carries a Concord stream. A relay
     *                    that is only in the general read pool is not
     *                    deliverable, and a fleet-curation policy need not hold
     *                    a 24/7 socket to it.
     */
    record RelayInfo(String url, boolean deliverable) {}

    /** What a policy learns when one connection attempt ends. */
    record ConnectionResult(boolean opened, long uptimeMs, Outcome outcome) {}

    /** The policy's instruction to the transport after a connection ends. */
    sealed interface FleetDecision {
        /** Try again after {@code delayMs}. */
        record RetryAfter(long delayMs) implements FleetDecision {}
        /** Stop retrying; hold no socket until an {@link FleetEdge} re-arms it. */
        record Quarantine() implements FleetDecision {}
    }

    /** An external change that may un-stick a quarantined relay. */
    enum FleetEdge { CONNECTIVITY_REGAINED, CONFIG_CHANGED, APP_FOREGROUNDED }

    /** A human-readable name for benchmark output. */
    String name();

    /** Fresh opaque per-relay state; the policy is the only thing that reads it. */
    Object newRelayState();

    /** Whether this relay should currently hold (or open) a socket at all. */
    boolean shouldConnect(Object state, RelayInfo relay, long nowMs);

    /** A connection attempt just ended; decide what happens next for it. */
    FleetDecision onConnectionEnded(Object state, RelayInfo relay, ConnectionResult result, long nowMs);

    /** An external edge fired; the policy may clear a quarantine / reset backoff. */
    void onEdge(Object state, RelayInfo relay, FleetEdge edge, long nowMs);
}
