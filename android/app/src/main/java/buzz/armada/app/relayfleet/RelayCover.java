package buzz.armada.app.relayfleet;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;

/**
 * Which of an item's relays the background fleet watches it on — an item being
 * a Concord community or the user's own documents, each published to every
 * relay it lists, so a couple of them carry it as well as all of them.
 *
 * <p>Unlike {@link GitRelayCover}, the answer is an ASSIGNMENT: an item is
 * subscribed on exactly its chosen relays, even where it lists more that are
 * held anyway. Every extra relay an item rides costs a duplicate copy of each
 * event and, for Concord, a NIP-42 AUTH per stream key per session.
 *
 * <p>Each item gets {@code perItem} relays (or all it lists, if fewer):
 * relays already {@code held} first, since they cost no socket; then, greedily,
 * the relay that serves the most still-short items. {@code avoid} names relays
 * that recently failed for good (DNS, refused, auth wall): they are taken only
 * when an item has nothing else, so a community whose relays are all down is
 * still watched once they return. Ties go to URL order, so the same input
 * always opens the same sockets.
 */
public final class RelayCover {

    private RelayCover() {}

    /**
     * @param itemRelays each item's relays
     * @param held       relays open for another reason (free)
     * @param avoid      relays to use only as a last resort
     * @return each item's chosen relays, in URL order; an item listing none is absent
     */
    public static Map<String, Set<String>> assign(Map<String, ? extends Iterable<String>> itemRelays,
                                                  Set<String> held, int perItem, Set<String> avoid) {
        Map<String, Set<String>> chosen = new TreeMap<>();
        Map<String, Integer> shortBy = new TreeMap<>();
        Map<String, List<String>> candidates = new HashMap<>();
        Map<String, List<String>> lastResort = new HashMap<>();
        for (Map.Entry<String, ? extends Iterable<String>> e : itemRelays.entrySet()) {
            Set<String> listed = new TreeSet<>();
            for (String relay : e.getValue()) listed.add(relay);
            if (listed.isEmpty()) continue;
            Set<String> mine = new TreeSet<>();
            int want = Math.min(perItem, listed.size());
            List<String> open = new ArrayList<>();
            List<String> dead = new ArrayList<>();
            for (String relay : listed) {
                if (avoid.contains(relay)) dead.add(relay);
                else if (held.contains(relay) && mine.size() < want) mine.add(relay);
                else if (!held.contains(relay)) open.add(relay);
            }
            chosen.put(e.getKey(), mine);
            if (mine.size() < want) {
                shortBy.put(e.getKey(), want - mine.size());
                candidates.put(e.getKey(), open);
                lastResort.put(e.getKey(), dead);
            }
        }
        // Extra sockets, greedily by how many short items each would serve.
        while (!shortBy.isEmpty()) {
            Map<String, Integer> gain = new TreeMap<>();
            for (String item : shortBy.keySet()) {
                for (String relay : candidates.get(item)) {
                    if (!chosen.get(item).contains(relay)) gain.merge(relay, 1, Integer::sum);
                }
            }
            String best = null;
            for (Map.Entry<String, Integer> g : gain.entrySet()) {
                if (best == null || g.getValue() > gain.get(best)) best = g.getKey();
            }
            if (best == null) break;
            for (String item : new ArrayList<>(shortBy.keySet())) {
                if (!candidates.get(item).contains(best)) continue;
                chosen.get(item).add(best);
                int left = shortBy.get(item) - 1;
                if (left <= 0) shortBy.remove(item);
                else shortBy.put(item, left);
            }
        }
        // An item with no live relay left keeps its dead ones, so the fleet still
        // reconnects to them when the network or the app re-arms it.
        for (Map.Entry<String, Integer> e : shortBy.entrySet()) {
            Set<String> mine = chosen.get(e.getKey());
            if (!mine.isEmpty()) continue;
            int left = e.getValue();
            for (String relay : lastResort.get(e.getKey())) {
                if (left-- <= 0) break;
                mine.add(relay);
            }
        }
        chosen.values().removeIf(Set::isEmpty);
        return chosen;
    }

    /** The relays an assignment opens, and the items each one carries. */
    public static Map<String, Set<String>> byRelay(Map<String, Set<String>> assignment) {
        Map<String, Set<String>> out = new LinkedHashMap<>();
        for (Map.Entry<String, Set<String>> e : assignment.entrySet()) {
            for (String relay : e.getValue()) {
                out.computeIfAbsent(relay, k -> new TreeSet<>()).add(e.getKey());
            }
        }
        return out;
    }
}
