package buzz.armada.app.relayfleet;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;

public class RelayCoverTest {

    private static Set<String> set(String... values) {
        return new TreeSet<>(Arrays.asList(values));
    }

    @Test
    public void heldRelaysAreTakenFirst() {
        Map<String, List<String>> items = new LinkedHashMap<>();
        items.put("c1", Arrays.asList("a", "b", "c", "d", "e"));
        Map<String, Set<String>> out = RelayCover.assign(items, set("d", "e"), 2, Collections.emptySet());
        assertEquals(set("d", "e"), out.get("c1"));
    }

    @Test
    public void anItemRidesOnlyItsShareEvenWhereMoreAreHeld() {
        Map<String, List<String>> items = new LinkedHashMap<>();
        items.put("c1", Arrays.asList("a", "b", "c"));
        Map<String, Set<String>> out = RelayCover.assign(items, set("a", "b", "c"), 2, Collections.emptySet());
        assertEquals(2, out.get("c1").size());
    }

    @Test
    public void extraSocketsAreSharedAcrossItems() {
        Map<String, List<String>> items = new LinkedHashMap<>();
        items.put("c1", Arrays.asList("a", "shared", "x"));
        items.put("c2", Arrays.asList("b", "shared", "y"));
        items.put("c3", Arrays.asList("shared", "z"));
        Map<String, Set<String>> out = RelayCover.assign(items, set(), 1, Collections.emptySet());
        Map<String, Set<String>> relays = RelayCover.byRelay(out);
        assertEquals(set("shared"), relays.keySet());
        assertEquals(set("c1", "c2", "c3"), relays.get("shared"));
    }

    @Test
    public void anItemListingFewerThanItsShareGetsAll() {
        Map<String, List<String>> items = new LinkedHashMap<>();
        items.put("c1", Collections.singletonList("a"));
        assertEquals(set("a"), RelayCover.assign(items, set(), 2, Collections.emptySet()).get("c1"));
    }

    @Test
    public void avoidedRelaysAreALastResort() {
        Map<String, List<String>> items = new LinkedHashMap<>();
        items.put("c1", Arrays.asList("dead", "live1", "live2"));
        Map<String, Set<String>> out = RelayCover.assign(items, set("dead"), 2, set("dead"));
        assertEquals(set("live1", "live2"), out.get("c1"));

        Map<String, List<String>> allDead = new LinkedHashMap<>();
        allDead.put("c2", Arrays.asList("d1", "d2"));
        Map<String, Set<String>> kept = RelayCover.assign(allDead, set(), 2, set("d1", "d2"));
        assertEquals(set("d1", "d2"), kept.get("c2"));
    }

    @Test
    public void anItemListingNothingIsAbsent() {
        Map<String, List<String>> items = new LinkedHashMap<>();
        items.put("c1", Collections.emptyList());
        assertFalse(RelayCover.assign(items, set(), 2, Collections.emptySet()).containsKey("c1"));
    }

    @Test
    public void theSameInputOpensTheSameSockets() {
        Map<String, List<String>> items = new LinkedHashMap<>();
        items.put("c1", Arrays.asList("e", "d", "c", "b", "a"));
        items.put("c2", Arrays.asList("a", "c", "f"));
        Map<String, Set<String>> first = RelayCover.assign(items, set(), 2, Collections.emptySet());
        Map<String, Set<String>> second = RelayCover.assign(items, set(), 2, Collections.emptySet());
        assertEquals(first, second);
        assertTrue(RelayCover.byRelay(first).size() <= 3);
    }
}
