package pub.armada.app;

import org.bouncycastle.asn1.x9.X9ECParameters;
import org.bouncycastle.crypto.ec.CustomNamedCurves;
import org.bouncycastle.math.ec.ECCurve;
import org.bouncycastle.math.ec.ECPoint;
import org.json.JSONArray;
import org.json.JSONObject;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Arrays;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * The secp256k1 side of Nostr for the background service: x-only public keys,
 * NIP-44 conversation keys (ECDH), BIP-340 Schnorr signatures and canonical
 * NIP-01 event ids — enough to open ANY gift wrap addressed to the user and to
 * answer NIP-42 AUTH challenges natively, without the WebView.
 *
 * <p>Built on Bouncy Castle's curve arithmetic (already an app dependency for
 * the Bluetooth mesh layer). Wire compatibility is pinned by unit tests whose
 * expected values were generated with the exact libraries the WebView signs
 * and encrypts with (nostr-tools / @noble/curves) — see NostrCryptoTest.
 */
final class NostrCrypto {

    private NostrCrypto() {}

    private static final X9ECParameters PARAMS = CustomNamedCurves.getByName("secp256k1");
    private static final ECCurve CURVE = PARAMS.getCurve();
    private static final ECPoint G = PARAMS.getG();
    private static final BigInteger N = PARAMS.getN();

    private static final SecureRandom RANDOM = new SecureRandom();

    // ── Keys ─────────────────────────────────────────────────────────────────

    /** x-only (BIP-340 / Nostr) public key for a 32-byte secret key, hex. */
    static String pubkeyOf(byte[] sk) {
        BigInteger d = scalar(sk);
        ECPoint p = G.multiply(d).normalize();
        return bytesToHex(p.getAffineXCoord().getEncoded());
    }

