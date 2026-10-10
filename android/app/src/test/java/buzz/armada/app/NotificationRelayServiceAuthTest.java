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
    public void selfCoordinateIsTheKindForReplaceablesAndKindAuthorDForAddressables() throws Exception {
        JSONObject follow = new JSONObject().put("kind", 3).put("tags", new JSONArray());
        assertEquals("3", NotificationRelayService.selfCoordinateOf(follow, 3));
        JSONObject doc = new JSONObject().put("kind", 30078).put("pubkey", "me")
                .put("tags", new JSONArray().put(new JSONArray().put("d").put("armada/read-state")));
        assertEquals("30078:me:armada/read-state", NotificationRelayService.selfCoordinateOf(doc, 30078));
        // A derived settings key's document must not share a floor with the user's.
        JSONObject derived = new JSONObject().put("kind", 30078).put("pubkey", "derived")
                .put("tags", new JSONArray().put(new JSONArray().put("d").put("armada/read-state")));
        assertEquals("30078:derived:armada/read-state", NotificationRelayService.selfCoordinateOf(derived, 30078));
        JSONObject noD = new JSONObject().put("kind", 33302).put("pubkey", "me").put("tags", new JSONArray());
        assertEquals("33302:me:", NotificationRelayService.selfCoordinateOf(noD, 33302));
    }

    @Test
    public void selfDocsFingerprintIsOrderIndependentAndEmptyForNone() {
        assertEquals("", NotificationRelayService.selfDocsFingerprintOf(java.util.List.of()));
        assertEquals(
                NotificationRelayService.selfDocsFingerprintOf(java.util.List.of("a", "b")),
                NotificationRelayService.selfDocsFingerprintOf(java.util.List.of("b", "a")));
    }

    @Test
    public void selfTopicDocsAreKind30078WithAnArmadaTopic() throws Exception {
        JSONObject index = new JSONObject().put("kind", 30078).put("tags", new JSONArray()
                .put(new JSONArray().put("d").put("armada/dm-conversations/x/0"))
                .put(new JSONArray().put("t").put("armada-dm-conversations")));
        assertTrue(NotificationRelayService.isSelfTopicDoc(index, 30078));
        assertFalse(NotificationRelayService.isSelfTopicDoc(index, 30079));
        JSONObject settings = new JSONObject().put("kind", 30078).put("tags", new JSONArray()
                .put(new JSONArray().put("d").put("armada/read-state")));
        assertFalse(NotificationRelayService.isSelfTopicDoc(settings, 30078));
    }

    @Test
    public void communityListFragmentsAndTopicDocsCoalesce() throws Exception {
        JSONObject fragment = new JSONObject().put("kind", 33302)
                .put("tags", new JSONArray().put(new JSONArray().put("d").put("0")));
        assertTrue(NotificationRelayService.coalescesSelfDoc(fragment, 33302));
        JSONObject index = new JSONObject().put("kind", 30078).put("tags", new JSONArray()
                .put(new JSONArray().put("t").put("armada-dm-conversations")));
        assertTrue(NotificationRelayService.coalescesSelfDoc(index, 30078));
        JSONObject settings = new JSONObject().put("kind", 30078).put("tags", new JSONArray()
                .put(new JSONArray().put("d").put("armada/read-state")));
        assertFalse(NotificationRelayService.coalescesSelfDoc(settings, 30078));
        assertFalse(NotificationRelayService.coalescesSelfDoc(new JSONObject().put("tags", new JSONArray()), 10002));
    }

    @Test
    public void newerReplaceableBreaksEqualSecondsByLowerId() throws Exception {
        JSONObject a = new JSONObject().put("created_at", 100).put("id", "bb");
        assertTrue(SelfTopicWindow.isNewerReplaceable(a,
                new JSONObject().put("created_at", 101).put("id", "zz")));
        assertTrue(SelfTopicWindow.isNewerReplaceable(a,
                new JSONObject().put("created_at", 100).put("id", "aa")));
        assertFalse(SelfTopicWindow.isNewerReplaceable(a,
                new JSONObject().put("created_at", 100).put("id", "bb")));
        assertFalse(SelfTopicWindow.isNewerReplaceable(a,
                new JSONObject().put("created_at", 99).put("id", "00")));
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
