package buzz.armada.app.relayfleet;

import java.util.LinkedHashSet;
import java.util.Set;

/**
 * Which of the user's DM inbox relays (kind 10050) the background fleet
 * subscribes on. The self-state relays are chosen the same way, since another
 * device publishes each document to all of them.
 *
 * <p>A NIP-17 sender publishes to every relay in the recipient's inbox list, so
 * a couple of them carry the same wraps as all of them, for fewer sockets.
 *
 * <p>Inbox relays the fleet already holds for another plane cost nothing and
 * always count. Beyond those, relays are added up to {@code count}: first ones
 * in {@code preferred} (relays another plane may then reuse), then list order,
 * so the same input always opens the same sockets.
 */
public final class DmRelayCover {

    private DmRelayCover() {}

    /**
     * @param dmRelays  the inbox relays, in the user's order
     * @param held      relays already open for another reason
     * @param preferred relays to favour when more are needed
     * @return the inbox relays to subscribe on, in {@code dmRelays} order
     */
    public static Set<String> choose(Iterable<String> dmRelays, Set<String> held,
                                     Set<String> preferred, int count) {
        Set<String> chosen = new LinkedHashSet<>();
        for (String relay : dmRelays) if (held.contains(relay)) chosen.add(relay);
        for (String relay : dmRelays) {
            if (chosen.size() >= count) break;
            if (preferred.contains(relay)) chosen.add(relay);
        }
        for (String relay : dmRelays) {
            if (chosen.size() >= count) break;
            chosen.add(relay);
        }
        Set<String> ordered = new LinkedHashSet<>();
        for (String relay : dmRelays) if (chosen.contains(relay)) ordered.add(relay);
        return ordered;
    }
}
