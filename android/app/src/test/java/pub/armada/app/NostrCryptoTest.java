package pub.armada.app;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;

import org.json.JSONArray;
import org.junit.Test;

/**
 * Wire-compatibility tests for the native Nostr crypto. Every expected value
 * was generated with the exact libraries the WebView uses (nostr-tools /
 * @noble/curves — see scratch/genvec.mjs), so a pass means the service's
 * signatures, conversation keys, event ids and NIP-44 payloads are
 * indistinguishable from the app's own.
 */
public class NostrCryptoTest {

    private static final byte[] SK_A = ConcordCrypto.hexToBytes(
            "0101010101010101010101010101010101010101010101010101010101010101");
    private static final byte[] SK_B = ConcordCrypto.hexToBytes(
            "0202020202020202020202020202020202020202020202020202020202020202");
    private static final String PK_A =
            "1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f";
    private static final String PK_B =
            "4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766";

    @Test
    public void derivesXOnlyPubkeys() {
        assertEquals(PK_A, NostrCrypto.pubkeyOf(SK_A));
        assertEquals(PK_B, NostrCrypto.pubkeyOf(SK_B));
    }

    @Test
    public void derivesSymmetricNip44ConversationKey() {
        String expected = "59c6d24d9c3a7bf8ca4cec54031a3e2ecfaa553452a2b2fa3147e31ee55f33d5";
        byte[] ab = NostrCrypto.conversationKey(SK_A, PK_B);
        byte[] ba = NostrCrypto.conversationKey(SK_B, PK_A);
        assertNotNull(ab);
        assertNotNull(ba);
        assertEquals(expected, NostrCrypto.bytesToHex(ab));
        assertEquals(expected, NostrCrypto.bytesToHex(ba));
    }

    @Test
    public void computesCanonicalEventId() throws Exception {
        // Exercises the JSON.stringify-compatible escaping: quotes, backslash,
        // newline, U+0000/U+0001/U+001F control chars, non-ASCII (€) and an astral pair (😀).
        JSONArray tags = new JSONArray()
                .put(new JSONArray().put("relay").put("wss://relay.example.com/"))
                .put(new JSONArray().put("challenge").put("abc\"def\\g\nh\u0001i€😀"));
        String id = NostrCrypto.eventId(PK_A, 1752969600L, 22242, tags, "ctrl:\u0000\u001f tail");
        assertEquals("e18a5afe0d88c618fd757dee0dd2cd12dcf82f88a6beff8edb27e3683ee8c893", id);
    }

    @Test
    public void signsBip340WithFixedAux() throws Exception {
        byte[] msg = ConcordCrypto.hexToBytes(
                "e18a5afe0d88c618fd757dee0dd2cd12dcf82f88a6beff8edb27e3683ee8c893");
        byte[] aux = ConcordCrypto.hexToBytes(
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        byte[] sig = NostrCrypto.schnorrSign(msg, SK_A, aux);
        assertEquals(
                "e77583081169970bfb181a6a26a09b93d97263e3ef1ef259d74c7e4381ea270a"
                        + "788e6a304905a99cc79af2c65b150cf1dcb7977b35dd44586332f9a1e722dfc3",
                NostrCrypto.bytesToHex(sig));
    }

    @Test
    public void nip44EncryptMatchesNostrTools() {
        byte[] conv = ConcordCrypto.hexToBytes(
                "59c6d24d9c3a7bf8ca4cec54031a3e2ecfaa553452a2b2fa3147e31ee55f33d5");
        byte[] nonce = ConcordCrypto.hexToBytes(
                "0f0e0d0c0b0a09080706050403020100ff00ff00ff00ff00ff00ff00ff00ff00");
        byte[] payload = ConcordCrypto.encryptBytes(
                conv, "hello, ärmada ✓ \"quotes\" \\slash\n", nonce);
        byte[] expected = java.util.Base64.getDecoder().decode(
                "Ag8ODQwLCgkIBwYFBAMCAQD/AP8A/wD/AP8A/wD/AP8AhL4duaV6r4d5SoUMlwsCvihDslW0"
                        + "FDmdtDR1MYfGHvXVdaLWaM4m0Y3HdvJN00FrY2M9VQChtozyZlqffP0biUnUnqLQ"
                        + "6WxtN/tk/WotkbpTa6BLn5oeQ+YW1iV+nCFgMUE=");
        assertArrayEquals(expected, payload);
    }
}
