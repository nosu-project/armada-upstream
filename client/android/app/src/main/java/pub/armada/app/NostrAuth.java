package pub.armada.app;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;

/**
 * Builds signed NIP-42 (kind 22242) AUTH events natively, so the notification
 * service can authenticate a relay connection <em>as a CORD stream key</em>
 * without waking the WebView's signer bridge.
 *
 * <p>The event id is SHA-256 over the NIP-01 canonical serialization
 * {@code [0, pubkey, created_at, kind, tags, content]} with
 * JSON.stringify-compatible string escaping. org.json's serializer is NOT used
 * for the id preimage — it escapes {@code /} after {@code <} (and relay URLs
 * contain {@code //}), which would silently produce a different hash than
 * every other Nostr implementation. The escaping below mirrors
 * {@code JSON.stringify}: {@code \" \\ \b \f \n \r \t}, all other control
 * characters as {@code \\u00XX}, everything else verbatim UTF-8.
 */
final class NostrAuth {

    private NostrAuth() {}

    /**
     * Build a signed kind-22242 AUTH event for {@code challenge} on
     * {@code relayUrl}, signed by the 32-byte secret key. Returns the full
     * event as a JSONObject ready for {@code ["AUTH", event]}, or {@code null}
     * on any failure (bad key, signing failure) — best-effort, never throws.
     */
    static JSONObject buildAuthEvent(byte[] sk, String relayUrl, String challenge) {
        try {
            byte[] pub = Bip340.pubkeyXOnly(sk);
            if (pub == null) return null;
            String pubkey = Bip340.bytesToHex(pub);
            long createdAt = System.currentTimeMillis() / 1000L;

            // NIP-01 canonical serialization for the id.
            StringBuilder pre = new StringBuilder(160);
            pre.append("[0,\"").append(pubkey).append("\",").append(createdAt).append(",22242,[");
            pre.append("[\"relay\",").append(quote(relayUrl)).append("],");
            pre.append("[\"challenge\",").append(quote(challenge)).append("]");
            pre.append("],\"\"]");
            byte[] id = Bip340.sha256(pre.toString().getBytes(StandardCharsets.UTF_8));

            byte[] sig = Bip340.sign(sk, id);
            if (sig == null) return null;

            JSONObject event = new JSONObject();
            event.put("id", Bip340.bytesToHex(id));
            event.put("pubkey", pubkey);
            event.put("created_at", createdAt);
            event.put("kind", 22242);
            JSONArray tags = new JSONArray();
            tags.put(new JSONArray().put("relay").put(relayUrl));
            tags.put(new JSONArray().put("challenge").put(challenge));
            event.put("tags", tags);
            event.put("content", "");
            event.put("sig", Bip340.bytesToHex(sig));
            return event;
        } catch (Exception e) {
            return null;
        }
    }

    /** JSON.stringify-compatible string quoting (see class doc). */
    static String quote(String s) {
        StringBuilder sb = new StringBuilder(s.length() + 2);
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"':  sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\b': sb.append("\\b"); break;
                case '\f': sb.append("\\f"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 0x20) {
                        sb.append(String.format("\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
            }
        }
        sb.append('"');
        return sb.toString();
    }
}
