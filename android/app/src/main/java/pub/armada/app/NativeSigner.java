package pub.armada.app;

import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

/**
 * The notification service's own signer — the same capability the WebView's
 * login grants, shared with the background process so it can open ANY NIP-17
 * gift wrap (rich DM notifications regardless of sender client) and answer
 * NIP-42 AUTH challenges while the app is dead. One implementation per login
 * type:
 *
 *   - {@link DirectKey}: nsec logins. The raw key (which already lives in the
 *     WebView's localStorage, same app sandbox) does everything locally.
 *   - {@link Amber}: NIP-55 signer apps. Background ContentResolver queries
 *     against the signer app's provider — the exact contract
 *     capacitor-plugin-nostr-signer uses; works headless when the user has
 *     granted the app background permission in the signer.
 *   - {@link Nip46}: bunker logins. The pairing's CLIENT key + bunker pubkey +
 *     relays are the session credential the app already holds; the service
 *     runs its own kind-24133 RPC channel over the bunker relays (requests
 *     NIP-44-sealed exactly like src/lib/nip46Signer.ts).
 *
 * Decrypt outcomes distinguish "the signer answered and this doesn't open"
 * (silent — not a readable DM) from "the signer was unreachable" (the caller
 * falls back to a generic notification rather than dropping the message).
 */
abstract class NativeSigner {

    private static final String TAG = "ArmadaNativeSigner";

    interface DecryptCallback {
        /**
         * @param plaintext   the decrypted string, or null.
         * @param unavailable true when null is because the signer couldn't be
         *                    reached (Amber missing background grant, bunker
         *                    offline/timeout) rather than a crypto failure.
         */
        void done(String plaintext, boolean unavailable);
    }

    interface SignCallback {
        /** @param event the fully signed event, or null on failure. */
        void done(JSONObject event);
    }

    /** Serializes signer work off the relay/callback threads. */
    protected final ExecutorService executor = Executors.newSingleThreadExecutor();

    /** NIP-44-decrypt {@code ciphertext} from {@code peerPk}'s conversation. */
    abstract void decrypt44(String peerPk, String ciphertext, DecryptCallback cb);

    /** Sign an event template as the user. */
    abstract void signEvent(int kind, String content, JSONArray tags, long createdAt, SignCallback cb);

    void close() {
        executor.shutdownNow();
    }

    /**
     * Build a signer from the sealed config the WebView shipped:
     * {@code {type:"key",sk} | {type:"amber",packageName} |
     * {type:"nip46",clientSk,bunkerPk,relays[]}}. Null when absent/invalid.
     */
    static NativeSigner from(Context context, OkHttpClient http, String userPubkey, JSONObject cfg) {
        if (cfg == null) return null;
        try {
            switch (cfg.optString("type")) {
                case "key": {
                    byte[] sk = ConcordCrypto.hexToBytes(cfg.optString("sk"));
                    return sk != null && sk.length == 32 ? new DirectKey(sk) : null;
                }
                case "amber": {
                    String pkg = cfg.optString("packageName");
                    return !pkg.isEmpty() && userPubkey != null
                            ? new Amber(context, pkg, userPubkey) : null;
                }
                case "nip46": {
                    byte[] clientSk = ConcordCrypto.hexToBytes(cfg.optString("clientSk"));
                    String bunkerPk = cfg.optString("bunkerPk");
                    JSONArray relays = cfg.optJSONArray("relays");
                    if (clientSk == null || clientSk.length != 32 || bunkerPk.isEmpty()
                            || relays == null || relays.length() == 0) return null;
                    java.util.ArrayList<String> urls = new java.util.ArrayList<>();
                    for (int i = 0; i < relays.length(); i++) {
                        String u = relays.optString(i);
                        if (!u.isEmpty()) urls.add(u);
                    }
                    return new Nip46(http, clientSk, bunkerPk, urls);
                }
                default:
                    return null;
            }
        } catch (Exception e) {
            Log.w(TAG, "signer config rejected", e);
            return null;
        }
    }

    // ── nsec: everything local ───────────────────────────────────────────────

    static final class DirectKey extends NativeSigner {
        private final byte[] sk;
        private final Map<String, byte[]> convCache = new ConcurrentHashMap<>();

        DirectKey(byte[] sk) {
            this.sk = sk;
        }

        private byte[] conv(String peerPk) {
            byte[] key = convCache.get(peerPk);
            if (key == null) {
                key = NostrCrypto.conversationKey(sk, peerPk);
                if (key != null) convCache.put(peerPk, key);
            }
            return key;
        }

        @Override
        void decrypt44(String peerPk, String ciphertext, DecryptCallback cb) {
            executor.execute(() -> {
                byte[] key = conv(peerPk);
                cb.done(key != null ? ConcordCrypto.decrypt(key, ciphertext) : null, false);
            });
        }

