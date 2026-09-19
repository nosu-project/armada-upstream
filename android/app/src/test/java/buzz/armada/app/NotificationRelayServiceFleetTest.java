package buzz.armada.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import buzz.armada.app.relayfleet.RelayFleetPolicy.Outcome;

import org.junit.Test;

import java.io.IOException;
import java.net.ConnectException;
import java.net.ProtocolException;
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

    // ── classifyFailure with the failed-upgrade HTTP status ─────────────────
    // okhttp reports a failed WebSocket upgrade — the relay answered the
    // handshake with an HTTP status instead of 101 — through onFailure's
    // Response argument, throwing a ProtocolException whose message carries the
    // code. A relay whose proxy is up in front of a dead backend returns a
    // persistent 5xx; with only the throwable it is indistinguishable from a
    // transient blip and is retried on the bounded backoff forever — the
    // battery drain in report b49c2110be73, where wss://relay.armada.buzz
    // returned '502 Bad Gateway' on every attempt and was never quarantined.
    // These pin the code-aware classification the breaker needs.

    @Test
    public void a502UpgradeResponseIsConnectRefused() {
        assertEquals(Outcome.CONNECT_REFUSED, NotificationRelayService.classifyFailure(
                new ProtocolException("Expected HTTP 101 response but was '502 Bad Gateway'"), 502));
    }

    @Test
    public void everyServerErrorUpgradeIsPermanent() {
        for (int code : new int[] {500, 502, 503, 504}) {
            assertEquals("HTTP " + code + " should be permanent", Outcome.CONNECT_REFUSED,
                    NotificationRelayService.classifyFailure(
                            new ProtocolException("Expected HTTP 101 response but was '" + code + "'"), code));
        }
    }

    @Test
    public void aClientErrorMisconfigurationUpgradeIsPermanent() {
        // 400/404 on the upgrade is a relay that will not speak WebSocket at
        // this URL; retrying fast changes nothing.
        assertEquals(Outcome.CONNECT_REFUSED, NotificationRelayService.classifyFailure(
                new ProtocolException("Expected HTTP 101 response but was '400 Bad Request'"), 400));
        assertEquals(Outcome.CONNECT_REFUSED, NotificationRelayService.classifyFailure(
                new ProtocolException("Expected HTTP 101 response but was '404 Not Found'"), 404));
    }

    @Test
    public void rateLimitedAndRequestTimeoutUpgradesStayTransient() {
        // 429 and 408 are the HTTP codes that mean "retry later"; they must not
        // count toward the breaker.
        assertEquals(Outcome.TRANSIENT_DROP, NotificationRelayService.classifyFailure(
                new ProtocolException("Expected HTTP 101 response but was '429 Too Many Requests'"), 429));
        assertEquals(Outcome.TRANSIENT_DROP, NotificationRelayService.classifyFailure(
                new ProtocolException("Expected HTTP 101 response but was '408 Request Timeout'"), 408));
    }

    @Test
    public void aNon101SuccessUpgradeStaysTransient() {
        // 2xx/3xx to a WS upgrade is bizarre but not a clear relay-down signal;
        // stay conservative and transient.
        assertEquals(Outcome.TRANSIENT_DROP, NotificationRelayService.classifyFailure(
                new ProtocolException("Expected HTTP 101 response but was '200 OK'"), 200));
    }

    @Test
    public void withoutAResponseCodeTheThrowableClassificationStands() {
        // code 0 == no HTTP response reached us (a real socket failure): the
        // throwable decides, exactly as the single-arg overload does.
        assertEquals(Outcome.DNS_FAILURE, NotificationRelayService.classifyFailure(
                new UnknownHostException("No address associated with hostname"), 0));
        assertEquals(Outcome.CONNECT_REFUSED, NotificationRelayService.classifyFailure(
                new ConnectException("refused"), 0));
        assertEquals(Outcome.TRANSIENT_DROP, NotificationRelayService.classifyFailure(
                new SocketTimeoutException("timeout"), 0));
    }

    @Test
    public void aServerErrorCodeOutweighsATransientThrowable() {
        // The HTTP status is the stronger signal: a 502 with a plain
        // ProtocolException (its normal shape) is permanent even though the
        // throwable alone would be transient.
        assertEquals(Outcome.CONNECT_REFUSED, NotificationRelayService.classifyFailure(
                new ProtocolException("unexpected"), 503));
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
