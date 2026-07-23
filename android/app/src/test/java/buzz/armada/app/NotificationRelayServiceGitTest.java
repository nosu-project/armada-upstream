package buzz.armada.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.lang.reflect.Method;
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
}
