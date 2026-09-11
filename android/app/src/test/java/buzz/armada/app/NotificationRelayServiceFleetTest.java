package buzz.armada.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import buzz.armada.app.relayfleet.RelayFleetPolicy.Outcome;

import org.junit.Test;

import java.io.IOException;
import java.net.ConnectException;
import java.net.SocketTimeoutException;
import java.net.UnknownHostException;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;

import javax.net.ssl.SSLHandshakeException;

/**
 * The adapter layer between real socket events and the fleet policy: the
 * three pure classifiers {@code NotificationRelayService} uses to turn what
 * okhttp and the relay said into a {@code RelayFleetPolicy} outcome, and the
 * fleet-curation gate. The policy itself is benchmarked in
 * {@code RelayFleetPolicyBenchmarkTest}; these pin the translation so a
 * misclassification cannot quarantine a relay that was merely unlucky.
 */
public class NotificationRelayServiceFleetTest {

    // ── classifyFailure ─────────────────────────────────────────────────────

    @Test
    public void unresolvableHostIsADnsFailure() {
        assertEquals(Outcome.DNS_FAILURE, NotificationRelayService.classifyFailure(
                new UnknownHostException("Unable to resolve host \"chat.soapbox.pub\"")));
    }

    @Test
    public void dnsFailureIsFoundThroughACauseChain() {
        // okhttp wraps the resolver failure; the classifier must look through.
        IOException wrapped = new IOException("connect failed",
                new UnknownHostException("No address associated with hostname"));
        assertEquals(Outcome.DNS_FAILURE, NotificationRelayService.classifyFailure(wrapped));
    }

    @Test
    public void refusedAndTlsFailuresAreConnectRefused() {
        assertEquals(Outcome.CONNECT_REFUSED,
                NotificationRelayService.classifyFailure(new ConnectException("refused")));
        assertEquals(Outcome.CONNECT_REFUSED,
                NotificationRelayService.classifyFailure(new SSLHandshakeException("bad cert")));
    }

    @Test
    public void anythingUnfamiliarStaysTransient() {
        // Conservative by design: a timeout, a protocol error or an unknown
        // IOException is retried on the bounded backoff, never quarantined.
        assertEquals(Outcome.TRANSIENT_DROP,
                NotificationRelayService.classifyFailure(new SocketTimeoutException("timeout")));
        assertEquals(Outcome.TRANSIENT_DROP,
                NotificationRelayService.classifyFailure(new IOException("Expected HTTP 101 but was 200")));
        assertEquals(Outcome.TRANSIENT_DROP,
                NotificationRelayService.classifyFailure(new RuntimeException("?")));
    }

    @Test
    public void aCauseCycleDoesNotHang() {
        IOException a = new IOException("a");
        IOException b = new IOException("b", a);
        a.initCause(b);
        assertEquals(Outcome.TRANSIENT_DROP, NotificationRelayService.classifyFailure(a));
    }

    // ── sessionAuthUnsatisfiable ────────────────────────────────────────────

    @Test
    public void everyStandingSubWalledAndNothingDeliveredIsUnsatisfiable() {
        assertTrue(NotificationRelayService.sessionAuthUnsatisfiable(
                Set.of("a2-1", "a7-1"), Set.of("a2-1", "a7-1"), false));
    }

    @Test
    public void oneAcceptedSubKeepsTheRelay() {
        // The whole-session rule: a relay with any live subscription is not
        // auth-unsatisfiable, so the policy may never quarantine it on auth.
        assertFalse(NotificationRelayService.sessionAuthUnsatisfiable(
                Set.of("a2-1", "a7-1"), Set.of("a2-1"), false));
    }

    @Test
    public void aDeliveredEventKeepsTheRelay() {
        assertFalse(NotificationRelayService.sessionAuthUnsatisfiable(
                Set.of("a2-1"), Set.of("a2-1"), true));
    }

    @Test
    public void aSessionThatSentNothingIsNotUnsatisfiable() {
        // No REQ was ever sent (e.g. the socket died before onOpen): there is
        // no auth wall to speak of, and the transport's outcome stands.
        assertFalse(NotificationRelayService.sessionAuthUnsatisfiable(Set.of(), Set.of(), false));
    }

    // ── relayDeliverable (fleet curation) ───────────────────────────────────

    private static final String URL = "wss://relay.example";
    private static final String ME = "1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f";

    private static boolean deliverable(Map<String, Set<String>> groups, Set<String> dm, boolean dmWatchable,
                                       Map<String, Set<String>> concord, Map<String, Set<String>> git,
                                       Set<String> self, String user) {
        return NotificationRelayService.relayDeliverable(URL, groups, dm, dmWatchable, concord, git, self, user);
    }

    @Test
    public void aReadPoolOnlyRelayIsNotDeliverable() {
        assertFalse(deliverable(new HashMap<>(), Set.of(), true, new HashMap<>(), new HashMap<>(), Set.of(), ME));
    }

    @Test
    public void aGroupHostIsDeliverable() {
        Map<String, Set<String>> groups = new HashMap<>();
        groups.put(URL, Set.of("general"));
        assertTrue(deliverable(groups, Set.of(), false, new HashMap<>(), new HashMap<>(), Set.of(), ME));
    }

    @Test
    public void aDmRelayIsDeliverableOnlyWhenDmsAreWatched() {
        assertTrue(deliverable(new HashMap<>(), Set.of(URL), true, new HashMap<>(), new HashMap<>(), Set.of(), ME));
        assertFalse(deliverable(new HashMap<>(), Set.of(URL), false, new HashMap<>(), new HashMap<>(), Set.of(), ME));
    }

    @Test
    public void aConcordCarrierAndAGitRelayAreDeliverable() {
        Map<String, Set<String>> concord = new HashMap<>();
        concord.put(URL, Set.of("deadbeef"));
        assertTrue(deliverable(new HashMap<>(), Set.of(), false, concord, new HashMap<>(), Set.of(), ME));
        Map<String, Set<String>> git = new HashMap<>();
        git.put(URL, Set.of("30617:pk:repo"));
        assertTrue(deliverable(new HashMap<>(), Set.of(), false, new HashMap<>(), git, Set.of(), ME));
    }

    @Test
    public void aSelfStateRelayNeedsAUser() {
        assertTrue(deliverable(new HashMap<>(), Set.of(), false, new HashMap<>(), new HashMap<>(), Set.of(URL), ME));
        assertFalse(deliverable(new HashMap<>(), Set.of(), false, new HashMap<>(), new HashMap<>(), Set.of(URL), null));
        assertFalse(deliverable(new HashMap<>(), Set.of(), false, new HashMap<>(), new HashMap<>(), Set.of(URL), ""));
    }

    @Test
    public void anEmptyGroupSetDoesNotCount() {
        Map<String, Set<String>> groups = new HashMap<>();
        groups.put(URL, Set.of());
        assertFalse(deliverable(groups, Set.of(), false, new HashMap<>(), new HashMap<>(), Set.of(), ME));
    }
}
