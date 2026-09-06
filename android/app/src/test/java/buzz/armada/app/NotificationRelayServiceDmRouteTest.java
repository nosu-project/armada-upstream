package buzz.armada.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;

import java.lang.reflect.Method;

import org.junit.Test;

/**
 * The `/dm/<peers>` deep link a DM notification's tap opens.
 *
 * A route string is an IDENTITY in this app, not just a destination: the share
 * stash is keyed by the destination's path, a conversation shortcut is
 * published under one (see {@code shortcutIdFor}), and the sent-rooms ledger
 * records one per room. So the three ports of this route builder — the web
 * client's {@code chatRoute} (`src/lib/routes.ts`), this service, and
 * {@code PushProcessor.dmPath} on iOS — have to produce the same string for
 * the same conversation, and that string spells a pubkey as an NPUB.
 *
 * The vector below is nostr-tools' own encoding of the same pubkey the iOS
 * suite asserts on, so all three implementations are checked against one
 * external answer rather than against each other.
 */
public class NotificationRelayServiceDmRouteTest {
    private static final String ALICE_HEX =
            "1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f";
    private static final String ALICE_NPUB =
            "npub1rwzv24nmzfjypx2a8m264ws9vht3uxp5vpypnluuzl67n4waq78suk0wul";

    private static String dmRoute(String convKey) throws Exception {
        Method method = NotificationRelayService.class.getDeclaredMethod("dmRoute", String.class);
        method.setAccessible(true);
        return (String) method.invoke(null, convKey);
    }

    @Test
    public void encodesAHexPubkeyAsItsNpub() {
        assertEquals(ALICE_NPUB, NotificationRelayService.npubOrRaw(ALICE_HEX));
    }

    @Test
    public void leavesAnythingThatIsNotAPubkeyAlone() {
        // A malformed conversation key must still produce a parseable path
        // rather than a dropped destination.
        assertEquals("", NotificationRelayService.npubOrRaw(""));
        assertEquals("nope", NotificationRelayService.npubOrRaw("nope"));
        assertEquals("z".repeat(64), NotificationRelayService.npubOrRaw("z".repeat(64)));
        assertEquals(ALICE_NPUB, NotificationRelayService.npubOrRaw(ALICE_NPUB));
    }

    @Test
    public void buildsADmRouteOutOfNpubs() throws Exception {
        assertEquals("/dm/" + ALICE_NPUB, dmRoute(ALICE_HEX));
        assertFalse(dmRoute(ALICE_HEX).contains(ALICE_HEX));
    }

    @Test
    public void encodesEachParticipantOfAGroupKeepingTheSeparatorLiteral() throws Exception {
        String bobHex = "4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766";
        String route = dmRoute(ALICE_HEX + "," + bobHex);

        assertEquals(
                "/dm/" + ALICE_NPUB + "," + NotificationRelayService.npubOrRaw(bobHex), route);
        // `,` is a legal sub-delim in a path segment, so it survives as itself.
        assertFalse(route.contains("%2C"));
    }
}
