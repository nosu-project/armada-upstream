package buzz.armada.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class NotificationRelayServiceAuthTest {
    @Test
    public void recognizesTheBareMachineReadablePrefix() {
        assertTrue(NotificationRelayService.isAuthRequired("auth-required: sign in"));
    }

    @Test
    public void recognizesItWrappedInAnErrorPrefix() {
        // relay.damus.io / strfry-family: without this the wall read as an
        // ordinary close and was retried on a backoff forever.
        assertTrue(NotificationRelayService.isAuthRequired(
                "ERROR: auth-required: requested filter requires authentication"));
        assertTrue(NotificationRelayService.isAuthRequired("error:auth-required: x"));
    }

    @Test
    public void doesNotMistakeOtherReasons() {
        assertFalse(NotificationRelayService.isAuthRequired("rate-limited: slow down"));
        assertFalse(NotificationRelayService.isAuthRequired("ERROR: bad req: auth-required: not a prefix"));
        assertFalse(NotificationRelayService.isAuthRequired(""));
        assertFalse(NotificationRelayService.isAuthRequired(null));
    }

    @Test
    public void authPairNamesTheSignerAndTheChallenge() throws Exception {
        JSONObject auth = new JSONObject()
                .put("kind", 22242)
                .put("pubkey", "ab")
                .put("tags", new JSONArray()
                        .put(new JSONArray().put("relay").put("wss://r"))
                        .put(new JSONArray().put("challenge").put("xyz")));
        assertEquals("ab|xyz", NotificationRelayService.authPairOf(auth));
    }

    @Test
    public void authPairIsNullWithoutAChallenge() throws Exception {
        JSONObject auth = new JSONObject().put("pubkey", "ab").put("tags", new JSONArray());
        assertNull(NotificationRelayService.authPairOf(auth));
    }

    @Test
    public void selfCoordinateIsTheKindForReplaceablesAndKindPlusDForAddressables() throws Exception {
        JSONObject follow = new JSONObject().put("kind", 3).put("tags", new JSONArray());
        assertEquals("3", NotificationRelayService.selfCoordinateOf(follow, 3));
        JSONObject doc = new JSONObject().put("kind", 30078)
                .put("tags", new JSONArray().put(new JSONArray().put("d").put("armada/read-state")));
        assertEquals("30078:armada/read-state", NotificationRelayService.selfCoordinateOf(doc, 30078));
        JSONObject noD = new JSONObject().put("kind", 33302).put("tags", new JSONArray());
        assertEquals("33302:", NotificationRelayService.selfCoordinateOf(noD, 33302));
    }

    @Test
    public void filtersSignatureIgnoresSinceAndKeyOrder() throws Exception {
        JSONObject a = new JSONObject().put("kinds", new JSONArray().put(1059)).put("#p", new JSONArray().put("x")).put("since", 100);
        JSONObject b = new JSONObject().put("since", 200).put("#p", new JSONArray().put("x")).put("kinds", new JSONArray().put(1059));
        assertEquals(NotificationRelayService.filtersWithoutSince(a), NotificationRelayService.filtersWithoutSince(b));
        JSONObject c = new JSONObject().put("kinds", new JSONArray().put(1059)).put("#p", new JSONArray().put("y"));
        assertFalse(NotificationRelayService.filtersWithoutSince(a).equals(NotificationRelayService.filtersWithoutSince(c)));
    }
}
