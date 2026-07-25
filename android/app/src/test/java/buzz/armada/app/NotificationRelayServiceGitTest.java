package buzz.armada.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.lang.reflect.Method;
import org.json.JSONObject;
import org.junit.Test;

/**
 * Pure validation guards used by the persistent Git plane. Integration coverage
 * for filters, buffering and route hydration lives in the TypeScript wire tests;
 * these tests deliberately avoid an Android runtime so they run on CI hosts.
 */
public class NotificationRelayServiceGitTest {
    private static boolean call(String name, String value) throws Exception {
        Method method = NotificationRelayService.class.getDeclaredMethod(name, String.class);
        method.setAccessible(true);
        return (Boolean) method.invoke(null, value);
    }

    @Test public void acceptsOnlyCanonicalPublicCoordinates() throws Exception {
        String pk = "a".repeat(64);
        assertTrue(call("validRepositoryAddress", "30617:" + pk + ":armada"));
        assertFalse(call("validRepositoryAddress", "30617:" + pk.toUpperCase() + ":armada"));
        assertFalse(call("validRepositoryAddress", "30618:" + pk + ":armada"));
    }

    @Test public void rejectsMalformedTicketAndAuthorIds() throws Exception {
        assertTrue(call("validHex", "b".repeat(64)));
        assertFalse(call("validHex", "B".repeat(64)));
        assertFalse(call("validHex", "b".repeat(63)));
    }

    private static String rootTag(String tagsJson, String name) throws Exception {
        Method method = NotificationRelayService.class.getDeclaredMethod("rootTag", JSONObject.class, String.class);
        method.setAccessible(true);
        return (String) method.invoke(null, new JSONObject("{\"tags\":" + tagsJson + "}"), name);
    }

    @Test public void readsNip22RootsWhoseFourthValueIsTheRootAuthor() throws Exception {
        String ticket = "b".repeat(64), author = "c".repeat(64);
        assertEquals(ticket, rootTag("[[\"E\",\"" + ticket + "\",\"wss://relay.example\",\"" + author + "\"]]", "E"));
        assertEquals(ticket, rootTag("[[\"E\",\"" + ticket + "\"]]", "E"));
        // Ambiguous roots are refused rather than guessed at.
        assertNull(rootTag("[[\"E\",\"" + ticket + "\"],[\"E\",\"" + author + "\"]]", "E"));
    }

    @Test public void stillRequiresTheRootMarkerOnLowercaseStatusTags() throws Exception {
        String ticket = "b".repeat(64);
        assertEquals(ticket, rootTag("[[\"e\",\"" + ticket + "\",\"\",\"root\"]]", "e"));
        assertNull(rootTag("[[\"e\",\"" + ticket + "\",\"\",\"reply\"]]", "e"));
    }
}
