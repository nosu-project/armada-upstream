package pub.armada.app;

import java.math.BigInteger;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Arrays;

/**
 * Minimal, dependency-free BIP-340 Schnorr signing over secp256k1 — exactly
 * enough for the background notification service to answer a relay's NIP-42
 * challenge <em>as a CORD stream key</em> ("AUTH as the room").
 *
 * <p>DM-protecting relays only serve {@code authors}-filtered kind-1059 REQs to
 * connections that have NIP-42-authenticated as those authors. The WebView's
 * signer bridge can only sign as the <em>user</em> (and only while the WebView
 * is alive); the CORD group signing keys, by contrast, ride the subscription
 * config, so the service can sign kind-22242 AUTH events natively — no bridge,
 * works from BootReceiver cold starts.
 *
 * <p>BigInteger affine double-and-add is plenty here: a handful of signatures
 * per connection, each ~a millisecond on any modern phone. Not constant-time —
 * acceptable for this use (the keys sign public AUTH/wrap events whose
 * possession IS the capability; a local timing observer on the same device
 * already reads the key bytes out of SharedPreferences).
 *
 * <p>Follows BIP-340 verbatim: tagged hashes, even-Y normalization of both the
 * secret key and the nonce, and {@code sig = R.x || (k + e*d) mod n}.
 */
final class Bip340 {

    private Bip340() {}

    // secp256k1 domain parameters.
    private static final BigInteger P = new BigInteger(
            "fffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f", 16);
    private static final BigInteger N = new BigInteger(
            "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141", 16);
    private static final BigInteger GX = new BigInteger(
            "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798", 16);
    private static final BigInteger GY = new BigInteger(
            "483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8", 16);

    private static final BigInteger TWO = BigInteger.valueOf(2);
    private static final BigInteger THREE = BigInteger.valueOf(3);

    private static final SecureRandom RNG = new SecureRandom();

    /** An affine point; {@code null} coordinates encode the point at infinity. */
    private static final class Point {
        final BigInteger x;
        final BigInteger y;
        Point(BigInteger x, BigInteger y) { this.x = x; this.y = y; }
        boolean isInfinity() { return x == null; }
        static final Point INFINITY = new Point(null, null);
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * The x-only (BIP-340) public key for a 32-byte secret key, or {@code null}
     * if the key is out of range. This is the Nostr {@code pubkey}.
     */
    static byte[] pubkeyXOnly(byte[] sk) {
        BigInteger d = toScalar(sk);
        if (d == null) return null;
        Point pub = mul(new Point(GX, GY), d);
        return to32(pub.x);
    }

    /**
     * BIP-340 Schnorr signature (64 bytes) of a 32-byte message hash, or
     * {@code null} on any invalid input. Uses fresh random auxiliary data.
     */
    static byte[] sign(byte[] sk, byte[] msg32) {
        try {
            if (msg32 == null || msg32.length != 32) return null;
            BigInteger d0 = toScalar(sk);
            if (d0 == null) return null;

            Point pub = mul(new Point(GX, GY), d0);
            BigInteger d = pub.y.testBit(0) ? N.subtract(d0) : d0;
            byte[] pubX = to32(pub.x);

            byte[] aux = new byte[32];
            RNG.nextBytes(aux);
            byte[] t = xor(to32(d), taggedHash("BIP0340/aux", aux));
            byte[] rand = taggedHash("BIP0340/nonce", concat(t, pubX, msg32));
            BigInteger k0 = new BigInteger(1, rand).mod(N);
            if (k0.signum() == 0) return null;

            Point r = mul(new Point(GX, GY), k0);
            BigInteger k = r.y.testBit(0) ? N.subtract(k0) : k0;
            byte[] rX = to32(r.x);

            BigInteger e = new BigInteger(1,
                    taggedHash("BIP0340/challenge", concat(rX, pubX, msg32))).mod(N);
            BigInteger s = k.add(e.multiply(d)).mod(N);

            return concat(rX, to32(s));
        } catch (Exception ex) {
            return null;
        }
    }

    /** SHA-256 (convenience for event-id hashing). */
    static byte[] sha256(byte[] data) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(data);
        } catch (Exception e) {
            throw new IllegalStateException("SHA-256 unavailable", e);
        }
    }

    static String bytesToHex(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) {
            sb.append(Character.forDigit((b >> 4) & 0xf, 16));
            sb.append(Character.forDigit(b & 0xf, 16));
        }
        return sb.toString();
    }

    // ── Scalar / byte helpers ─────────────────────────────────────────────────

    /** Parse a 32-byte secret key; {@code null} unless {@code 1 <= sk < n}. */
    private static BigInteger toScalar(byte[] sk) {
        if (sk == null || sk.length != 32) return null;
        BigInteger d = new BigInteger(1, sk);
        if (d.signum() == 0 || d.compareTo(N) >= 0) return null;
        return d;
    }

    private static byte[] to32(BigInteger v) {
        byte[] raw = v.toByteArray();
        byte[] out = new byte[32];
        if (raw.length > 32) {
            // Strip the sign byte BigInteger prepends for high-bit values.
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
        int o = 0;
        for (byte[] p : parts) {
            System.arraycopy(p, 0, out, o, p.length);
            o += p.length;
        }
        return out;
    }

    /** BIP-340 tagged hash: {@code SHA256(SHA256(tag) || SHA256(tag) || data)}. */
    private static byte[] taggedHash(String tag, byte[] data) {
        byte[] tagHash = sha256(tag.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        return sha256(concat(tagHash, tagHash, data));
    }

    // ── secp256k1 affine arithmetic ───────────────────────────────────────────

    private static Point add(Point a, Point b) {
        if (a.isInfinity()) return b;
        if (b.isInfinity()) return a;
        if (a.x.equals(b.x)) {
            if (a.y.equals(b.y)) return doubl(a);
            return Point.INFINITY; // P + (-P)
        }
        BigInteger lambda = b.y.subtract(a.y)
                .multiply(b.x.subtract(a.x).modInverse(P)).mod(P);
        BigInteger x3 = lambda.multiply(lambda).subtract(a.x).subtract(b.x).mod(P);
        BigInteger y3 = lambda.multiply(a.x.subtract(x3)).subtract(a.y).mod(P);
        return new Point(x3, y3);
    }

    private static Point doubl(Point a) {
        if (a.isInfinity() || a.y.signum() == 0) return Point.INFINITY;
        BigInteger lambda = a.x.multiply(a.x).multiply(THREE)
                .multiply(a.y.multiply(TWO).modInverse(P)).mod(P);
        BigInteger x3 = lambda.multiply(lambda).subtract(a.x.multiply(TWO)).mod(P);
        BigInteger y3 = lambda.multiply(a.x.subtract(x3)).subtract(a.y).mod(P);
        return new Point(x3, y3);
    }

    /** Double-and-add scalar multiplication (k assumed in [1, n)). */
    private static Point mul(Point p, BigInteger k) {
        Point result = Point.INFINITY;
        Point addend = p;
        for (int i = 0; i < k.bitLength(); i++) {
            if (k.testBit(i)) result = add(result, addend);
            addend = doubl(addend);
        }
        return result;
    }
}
