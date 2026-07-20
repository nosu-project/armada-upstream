package pub.armada.app;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Seals small secrets (the signer credentials the WebView shares with the
 * notification service) with an AES-256-GCM key that lives in the Android
 * Keystore and never leaves the secure hardware/TEE. The sealed blob goes into
 * ordinary SharedPreferences; without the device-bound Keystore key it's just
 * ciphertext — a strictly better at-rest posture than the WebView's own
 * localStorage where the same credentials already live in the clear.
 *
 * <p>Format: base64(iv(12) || ciphertext+tag). Best-effort API: null on any
 * failure (missing key after a backup restore, corrupted blob) — callers treat
 * that as "no credential" and fall back to bridge/generic behavior.
 */
final class SealedStore {

    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String ALIAS = "armada-signer-seal";

    private SealedStore() {}

    private static SecretKey key() throws Exception {
        KeyStore ks = KeyStore.getInstance(KEYSTORE);
        ks.load(null);
        KeyStore.Entry entry = ks.getEntry(ALIAS, null);
        if (entry instanceof KeyStore.SecretKeyEntry) {
            return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
        }
        KeyGenerator gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
        gen.init(new KeyGenParameterSpec.Builder(ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
        return gen.generateKey();
    }

    /** Encrypt a secret string for SharedPreferences storage; null on failure. */
    static synchronized String seal(String plaintext) {
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key());
            byte[] iv = cipher.getIV();
            byte[] ct = cipher.doFinal(plaintext.getBytes(StandardCharsets.UTF_8));
            byte[] out = new byte[iv.length + ct.length];
            System.arraycopy(iv, 0, out, 0, iv.length);
            System.arraycopy(ct, 0, out, iv.length, ct.length);
            return Base64.encodeToString(out, Base64.NO_WRAP);
        } catch (Exception e) {
            return null;
        }
    }

    /** Decrypt a sealed blob; null on any failure (treat as absent). */
    static synchronized String open(String sealed) {
        try {
            byte[] data = Base64.decode(sealed, Base64.NO_WRAP);
            if (data.length < 13) return null;
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(),
                    new GCMParameterSpec(128, data, 0, 12));
            byte[] pt = cipher.doFinal(data, 12, data.length - 12);
            return new String(pt, StandardCharsets.UTF_8);
        } catch (Exception e) {
            return null;
        }
    }
}
