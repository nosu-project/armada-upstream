package buzz.armada.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/**
 * The thread a NIP-29 kind 9 replies into, which decides whether its
 * notification opens `/t/<root>`. Mirrors `nip29ThreadRootOf` in
 * `src/lib/nip29Threads.ts` (Buzz's marked-`e` thread shape).
 */
public class NotificationRelayServiceThreadRootTest {
    private static final String ROOT = "a".repeat(64);
    private static final String PARENT = "b".repeat(64);

    private static JSONObject event(String[]... tags) throws Exception {
        JSONArray array = new JSONArray();
        for (String[] tag : tags) {
            JSONArray t = new JSONArray();
            for (String part : tag) t.put(part);
            array.put(t);
        }
        return new JSONObject().put("kind", 9).put("tags", array);
    }

    @Test
    public void aDirectReplyIsRootedAtItsParent() throws Exception {
        assertEquals(ROOT, NotificationRelayService.markedThreadRoot(
                event(new String[] {"h", "g"}, new String[] {"e", ROOT, "", "reply"})));
    }

    @Test
    public void aNestedReplyIsRootedAtItsRootMarker() throws Exception {
        assertEquals(ROOT, NotificationRelayService.markedThreadRoot(event(
                new String[] {"e", ROOT, "", "root"}, new String[] {"e", PARENT, "", "reply"})));
    }

    @Test
    public void unmarkedOrRootOnlyTagsAreNotAThread() throws Exception {
        assertNull(NotificationRelayService.markedThreadRoot(event(new String[] {"e", ROOT})));
        assertNull(NotificationRelayService.markedThreadRoot(event(new String[] {"e", ROOT, "", "root"})));
        assertNull(NotificationRelayService.markedThreadRoot(event(new String[] {"q", ROOT, "", "pk"})));
    }
}
