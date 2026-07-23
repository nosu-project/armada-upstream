package buzz.armada.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

import java.util.HashMap;
import java.util.Map;

/**
 * JVM tests for {@link NotificationContent} — the content cleanup applied to a
 * notification body: NIP-27 mention resolution ({@code nostr:npub…} → {@code
 * @name}) and inline-media-URL stripping, matching the web client's preview.
 */
public class NotificationContentTest {

    // Real bech32 vectors (nak encode) for a known 32-byte pubkey.
    private static final String PK1 =
            "3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d";
    private static final String NPUB1 =
            "npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6";
    private static final String NPROFILE1 =
            "nprofile1qqsrhuxx8l9ex335q7he0f09aej04zpazpl0ne2cgukyawd24mayt8g2lcy6q";
    private static final String PK2 =
            "6e468422dfb74a5738702a8823b9b28168abab8655faacb6853cd0ee15deee93";
    private static final String NPUB2 =
            "npub1dergggklka99wwrs92yz8wdjs952h2ux2ha2ed598ngwu9w7a6fsh9xzpc";

    /** Resolver over a fixed name table; unknown pubkeys get a short id. */
    private static NotificationContent.MentionResolver resolver(Map<String, String> names) {
        return pubkey -> {
            String n = names.get(pubkey);
            return n != null ? n : "User " + pubkey.substring(0, 8);
        };
    }

    private static NotificationContent.MentionResolver named(String pk, String name) {
        Map<String, String> m = new HashMap<>();
        m.put(pk, name);
        return resolver(m);
    }

    // ── bech32 / NIP-19 decoding ─────────────────────────────────────────────

    @Test
    public void decodesNpubToHex() {
        assertEquals(PK1, NotificationContent.pubkeyHex(NPUB1));
        assertEquals(PK2, NotificationContent.pubkeyHex(NPUB2));
    }

    @Test
    public void decodesNprofileToHex() {
        // nprofile is TLV; the type-0 entry carries the same pubkey.
        assertEquals(PK1, NotificationContent.pubkeyHex(NPROFILE1));
    }

    @Test
    public void rejectsGarbageBech32() {
        assertNull(NotificationContent.pubkeyHex("npub1notavalidkey"));
        assertNull(NotificationContent.pubkeyHex("npub1"));
        assertNull(NotificationContent.pubkeyHex("hello"));
        assertNull(NotificationContent.pubkeyHex(null));
        // Valid charset/length but a corrupted checksum (last char flipped).
        assertNull(NotificationContent.pubkeyHex(NPUB1.substring(0, NPUB1.length() - 1) + "0"));
    }

    // ── mention resolution ───────────────────────────────────────────────────

    @Test
    public void resolvesNostrPrefixedMentionToName() {
        assertEquals("hello @Alex",
                NotificationContent.clean("hello nostr:" + NPUB1, named(PK1, "Alex")));
    }

    @Test
    public void resolvesBareMentionToName() {
        assertEquals("hi @Alex there",
                NotificationContent.clean("hi " + NPUB1 + " there", named(PK1, "Alex")));
    }

    @Test
    public void resolvesNprofileMention() {
        assertEquals("cc @Alex",
                NotificationContent.clean("cc nostr:" + NPROFILE1, named(PK1, "Alex")));
    }

    @Test
    public void resolvesMultipleMentions() {
        Map<String, String> names = new HashMap<>();
        names.put(PK1, "Alice");
        names.put(PK2, "Bob");
        assertEquals("@Alice and @Bob",
                NotificationContent.clean("nostr:" + NPUB1 + " and nostr:" + NPUB2, resolver(names)));
    }

    @Test
    public void unknownMentionFallsBackToShortId() {
        // Resolver returns "User <8hex>" for anything it doesn't know.
        assertEquals("yo @User 3bf0c63f",
                NotificationContent.clean("yo nostr:" + NPUB1, resolver(new HashMap<>())));
    }

    @Test
    public void nameWithSpecialCharsIsNotTreatedAsRegexReplacement() {
        // A '$' or '\\' in a display name must land literally, not as a group ref.
        assertEquals("@a$1\\b",
                NotificationContent.clean("nostr:" + NPUB1, named(PK1, "a$1\\b")));
    }

    // ── media-URL stripping ──────────────────────────────────────────────────

    @Test
    public void stripsTrailingImageUrl() {
        assertEquals("lol",
                NotificationContent.clean("lol https://blossom.ditto.pub/abcd123.jpg", null));
    }

    @Test
    public void stripsImageUrlWithQueryString() {
        assertEquals("look",
                NotificationContent.clean("look https://cdn.example/x.png?w=100&h=50", null));
    }

    @Test
    public void keepsNonMediaUrl() {
        assertEquals("lol https://reddit.com",
                NotificationContent.clean("lol https://reddit.com", null));
    }

    @Test
    public void stripsMediaFromMiddleWithoutDoubleSpace() {
        assertEquals("a b",
                NotificationContent.clean("a https://x/y.mp4 b", null));
    }

    @Test
    public void stripsVideoAudioAndWebxdc() {
        assertEquals("", NotificationContent.clean("https://x/a.webm", null));
        assertEquals("", NotificationContent.clean("https://x/a.mp3", null));
        assertEquals("", NotificationContent.clean("https://x/a.xdc", null));
    }

    @Test
    public void stripsMultipleMediaUrls() {
        assertEquals("check done",
                NotificationContent.clean(
                        "check https://x/a.jpg https://y/b.png done", null));
    }

    @Test
    public void keepsNonMediaAndStripsMediaTogether() {
        assertEquals("see https://reddit.com",
                NotificationContent.clean(
                        "see https://reddit.com https://x/a.jpg", null));
    }

    // ── combined + edge cases ────────────────────────────────────────────────

    @Test
    public void resolvesMentionAndStripsMediaTogether() {
        assertEquals("hey @Alex",
                NotificationContent.clean(
                        "hey nostr:" + NPUB1 + " https://x/pic.gif", named(PK1, "Alex")));
    }

    @Test
    public void emptyAndNullInputYieldEmpty() {
        assertEquals("", NotificationContent.clean("", null));
        assertEquals("", NotificationContent.clean(null, null));
    }

    @Test
    public void plainTextIsUnchanged() {
        assertEquals("just a normal message",
                NotificationContent.clean("just a normal message", null));
    }
}
