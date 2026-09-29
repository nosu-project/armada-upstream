package buzz.armada.app;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/**
 * {@code eventFrameHead}: reading a frame's subscription and event ids without
 * parsing it, so an event the service already handled costs a string scan
 * instead of a JSON parse. It must never return the wrong id: a wrong match
 * would drop an unseen event.
 */
public class NotificationRelayServiceSeenFrameTest {

    private static final String ID = "a".repeat(64);

    private static String frame(String sub, JSONObject event) {
        return new JSONArray().put("EVENT").put(sub).put(event).toString();
    }

    private static JSONObject event(String content) throws Exception {
        return new JSONObject()
                .put("id", ID)
                .put("pubkey", "b".repeat(64))
                .put("created_at", 1)
                .put("kind", 33302)
                .put("tags", new JSONArray().put(new JSONArray().put("d").put("0")))
                .put("content", content)
                .put("sig", "c".repeat(128));
    }

    @Test
    public void readsTheSubAndEventId() throws Exception {
        assertArrayEquals(new String[] {"as-18c", ID},
                NotificationRelayService.eventFrameHead(frame("as-18c", event("x"))));
    }

    @Test
    public void anIdSpelledInsideContentIsNeverTaken() throws Exception {
        // The content comes first here and carries the exact sequence, quoted:
        // escaping means the frame can only hold it as \"id\":\".
        String forged = "\"id\":\"" + "d".repeat(64) + "\"";
        String text = "[\"EVENT\",\"as-1\",{\"content\":" + JSONObject.quote(forged) + ",\"id\":\"" + ID + "\"}]";
        assertArrayEquals(new String[] {"as-1", ID}, NotificationRelayService.eventFrameHead(text));
    }

    @Test
    public void anythingElseIsLeftToTheParser() {
        assertNull(NotificationRelayService.eventFrameHead("[\"EOSE\",\"as-1\"]"));
        assertNull(NotificationRelayService.eventFrameHead("[\"EVENT\",\"as-1\",{\"id\": \"" + ID + "\"}]"));
        assertNull(NotificationRelayService.eventFrameHead("[\"EVENT\",\"as-1\",{\"id\":\"" + ID.substring(1) + "\"}]"));
        assertNull(NotificationRelayService.eventFrameHead("[\"EVENT\",\"as-1\",{\"id\":\"" + ID));
        assertNull(NotificationRelayService.eventFrameHead("[\"EVENT\",\"as-1\",{\"id\":\"" + "Z".repeat(64) + "\"}]"));
    }

    /** Parse vs scan on a community-list-sized frame (38 KB), the case that dominated. */
    @Test
    public void benchmark() throws Exception {
        String text = frame("as-18c", event("A".repeat(38_000)));
        int n = 400;
        for (int i = 0; i < 50; i++) { new JSONArray(text); NotificationRelayService.eventFrameHead(text); }
        long t0 = System.nanoTime();
        for (int i = 0; i < n; i++) new JSONArray(text);
        long parse = System.nanoTime() - t0;
        t0 = System.nanoTime();
        for (int i = 0; i < n; i++) NotificationRelayService.eventFrameHead(text);
        long scan = System.nanoTime() - t0;
        System.out.printf("%n=== seen-frame drop, 38 KB frame: parse %.3f ms, scan %.4f ms (%.0fx) ===%n",
                parse / 1e6 / n, scan / 1e6 / n, (double) parse / scan);
        assertTrue("the scan must be far cheaper than the parse", scan * 10 < parse);
    }
}