        @Override
        void signEvent(int kind, String content, JSONArray tags, long createdAt, SignCallback cb) {
            executor.execute(() -> {
                try {
                    cb.done(NostrCrypto.finalizeEvent(kind, content, tags, createdAt, sk));
                } catch (Exception e) {
                    cb.done(null);
                }
            });
        }
    }

    // ── NIP-55 signer app (Amber) via ContentResolver ────────────────────────

    static final class Amber extends NativeSigner {
        private final Context context;
        private final String packageName;
        private final String userPubkey;

        Amber(Context context, String packageName, String userPubkey) {
            this.context = context.getApplicationContext();
            this.packageName = packageName;
            this.userPubkey = userPubkey;
        }

        @Override
        void decrypt44(String peerPk, String ciphertext, DecryptCallback cb) {
            executor.execute(() -> {
                Uri uri = Uri.parse("content://" + packageName + ".NIP44_DECRYPT");
                try (Cursor cursor = context.getContentResolver().query(
                        uri, new String[]{ciphertext, peerPk, userPubkey}, null, null, null)) {
                    if (cursor == null) {
                        // Provider unavailable: signer app missing/killed or no
                        // background permission granted for this app.
                        cb.done(null, true);
                        return;
                    }
                    if (cursor.moveToFirst()) {
                        if (rejected(cursor)) {
                            cb.done(null, false); // explicit user/app policy — stay silent
                            return;
                        }
                        int idx = cursor.getColumnIndex("result");
                        if (idx >= 0) {
                            cb.done(cursor.getString(idx), false);
                            return;
                        }
                    }
                    cb.done(null, false);
                } catch (Exception e) {
                    cb.done(null, true);
                }
            });
        }

        @Override
        void signEvent(int kind, String content, JSONArray tags, long createdAt, SignCallback cb) {
            executor.execute(() -> {
                try {
                    String id = NostrCrypto.eventId(userPubkey, createdAt, kind, tags, content);
                    JSONObject ev = new JSONObject();
                    ev.put("id", id);
                    ev.put("pubkey", userPubkey);
                    ev.put("created_at", createdAt);
                    ev.put("kind", kind);
                    ev.put("tags", tags);
                    ev.put("content", content);
                    ev.put("sig", "");
                    Uri uri = Uri.parse("content://" + packageName + ".SIGN_EVENT");
                    try (Cursor cursor = context.getContentResolver().query(
                            uri, new String[]{ev.toString(), "", userPubkey}, "1", null, null)) {
                        if (cursor != null && cursor.moveToFirst() && !rejected(cursor)) {
                            int evIdx = cursor.getColumnIndex("event");
                            if (evIdx >= 0 && cursor.getString(evIdx) != null) {
                                cb.done(new JSONObject(cursor.getString(evIdx)));
                                return;
                            }
                            int sigIdx = cursor.getColumnIndex("result");
                            if (sigIdx >= 0 && cursor.getString(sigIdx) != null) {
                                ev.put("sig", cursor.getString(sigIdx));
                                cb.done(ev);
                                return;
                            }
                        }
                    }
                    cb.done(null);
                } catch (Exception e) {
                    cb.done(null);
                }
            });
        }

        private static boolean rejected(Cursor cursor) {
            int idx = cursor.getColumnIndex("rejected");
            if (idx < 0) return false;
            String v = cursor.getString(idx);
            return "1".equals(v) || "true".equalsIgnoreCase(v);
        }
    }

    // ── NIP-46 bunker session over the bunker relays ─────────────────────────

    static final class Nip46 extends NativeSigner {
        private static final long RPC_TIMEOUT_SEC = 25;
        private static final long RECONNECT_DELAY_SEC = 15;

        private interface RpcCallback {
            /** result/error mirror the NIP-46 response; unavailable = no answer. */
            void done(String result, String error, boolean unavailable);
        }

        private final OkHttpClient http;
        private final byte[] clientSk;
        private final String clientPk;
        private final String bunkerPk;
        private final byte[] conv;
        private final List<String> relays;
        private final List<WebSocket> sockets = new CopyOnWriteArrayList<>();
        private final Map<String, RpcCallback> pending = new ConcurrentHashMap<>();
        private final ScheduledExecutorService sched = Executors.newSingleThreadScheduledExecutor();
        private volatile boolean closed;

        Nip46(OkHttpClient http, byte[] clientSk, String bunkerPk, List<String> relays) {
            this.http = http;
            this.clientSk = clientSk;
            this.clientPk = NostrCrypto.pubkeyOf(clientSk);
            this.bunkerPk = bunkerPk;
            this.conv = NostrCrypto.conversationKey(clientSk, bunkerPk);
            this.relays = relays;
            for (String url : relays) connect(url);
        }

