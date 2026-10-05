package buzz.armada.app.relayfleet;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;

/**
 * Which relays the background fleet opens for Git repository notifications.
 *
 * <p>A repository announcement lists every relay its maintainer publishes to,
 * often eight, so watching each repository on all of them would make Git the
 * largest source of background sockets (many of them aliases of relays already
 * held, or relays that refuse the connection). A repository's activity is
 * published to all of its relays, so a few carry it as well as all of them.
 *
 * <p>Relays the fleet already holds for another plane cost nothing and always
 * count. Beyond those, each repository is covered by at least
 * {@code perRepository} of its relays (or all of them, if it lists fewer),
 * choosing greedily the relay that covers the most still-short repositories.
 * Ties go to URL order, so the same input always opens the same sockets.
 */
public final class GitRelayCover {

    private GitRelayCover() {}

    /**
     * @param repositoryRelays each watched repository's relays
     * @param held             relays already open for another reason
     * @return the relays to open for Git beyond {@code held}
     */
    public static Set<String> choose(Map<String, ? extends Iterable<String>> repositoryRelays,
                                     Set<String> held, int perRepository) {
        Map<String, Integer> shortBy = new HashMap<>();
        Map<String, List<String>> candidates = new HashMap<>();
        for (Map.Entry<String, ? extends Iterable<String>> e : repositoryRelays.entrySet()) {
            int listed = 0, covered = 0;
            List<String> open = new ArrayList<>();
            for (String relay : new TreeSet<>(toList(e.getValue()))) {
                listed++;
                if (held.contains(relay)) covered++;
                else open.add(relay);
            }
            int need = Math.min(perRepository, listed) - covered;
            if (need > 0) {
                shortBy.put(e.getKey(), need);
                candidates.put(e.getKey(), open);
            }
        }
        Set<String> chosen = new TreeSet<>();
        while (!shortBy.isEmpty()) {
            Map<String, Integer> gain = new HashMap<>();
            for (String repository : shortBy.keySet()) {
                for (String relay : candidates.get(repository)) {
                    if (!chosen.contains(relay)) gain.merge(relay, 1, Integer::sum);
                }
            }
            String best = null;
            for (String relay : new TreeSet<>(gain.keySet())) {
                if (best == null || gain.get(relay) > gain.get(best)) best = relay;
            }
            if (best == null) break;
            chosen.add(best);
            for (String repository : new ArrayList<>(shortBy.keySet())) {
                if (!candidates.get(repository).contains(best)) continue;
                int left = shortBy.get(repository) - 1;
                if (left <= 0) shortBy.remove(repository);
                else shortBy.put(repository, left);
            }
        }
        return chosen;
    }

    private static List<String> toList(Iterable<String> relays) {
        List<String> out = new ArrayList<>();
        for (String relay : relays) out.add(relay);
        return out;
    }
}
