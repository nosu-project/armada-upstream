package buzz.armada.app.relayfleet;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

public class DmRelayCoverTest {

    private static final List<String> INBOX = Arrays.asList(
            "wss://relay.dreamith.to", "wss://relay.ditto.pub", "wss://relay.primal.net",
            "wss://jskitty.com/nostr", "wss://asia.vectorapp.io/nostr");

    private static Set<String> set(String... urls) {
        return new HashSet<>(Arrays.asList(urls));
    }

    private static List<String> list(Set<String> s) {
        return Arrays.asList(s.toArray(new String[0]));
    }

    @Test
    public void nothingHeldTakesTheFirstInListOrder() {
        Set<String> out = DmRelayCover.choose(INBOX, Collections.emptySet(), Collections.emptySet(), 2);
        assertEquals(Arrays.asList("wss://relay.dreamith.to", "wss://relay.ditto.pub"), list(out));
    }

    @Test
    public void heldRelaysAlwaysCountEvenBeyondTheTarget() {
        Set<String> held = set("wss://relay.primal.net", "wss://jskitty.com/nostr", "wss://asia.vectorapp.io/nostr");
        Set<String> out = DmRelayCover.choose(INBOX, held, Collections.emptySet(), 2);
        assertEquals(Arrays.asList("wss://relay.primal.net", "wss://jskitty.com/nostr",
                "wss://asia.vectorapp.io/nostr"), list(out));
    }

    @Test
    public void fillsFromPreferredBeforeListOrder() {
        Set<String> out = DmRelayCover.choose(INBOX, set("wss://jskitty.com/nostr"),
                set("wss://relay.primal.net"), 2);
        assertEquals(Arrays.asList("wss://relay.primal.net", "wss://jskitty.com/nostr"), list(out));
    }

    @Test
    public void aShortListIsWatchedWhole() {
        List<String> one = Collections.singletonList("wss://relay.ditto.pub");
        assertEquals(one, list(DmRelayCover.choose(one, Collections.emptySet(), Collections.emptySet(), 2)));
    }
}