        private void connect(String url) {
            if (closed) return;
            Request req = new Request.Builder().url(url).build();
            http.newWebSocket(req, new WebSocketListener() {
                @Override
                public void onOpen(WebSocket ws, Response response) {
                    sockets.add(ws);
                    try {
                        // The session-lived response subscription (kind 24133
                        // from the bunker, p-tagged at our client key) — same
                        // shape as the WebView's transport.
                        JSONObject filter = new JSONObject()
                                .put("kinds", new JSONArray().put(24133))
                                .put("authors", new JSONArray().put(bunkerPk))
                                .put("#p", new JSONArray().put(clientPk));
                        ws.send(new JSONArray().put("REQ").put("nip46").put(filter).toString());
                    } catch (Exception ignored) {
                    }
                }

                @Override
                public void onMessage(WebSocket ws, String text) {
                    handleMessage(text);
                }

                @Override
                public void onFailure(WebSocket ws, Throwable t, Response response) {
                    sockets.remove(ws);
                    scheduleReconnect(url);
                }

                @Override
                public void onClosed(WebSocket ws, int code, String reason) {
                    sockets.remove(ws);
                    scheduleReconnect(url);
                }
            });
        }

        private void scheduleReconnect(String url) {
            if (closed) return;
            try {
                sched.schedule(() -> connect(url), RECONNECT_DELAY_SEC, TimeUnit.SECONDS);
            } catch (Exception ignored) {
                // executor already shut down
            }
        }

        private void handleMessage(String text) {
            try {
                JSONArray msg = new JSONArray(text);
                if (!"EVENT".equals(msg.optString(0))) return;
                JSONObject ev = msg.optJSONObject(2);
                if (ev == null || ev.optInt("kind") != 24133) return;
                if (!bunkerPk.equals(ev.optString("pubkey"))) return;
                String plain = ConcordCrypto.decrypt(conv, ev.optString("content"));
                if (plain == null) return; // nip04-era bunker — RPC times out and degrades gracefully
                JSONObject res = new JSONObject(plain);
                RpcCallback cb = pending.remove(res.optString("id"));
                if (cb == null) return;
                String error = res.isNull("error") ? null : res.optString("error");
                cb.done(res.isNull("result") ? null : res.optString("result"), error, false);
            } catch (Exception ignored) {
            }
        }

        private void rpc(String method, JSONArray params, RpcCallback cb) {
            executor.execute(() -> {
                try {
                    String id = NostrCrypto.bytesToHex(randomBytes(16));
                    JSONObject payload = new JSONObject()
                            .put("id", id).put("method", method).put("params", params);
                    String content = ConcordCrypto.encrypt(conv, payload.toString());
                    if (content == null) {
                        cb.done(null, null, true);
                        return;
                    }
                    JSONObject ev = NostrCrypto.finalizeEvent(24133, content,
                            new JSONArray().put(new JSONArray().put("p").put(bunkerPk)),
                            System.currentTimeMillis() / 1000, clientSk);
                    String frame = new JSONArray().put("EVENT").put(ev).toString();
                    int sent = 0;
                    for (WebSocket ws : sockets) {
                        if (ws.send(frame)) sent++;
                    }
                    if (sent == 0) {
                        cb.done(null, null, true);
                        return;
                    }
                    pending.put(id, cb);
                    sched.schedule(() -> {
                        RpcCallback timedOut = pending.remove(id);
                        if (timedOut != null) timedOut.done(null, null, true);
                    }, RPC_TIMEOUT_SEC, TimeUnit.SECONDS);
                } catch (Exception e) {
                    cb.done(null, null, true);
                }
            });
        }

        @Override
        void decrypt44(String peerPk, String ciphertext, DecryptCallback cb) {
            rpc("nip44_decrypt", new JSONArray().put(peerPk).put(ciphertext),
                    (result, error, unavailable) -> {
                        if (unavailable) cb.done(null, true);
                        else if (error != null || result == null) cb.done(null, false);
                        else cb.done(result, false);
                    });
        }

        @Override
        void signEvent(int kind, String content, JSONArray tags, long createdAt, SignCallback cb) {
            try {
                JSONObject tmpl = new JSONObject()
                        .put("kind", kind)
                        .put("content", content)
                        .put("tags", tags)
                        .put("created_at", createdAt);
                rpc("sign_event", new JSONArray().put(tmpl.toString()),
                        (result, error, unavailable) -> {
                            try {
                                cb.done(result != null ? new JSONObject(result) : null);
                            } catch (Exception e) {
                                cb.done(null);
                            }
                        });
            } catch (Exception e) {
                cb.done(null);
            }
        }

        @Override
        void close() {
            closed = true;
            for (WebSocket ws : sockets) {
                try {
                    ws.close(1000, "signer closed");
                } catch (Exception ignored) {
                }
            }
            sockets.clear();
            for (RpcCallback cb : pending.values()) cb.done(null, null, true);
            pending.clear();
            sched.shutdownNow();
            super.close();
        }

        private static byte[] randomBytes(int n) {
            byte[] out = new byte[n];
            new java.security.SecureRandom().nextBytes(out);
            return out;
        }
    }
}
