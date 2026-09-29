package buzz.armada.app.relayfleet;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;

/**
 * The Git watch set from a measured device: 19 repositories attached to the
 * user's communities, and the relays the fleet already held for Concord,
 * DMs, NIP-29 and the user's own documents. Watching every repository on
 * every relay it announced opened ten Git-only sockets, among them three
 * aliases that redirect to relay.ditto.pub, a paid relay that answers 403
 * and one whose connects time out.
 */
public class GitRelayCoverTest {

    private static final Set<String> HELD = urls(
            "asia.vectorapp.io/nostr", "denimroad.feeds.relay.tools", "jskitty.com/nostr", "nos.lol",
            "nostr.computingcache.com", "offchain.pub", "relay.armada.buzz", "relay.damus.io",
            "relay.ditto.pub", "relay.dreamith.to", "relay.primal.net", "soapbox.communities.buzz.xyz");

    private static final Map<String, List<String>> REPOS = new LinkedHashMap<>();

    private static void repo(int n, String... relays) {
        List<String> list = new ArrayList<>();
        for (String r : relays) list.add("wss://" + r);
        REPOS.put("repo" + n, list);
    }

    static {
            repo(0, "git.nostrhub.io", "gitnostr.com", "relay.ngit.dev");
            repo(1, "git.nostrhub.io", "git.shakespeare.diy", "gitnostr.com", "relay.ngit.dev");
            repo(2, "git.nostrhub.io", "git.shakespeare.diy", "relay.ditto.pub", "relay.dreamith.to", "relay.ngit.dev");
            repo(3, "git.nostrhub.io", "git.shakespeare.diy", "relay.ditto.pub", "relay.ngit.dev");
            repo(4, "relay.ngit.dev");
            repo(5, "git.shakespeare.diy", "relay.ditto.pub", "relay.mostr.pub", "relay.ngit.dev", "relay.primal.net");
            repo(6, "git.shakespeare.diy", "gitnostr.com", "relay.ditto.pub", "relay.mostr.pub", "relay.ngit.dev", "relay.primal.net");
            repo(7, "git.shakespeare.diy", "nos.lol", "nostr.oxtr.dev", "nostr.wine", "relay.damus.io", "relay.ditto.pub", "relay.ngit.dev", "relay.primal.net");
            repo(8, "git.shakespeare.diy", "nos.lol", "relay.ditto.pub", "relay.ngit.dev", "relay.primal.net");
            repo(9, "git.shakespeare.diy", "relay.ngit.dev");
            repo(10, "git.shakespeare.diy", "nos.lol", "nostr.wine", "nostrelites.org", "relay.damus.io", "relay.ditto.pub", "relay.ngit.dev", "relay.primal.net");
            repo(11, "git.shakespeare.diy", "nos.lol", "relay.damus.io", "relay.ditto.pub", "relay.ngit.dev", "relay.primal.net");
            repo(12, "ditto.pub/relay", "git.shakespeare.diy", "nos.lol", "nostr.oxtr.dev", "relay.damus.io", "relay.ditto.pub", "relay.ngit.dev", "relay.primal.net");
            repo(13, "ditto.pub/relay", "git.shakespeare.diy", "gleasonator.dev/relay", "nos.lol", "relay.damus.io", "relay.mostr.pub", "relay.ngit.dev", "relay.primal.net");
            repo(14, "git.shakespeare.diy", "nostr.oxtr.dev", "nostr.wine", "offchain.pub", "relay.ditto.pub", "relay.mostr.pub", "relay.ngit.dev", "relay.primal.net");
            repo(15, "git.shakespeare.diy", "nostr.oxtr.dev", "nostr.wine", "offchain.pub", "relay.ditto.pub", "relay.mostr.pub", "relay.ngit.dev", "relay.primal.net");
            repo(16, "ditto.pub/relay", "git.shakespeare.diy", "nos.lol", "nostr.oxtr.dev", "relay.damus.io", "relay.ditto.pub", "relay.ngit.dev", "relay.primal.net");
            repo(17, "git.shakespeare.diy", "nos.lol", "relay.damus.io", "relay.ditto.pub", "relay.ngit.dev", "relay.primal.net");
            repo(18, "git.shakespeare.diy", "nos.lol", "relay.damus.io", "relay.ditto.pub", "relay.ngit.dev", "relay.primal.net");
    }

    private static Set<String> urls(String... hosts) {
        Set<String> out = new TreeSet<>();
        for (String h : hosts) out.add("wss://" + h);
        return out;
    }

    private static Set<String> everyListed() {
        Set<String> out = new TreeSet<>();
        for (List<String> relays : REPOS.values()) out.addAll(relays);
        out.removeAll(HELD);
        return out;
    }

    private static int coverage(String repo, Set<String> open) {
        int n = 0;
        for (String r : REPOS.get(repo)) if (open.contains(r)) n++;
        return n;
    }

    @Test
    public void benchmark() {
        Set<String> before = everyListed();
        Set<String> after = GitRelayCover.choose(REPOS, HELD, 2);
        Set<String> open = new TreeSet<>(HELD);
        open.addAll(after);

        int thinnest = Integer.MAX_VALUE;
        for (String repo : REPOS.keySet()) {
            thinnest = Math.min(thinnest, coverage(repo, open));
        }
        System.out.printf("%n=== git watch relays: %d repositories, %d relays held for other planes ===%n",
                REPOS.size(), HELD.size());
        System.out.printf("  every announced relay: %2d git-only sockets %s%n", before.size(), before);
        System.out.printf("  cover of 2 per repo:   %2d git-only sockets %s%n", after.size(), after);
        System.out.printf("  fleet total: %d -> %d sockets; thinnest repository watched on %d relays%n",
                HELD.size() + before.size(), open.size(), thinnest);

        assertEquals(urls("git.nostrhub.io", "git.shakespeare.diy", "relay.ngit.dev"), after);
        for (String repo : REPOS.keySet()) {
            assertTrue(repo + " keeps two relays, or every one it lists",
                    coverage(repo, open) >= Math.min(2, REPOS.get(repo).size()));
        }
    }

    @Test
    public void heldRelaysCostNothing() {
        Map<String, List<String>> repos = Map.of("a", List.of("wss://held", "wss://x", "wss://y"));
        assertEquals(Set.of("wss://x"), GitRelayCover.choose(repos, Set.of("wss://held"), 2));
        assertEquals(Set.of(), GitRelayCover.choose(repos, Set.of("wss://held", "wss://y"), 2));
    }

    @Test
    public void sharedRelaysWinAndTiesAreStable() {
        Map<String, List<String>> repos = new LinkedHashMap<>();
        repos.put("a", List.of("wss://b", "wss://shared"));
        repos.put("c", List.of("wss://a", "wss://shared"));
        repos.put("d", List.of("wss://only"));
        assertEquals(Set.of("wss://shared", "wss://a", "wss://b", "wss://only"),
                GitRelayCover.choose(repos, Set.of(), 2));
        assertEquals(Set.of("wss://only", "wss://shared"), GitRelayCover.choose(repos, Set.of(), 1));
    }
}
