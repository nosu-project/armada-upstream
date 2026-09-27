package buzz.armada.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.function.Predicate;

/** Mirrors the stageNewestPerCoordinate cases in selfSyncKinds.test.ts. */
public class SelfTopicWindowTest {
    private final List<String> verified = new ArrayList<>();
    /** Fails exactly the ids starting with "forged", and records every call. */
    private final Predicate<JSONObject> verifier = e -> {
        verified.add(e.optString("id"));
        return !e.optString("id").startsWith("forged");
    };

    private static JSONObject ev(String id, long createdAt) throws Exception {
        return new JSONObject().put("id", id).put("created_at", createdAt);
    }

    @Test
    public void keepsTheNewestVersionWithoutVerifyingTheFirst() throws Exception {
        SelfTopicWindow w = new SelfTopicWindow(8, verifier);
        assertEquals(SelfTopicWindow.Outcome.STAGED, w.stage("a", ev("a1", 100), "r"));
        assertTrue(verified.isEmpty());
        assertEquals(SelfTopicWindow.Outcome.SUPERSEDED, w.stage("a", ev("a0", 99), "r"));
        assertEquals(SelfTopicWindow.Outcome.STAGED, w.stage("a", ev("a2", 101), "r"));
        assertEquals("a2", w.pendingEvent("a").optString("id"));
    }

    @Test
    public void aForgedFarFutureVersionCannotHoldOffTheRealOne() throws Exception {
        // Without a check the real edition loses to the forgery on timestamp
        // and is dropped; the forgery then fails verification at the flush,
        // and nothing is filed at all.
        SelfTopicWindow w = new SelfTopicWindow(8, verifier);
        w.stage("a", ev("forged", 9_999_999_999L), "r");
        assertEquals(SelfTopicWindow.Outcome.STAGED, w.stage("a", ev("real", 100), "r"));
        assertEquals("real", w.pendingEvent("a").optString("id"));
    }

    @Test
    public void aForgedNewerVersionCannotDisplaceTheRealOne() throws Exception {
        SelfTopicWindow w = new SelfTopicWindow(8, verifier);
        w.stage("a", ev("real", 100), "r");
        assertEquals(SelfTopicWindow.Outcome.FORGED, w.stage("a", ev("forged", 101), "r"));
        assertEquals("real", w.pendingEvent("a").optString("id"));
    }

    @Test
    public void forgedPiecesHoldingTheCapAreEvictedForARealOne() throws Exception {
        SelfTopicWindow w = new SelfTopicWindow(2, verifier);
        w.stage("x", ev("forged-x", 1), "r");
        w.stage("y", ev("forged-y", 1), "r");
        assertEquals(SelfTopicWindow.Outcome.STAGED, w.stage("a", ev("real", 1), "r"));
        assertEquals(1, w.size());
    }

    @Test
    public void realPiecesHoldingTheCapStillRefuseANewOne() throws Exception {
        SelfTopicWindow w = new SelfTopicWindow(2, verifier);
        w.stage("x", ev("x", 1), "r");
        w.stage("y", ev("y", 1), "r");
        assertEquals(SelfTopicWindow.Outcome.OVERFLOW, w.stage("z", ev("z", 1), "r"));
        // A pending version verified by the sweep is not verified again at the flush.
        for (SelfTopicWindow.Pending p : w.drain()) assertTrue(p.verified);
        assertTrue(w.isEmpty());
    }
}