    /**
     * NIP-44 v2 conversation key between {@code sk} and an x-only peer pubkey:
     * {@code HKDF-Extract(salt="nip44-v2", ikm=ECDH_x(sk, lift_x(peer)))}.
     * Symmetric — conv(a, B) == conv(b, A). Returns null on any invalid input
     * (bad hex, x not on curve) instead of throwing.
     */
    static byte[] conversationKey(byte[] sk, String peerPkHex) {
        try {
            byte[] x = ConcordCrypto.hexToBytes(peerPkHex);
            if (x == null || x.length != 32) return null;
            byte[] compressed = new byte[33];
            compressed[0] = 0x02; // lift_x: the even-Y point
            System.arraycopy(x, 0, compressed, 1, 32);
            ECPoint peer = CURVE.decodePoint(compressed);
            BigInteger d = scalar(sk);
            byte[] sharedX = peer.multiply(d).normalize().getAffineXCoord().getEncoded();
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec("nip44-v2".getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            return mac.doFinal(sharedX);
        } catch (Exception e) {
            return null;
        }
    }

    // ── BIP-340 Schnorr signing ──────────────────────────────────────────────

    /** Sign a 32-byte message hash per BIP-340. {@code aux} is 32 random bytes. */
    static byte[] schnorrSign(byte[] msg32, byte[] sk, byte[] aux32) throws Exception {
        BigInteger d0 = scalar(sk);
        ECPoint P = G.multiply(d0).normalize();
        BigInteger d = P.getAffineYCoord().toBigInteger().testBit(0) ? N.subtract(d0) : d0;
        byte[] px = P.getAffineXCoord().getEncoded();

        byte[] t = xor(to32(d), taggedHash("BIP0340/aux", aux32));
        byte[] rand = taggedHash("BIP0340/nonce", concat(t, px, msg32));
        BigInteger k0 = new BigInteger(1, rand).mod(N);
        if (k0.signum() == 0) throw new IllegalStateException("zero nonce");
        ECPoint R = G.multiply(k0).normalize();
        BigInteger k = R.getAffineYCoord().toBigInteger().testBit(0) ? N.subtract(k0) : k0;
        byte[] rx = R.getAffineXCoord().getEncoded();

        BigInteger e = new BigInteger(1, taggedHash("BIP0340/challenge", concat(rx, px, msg32))).mod(N);
        BigInteger s = k.add(e.multiply(d)).mod(N);
        return concat(rx, to32(s));
    }

    // ── NIP-01 events ────────────────────────────────────────────────────────

    /**
     * The canonical NIP-01 event id: sha256 of
     * {@code [0,pubkey,created_at,kind,tags,content]} serialized exactly as
     * JavaScript's {@code JSON.stringify} would (see {@link #jsonString}) —
     * org.json's own serializer escapes differently and must not be used here.
     */
    static String eventId(String pubkey, long createdAt, int kind, JSONArray tags, String content) {
        StringBuilder sb = new StringBuilder();
        sb.append("[0,\"").append(pubkey).append("\",").append(createdAt).append(',').append(kind).append(',');
        sb.append('[');
        for (int i = 0; i < tags.length(); i++) {
            if (i > 0) sb.append(',');
            JSONArray tag = tags.optJSONArray(i);
            sb.append('[');
            if (tag != null) {
                for (int j = 0; j < tag.length(); j++) {
                    if (j > 0) sb.append(',');
                    jsonString(sb, tag.optString(j));
                }
            }
            sb.append(']');
        }
        sb.append("],");
        jsonString(sb, content);
        sb.append(']');
        try {
            MessageDigest sha = MessageDigest.getInstance("SHA-256");
            return bytesToHex(sha.digest(sb.toString().getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            throw new RuntimeException(e); // SHA-256 always exists
        }
    }

    /** Build, id and Schnorr-sign a complete event with the given secret key. */
    static JSONObject finalizeEvent(int kind, String content, JSONArray tags, long createdAt, byte[] sk)
            throws Exception {
        String pubkey = pubkeyOf(sk);
        String id = eventId(pubkey, createdAt, kind, tags, content);
        byte[] aux = new byte[32];
        RANDOM.nextBytes(aux);
        byte[] sig = schnorrSign(ConcordCrypto.hexToBytes(id), sk, aux);
        JSONObject ev = new JSONObject();
        ev.put("id", id);
        ev.put("pubkey", pubkey);
        ev.put("created_at", createdAt);
        ev.put("kind", kind);
        ev.put("tags", tags);
        ev.put("content", content);
        ev.put("sig", bytesToHex(sig));
        return ev;
    }

    /**
     * Append a JSON string literal exactly as JavaScript's JSON.stringify:
     * escape {@code "} and {@code \}, use the two-char forms for
     * {@code \b \t \n \f \r}, {@code \\u00xx} for other control chars, and emit
     * everything else (including all non-ASCII) literally. org.json instead
     * escapes {@code /} after {@code <} and high code points, which would
     * change the hash.
     */
    private static void jsonString(StringBuilder sb, String s) {
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\b': sb.append("\\b"); break;
                case '\t': sb.append("\\t"); break;
                case '\n': sb.append("\\n"); break;
                case '\f': sb.append("\\f"); break;
                case '\r': sb.append("\\r"); break;
                default:
                    if (c < 0x20) {
                        sb.append(String.format("\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
            }
        }
        sb.append('"');
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    private static BigInteger scalar(byte[] sk) {
        if (sk == null || sk.length != 32) throw new IllegalArgumentException("bad secret key");
        BigInteger d = new BigInteger(1, sk);
        if (d.signum() == 0 || d.compareTo(N) >= 0) throw new IllegalArgumentException("secret key out of range");
        return d;
    }

    private static byte[] taggedHash(String tag, byte[] data) throws Exception {
        MessageDigest sha = MessageDigest.getInstance("SHA-256");
        byte[] tagHash = sha.digest(tag.getBytes(StandardCharsets.UTF_8));
        sha.reset();
        sha.update(tagHash);
        sha.update(tagHash);
        sha.update(data);
        return sha.digest();
    }

    private static byte[] to32(BigInteger v) {
        byte[] raw = v.toByteArray();
        if (raw.length == 32) return raw;
        byte[] out = new byte[32];
        if (raw.length > 32) {
            System.arraycopy(raw, raw.length - 32, out, 0, 32);
        } else {
            System.arraycopy(raw, 0, out, 32 - raw.length, raw.length);
        }
        return out;
    }

    private static byte[] xor(byte[] a, byte[] b) {
        byte[] out = new byte[a.length];
        for (int i = 0; i < a.length; i++) out[i] = (byte) (a[i] ^ b[i]);
        return out;
    }

    private static byte[] concat(byte[]... parts) {
        int len = 0;
        for (byte[] p : parts) len += p.length;
        byte[] out = new byte[len];
        int pos = 0;
        for (byte[] p : parts) {
            System.arraycopy(p, 0, out, pos, p.length);
            pos += p.length;
        }
        return out;
    }

    static String bytesToHex(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) {
            sb.append(Character.forDigit((b >> 4) & 0xf, 16));
            sb.append(Character.forDigit(b & 0xf, 16));
        }
        return sb.toString();
    }
}
