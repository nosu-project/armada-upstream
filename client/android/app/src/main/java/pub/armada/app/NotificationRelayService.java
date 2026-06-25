package pub.armada.app;

import android.app.ForegroundServiceStartNotAllowedException;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.net.Uri;
import android.os.Build;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.PorterDuff;
import android.graphics.PorterDuffXfermode;
import android.graphics.Rect;
import android.graphics.RectF;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;

import androidx.core.app.NotificationCompat;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;

import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

/**
 * Foreground service that holds a persistent Nostr REQ subscription to the
 * user's relay(s) and posts a native notification the instant a matching event
 * arrives. This is the de-Googled instant-push path — no FCM, no Web Push, no
 * polling.
 *
 * One WebSocket per relay is kept open with a live REQ:
 *   - {@code {kinds:[9], #h:[...groupIds], since}}      group messages
 *   - {@code {kinds:[7,1111,4], #p:[userPubkey], since}} reactions/replies/DMs
 *
 * On each EVENT we apply the user's prefs (mention vs all-group, per-type
 * toggles), dedupe by id, skip self, and {@code showNotification}.
 *
 * Resilience:
 *   - Exponential reconnect backoff per relay (1s → 5min cap), reset on open.
 *   - Network-aware: reconnects immediately when connectivity returns.
 *   - Re-reads config (login/logout/relay/group changes) via a SharedPreferences
 *     listener and rebuilds subscriptions live.
 */
public class NotificationRelayService extends Service {

    private static final String TAG = "ArmadaNotifSvc";
    private static final String SVC_CHANNEL_ID = "armada_background_service";
    private static final String MSG_CHANNEL_ID = "armada_notifications";
    private static final int FOREGROUND_ID = 1;
    private static final int MAX_NOTIFICATION_ID = 2147483646;
    private static final int CONTENT_CAP = 140;

    private static final long INITIAL_BACKOFF_MS = 1_000;
    private static final long MAX_BACKOFF_MS = 5 * 60 * 1_000;

    private OkHttpClient httpClient;
    private final Handler handler = new Handler(Looper.getMainLooper());

    private ConnectivityManager.NetworkCallback networkCallback;
    private SharedPreferences.OnSharedPreferenceChangeListener configListener;

    // Active connections, one per relay URL.
    private final List<RelayConnection> connections = new ArrayList<>();

    // Current config snapshot.
    private String userPubkey;
    private final List<String> relayUrls = new ArrayList<>();
    private final Set<String> groupIds = new LinkedHashSet<>();
    private final Set<String> dmRelays = new LinkedHashSet<>();
    private JSONObject prefs = new JSONObject();
    // Concord (E2E) channel subscriptions, keyed for fast lookup:
    //   zToName: #z pseudonym (hex) → "Community / #channel" display name
    //   zToUrl:  #z pseudonym (hex) → in-app deep-link (/c/<communityId>)
    //   relayToZs: relay url → the #z values that live on that relay
    private final java.util.Map<String, String> zToName = new java.util.HashMap<>();
    private final java.util.Map<String, String> zToUrl = new java.util.HashMap<>();
    private final java.util.Map<String, Set<String>> relayToZs = new java.util.HashMap<>();
    // De-dupe notifications across relays/reconnects for this service lifetime.
    private final Set<String> notifiedIds = new HashSet<>();
    // Connect time; we only notify for events at/after this to avoid backfill spam.
    private long sinceSec;

    // pubkey → resolved profile (kind 0). Cached for the service lifetime so we
    // don't re-fetch the same author's name/avatar on every notification.
    private final Map<String, Profile> profileCache = new HashMap<>();
    // pubkey → waiters for an in-flight kind-0 fetch, so concurrent events for
    // the same author share a single REQ.
    private final Map<String, List<ProfileCallback>> pendingProfiles = new HashMap<>();
    // avatar URL → circle-cropped bitmap, decoded once and reused.
    private final Map<String, Bitmap> avatarCache = new HashMap<>();
    // Largest dimension (px) we keep for an avatar large-icon.
    private static final int AVATAR_PX = 128;
    // How long to wait for a kind-0 profile before firing a name-less fallback.
    private static final long PROFILE_TIMEOUT_MS = 4_000;

    /** Minimal author profile: display name + avatar URL (either may be null). */
    private static final class Profile {
        final String name;
        final String picture;
        Profile(String name, String picture) {
            this.name = name;
            this.picture = picture;
        }
    }

    private interface ProfileCallback {
        void onProfile(Profile profile);
    }

    // Live instance so the plugin can route a signed AUTH event back to us.
    private static NotificationRelayService instance;

    /**
     * Called by the plugin once the WebView has signed a NIP-42 challenge.
     * Routes the kind-22242 event to the matching relay connection.
     */
    static void submitAuth(String relayUrl, String eventJson) {
        NotificationRelayService svc = instance;
        if (svc == null) return;
        svc.handler.post(() -> svc.deliverAuth(relayUrl, eventJson));
    }

    private void deliverAuth(String relayUrl, String eventJson) {
        for (RelayConnection rc : connections) {
            if (rc.relayUrl.equals(relayUrl)) {
                rc.sendAuth(eventJson);
                return;
            }
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        createChannels();
        try {
            startForeground(FOREGROUND_ID, buildForegroundNotification());
        } catch (Exception e) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                    && e instanceof ForegroundServiceStartNotAllowedException) {
                Log.w(TAG, "Foreground start not allowed, stopping.");
                stopSelf();
                return;
            }
            throw e;
        }

        httpClient = new OkHttpClient.Builder()
                .connectTimeout(10, TimeUnit.SECONDS)
                .pingInterval(30, TimeUnit.SECONDS) // keep the socket alive + detect drops
                .build();

        sinceSec = System.currentTimeMillis() / 1000;
        registerNetworkCallback();
        registerConfigListener();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        loadConfigAndReconnect();
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        if (instance == this) instance = null;
        closeAllConnections();
        unregisterNetworkCallback();
        unregisterConfigListener();
        handler.removeCallbacksAndMessages(null);
        if (httpClient != null) {
            httpClient.dispatcher().executorService().shutdownNow();
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    // ── Config ────────────────────────────────────────────────────────────────

    private void loadConfigAndReconnect() {
        SharedPreferences sp = getSharedPreferences(ArmadaNotificationPlugin.PREFS_NAME, Context.MODE_PRIVATE);
        if (!sp.getBoolean("enabled", false)) {
            Log.d(TAG, "Disabled in config; stopping.");
            stopSelf();
            return;
        }
        userPubkey = sp.getString("userPubkey", null);
        relayUrls.clear();
        relayUrls.addAll(parseStringArray(sp.getString("relayUrls", null)));
        groupIds.clear();
        groupIds.addAll(parseStringArray(sp.getString("groupIds", null)));
        dmRelays.clear();
        dmRelays.addAll(parseStringArray(sp.getString("dmRelays", null)));
        try {
            String p = sp.getString("prefs", null);
            prefs = p != null ? new JSONObject(p) : new JSONObject();
        } catch (JSONException e) {
            prefs = new JSONObject();
        }
        parseConcordSubs(sp.getString("concordSubs", null));

        // The relays to connect to: NIP-29 group relays ∪ DM relays ∪ Concord relays.
        Set<String> allRelays = new LinkedHashSet<>(relayUrls);
        allRelays.addAll(dmRelays);
        allRelays.addAll(relayToZs.keySet());

        if (userPubkey == null || allRelays.isEmpty()) {
            Log.d(TAG, "No pubkey/relays; not connecting.");
            closeAllConnections();
            return;
        }

        // Rebuild all connections with the current filters.
        closeAllConnections();
        for (String url : allRelays) {
            RelayConnection rc = new RelayConnection(url);
            connections.add(rc);
            rc.connect();
        }
    }

    /**
     * Parse the Concord subscriptions JSON
     * ([{relays:[],zs:[],communityName,channelName}, …]) into the lookup maps:
     * z→display-name and relay→{z…}. Concord messages are E2E-encrypted, so we
     * only ever fire a generic "New message in <community>/#<channel>".
     */
    private void parseConcordSubs(String json) {
        zToName.clear();
        zToUrl.clear();
        relayToZs.clear();
        if (json == null) return;
        try {
            JSONArray arr = new JSONArray(json);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject sub = arr.optJSONObject(i);
                if (sub == null) continue;
                String community = sub.optString("communityName", "Community");
                String channel = sub.optString("channelName", "channel");
                String communityId = sub.optString("communityId", "");
                String name = community + " / #" + channel;
                String url = communityId.isEmpty() ? "/" : "/c/" + uriEncode(communityId);
                JSONArray zs = sub.optJSONArray("zs");
                JSONArray relays = sub.optJSONArray("relays");
                if (zs == null || relays == null) continue;

                List<String> zList = new ArrayList<>();
                for (int j = 0; j < zs.length(); j++) {
                    String z = zs.optString(j);
                    if (z != null && !z.isEmpty()) {
                        zList.add(z);
                        zToName.put(z, name);
                        zToUrl.put(z, url);
                    }
                }
                for (int j = 0; j < relays.length(); j++) {
                    String relay = relays.optString(j);
                    if (relay == null || relay.isEmpty()) continue;
                    Set<String> set = relayToZs.get(relay);
                    if (set == null) {
                        set = new LinkedHashSet<>();
                        relayToZs.put(relay, set);
                    }
                    set.addAll(zList);
                }
            }
        } catch (JSONException e) {
            Log.w(TAG, "Failed to parse concordSubs", e);
        }
    }

    // ── Per-relay connection ────────────────────────────────────────────────

    private class RelayConnection {
        final String relayUrl;
        WebSocket ws;
        long backoffMs = INITIAL_BACKOFF_MS;
        boolean closed = false;
        final String subGroups = "ag-" + Long.toHexString(System.nanoTime());
        final String subDirect = "ad-" + Long.toHexString(System.nanoTime() + 1);
        final String subConcord = "ac-" + Long.toHexString(System.nanoTime() + 2);
        final String subDm = "am-" + Long.toHexString(System.nanoTime() + 3);
        // Prefix for one-shot kind-0 profile lookups (sub id = prefix + pubkey).
        final String profilePrefix = "ap-" + Long.toHexString(System.nanoTime() + 4) + "-";
        // id of the last kind-22242 we sent; used to match the AUTH OK so a
        // relay's OK for some other event can't trigger a REQ re-send.
        String authEventId;

        RelayConnection(String relayUrl) {
            this.relayUrl = relayUrl;
        }

        void connect() {
            if (closed || !isNetworkAvailable()) return;
            Request request = new Request.Builder().url(relayUrl).build();
            ws = httpClient.newWebSocket(request, new WebSocketListener() {
                @Override
                public void onOpen(WebSocket webSocket, Response response) {
                    backoffMs = INITIAL_BACKOFF_MS;
                    if (BuildConfig.DEBUG) Log.d(TAG, "WS open: " + relayUrl);
                    sendReqs(webSocket);
                }

                @Override
                public void onMessage(WebSocket webSocket, String text) {
                    handler.post(() -> onRelayMessage(text, relayUrl));
                }

                @Override
                public void onFailure(WebSocket webSocket, Throwable t, Response response) {
                    Log.w(TAG, "WS failure (" + relayUrl + "): " + t.getMessage());
                    scheduleReconnect();
                }

                @Override
                public void onClosed(WebSocket webSocket, int code, String reason) {
                    if (!closed) scheduleReconnect();
                }
            });
        }

        void sendReqs(WebSocket webSocket) {
            try {
                if (relayUrls.contains(relayUrl) && !groupIds.isEmpty()) {
                    // Group messages: kind 9 in the user's joined groups.
                    JSONObject f = new JSONObject();
                    f.put("kinds", new JSONArray().put(9));
                    JSONArray h = new JSONArray();
                    for (String id : groupIds) h.put(id);
                    f.put("#h", h);
                    f.put("since", sinceSec);
                    webSocket.send(reqMessage(subGroups, f));

                    // Reactions/replies to me, scoped to my joined groups so the
                    // query is a valid NIP-29 request (relays reject a #p-only
                    // filter with "must have 'h','e' or 'a' tag").
                    JSONObject f2 = new JSONObject();
                    f2.put("kinds", new JSONArray().put(7).put(1111));
                    JSONArray h2 = new JSONArray();
                    for (String id : groupIds) h2.put(id);
                    f2.put("#h", h2);
                    f2.put("#p", new JSONArray().put(userPubkey));
                    f2.put("since", sinceSec);
                    webSocket.send(reqMessage(subDirect, f2));
                }
                // Direct messages (kind 4) addressed to me, on the DM/app relays
                // (NOT the NIP-29 group relays — DMs don't live there).
                if (dmRelays.contains(relayUrl)) {
                    JSONObject f4 = new JSONObject();
                    f4.put("kinds", new JSONArray().put(4));
                    f4.put("#p", new JSONArray().put(userPubkey));
                    f4.put("since", sinceSec);
                    webSocket.send(reqMessage(subDm, f4));
                }
                // Concord (E2E) channel messages on this relay, by #z pseudonym.
                Set<String> zs = relayToZs.get(relayUrl);
                if (zs != null && !zs.isEmpty()) {
                    JSONObject f3 = new JSONObject();
                    f3.put("kinds", new JSONArray().put(3300));
                    JSONArray z = new JSONArray();
                    for (String v : zs) z.put(v);
                    f3.put("#z", z);
                    f3.put("since", sinceSec);
                    webSocket.send(reqMessage(subConcord, f3));
                }
            } catch (JSONException e) {
                Log.w(TAG, "Failed to build REQ", e);
            }
        }

        void sendAuth(String eventJson) {
            if (ws == null) return;
            try {
                JSONObject event = new JSONObject(eventJson);
                authEventId = event.optString("id", null);
                JSONArray auth = new JSONArray();
                auth.put("AUTH");
                auth.put(event);
                ws.send(auth.toString());
                if (BuildConfig.DEBUG) Log.d(TAG, "Sent AUTH to " + relayUrl);
            } catch (JSONException e) {
                Log.w(TAG, "Failed to send AUTH", e);
            }
        }

        /**
         * Fire a one-shot kind-0 REQ for {@code pubkey}. The matching EVENT is
         * picked up in {@link #onRelayMessage} (sub id starts with
         * {@link #profilePrefix}); the relay's EOSE / our timeout closes it.
         */
        void fetchProfile(String pubkey) {
            if (closed || ws == null) return;
            try {
                JSONObject f = new JSONObject();
                f.put("kinds", new JSONArray().put(0));
                f.put("authors", new JSONArray().put(pubkey));
                f.put("limit", 1);
                ws.send(reqMessage(profilePrefix + pubkey, f));
            } catch (JSONException e) {
                if (BuildConfig.DEBUG) Log.w(TAG, "Failed to build profile REQ", e);
            }
        }

        void closeSub(String subId) {
            if (ws == null) return;
            try {
                JSONArray close = new JSONArray();
                close.put("CLOSE");
                close.put(subId);
                ws.send(close.toString());
            } catch (Exception ignored) {}
        }

        void scheduleReconnect() {
            if (closed) return;
            if (ws != null) {
                ws = null;
            }
            long delay = backoffMs;
            backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
            handler.postDelayed(this::connect, delay);
        }

        void close() {
            closed = true;
            if (ws != null) {
                try { ws.close(1000, "service reconfigured"); } catch (Exception ignored) {}
                ws = null;
            }
        }

        void resetAndConnectNow() {
            backoffMs = INITIAL_BACKOFF_MS;
            if (ws == null) connect();
        }
    }

    private String reqMessage(String subId, JSONObject filter) throws JSONException {
        JSONArray req = new JSONArray();
        req.put("REQ");
        req.put(subId);
        req.put(filter);
        return req.toString();
    }

    private void onRelayMessage(String text, String relayUrl) {
        try {
            JSONArray msg = new JSONArray(text);
            String type = msg.optString(0);
            if ("AUTH".equals(type)) {
                // NIP-42 challenge. Ask the WebView's signer (handles nsec /
                // bunker / extension) to sign a kind-22242; it comes back via
                // ArmadaNotificationPlugin.submitAuth → deliverAuth.
                String challenge = msg.optString(1);
                if (BuildConfig.DEBUG) Log.d(TAG, "AUTH challenge from " + relayUrl);
                boolean bridged = ArmadaNotificationPlugin.emitAuthChallenge(relayUrl, challenge);
                if (!bridged) {
                    Log.w(TAG, "No bridge (WebView down) — can't AUTH " + relayUrl);
                }
                return;
            }
            if ("EOSE".equals(type)) {
                String sub = msg.optString(1);
                if (BuildConfig.DEBUG) Log.d(TAG, "EOSE from " + relayUrl + " sub=" + sub);
                // A profile lookup that returned no kind-0: resolve waiters with
                // null so the notification fires name-less rather than hanging.
                String pk = profilePubkeyForSub(sub);
                if (pk != null) {
                    closeProfileSub(relayUrl, sub);
                    resolveProfile(pk, null);
                }
                return;
            }
            if ("CLOSED".equals(type)) {
                Log.w(TAG, "CLOSED from " + relayUrl + " sub=" + msg.optString(1) + " reason=" + msg.optString(2));
                return;
            }
            if ("OK".equals(type)) {
                // AUTH ack (["OK", <event-id>, true/false, msg]). On success,
                // and only when the id matches the kind-22242 we sent, the
                // matching connection re-sends its REQs.
                String okId = msg.optString(1);
                boolean ok = msg.optBoolean(2, false);
                if (BuildConfig.DEBUG) Log.d(TAG, "OK from " + relayUrl + " ok=" + ok + " " + msg.optString(3));
                if (ok) {
                    for (RelayConnection rc : connections) {
                        if (rc.relayUrl.equals(relayUrl) && rc.ws != null
                                && okId.equals(rc.authEventId)) {
                            rc.authEventId = null;
                            rc.sendReqs(rc.ws);
                        }
                    }
                }
                return;
            }
            if (!"EVENT".equals(type)) return;
            String sub = msg.optString(1);
            JSONObject event = msg.optJSONObject(2);
            if (event == null) return;
            // A kind-0 from a profile lookup: cache it and resolve waiters.
            String pk = profilePubkeyForSub(sub);
            if (pk != null) {
                closeProfileSub(relayUrl, sub);
                resolveProfile(pk, parseProfile(event));
                return;
            }
            handleEvent(event, relayUrl);
        } catch (Exception e) {
            // Ignore non-JSON / unexpected frames.
        }
    }

    // ── Profile (kind 0) resolution ───────────────────────────────────────────

    /**
     * If {@code sub} is one of our one-shot profile lookups, return the pubkey
     * it was issued for; otherwise null. Matches against each connection's
     * per-connection profile prefix.
     */
    private String profilePubkeyForSub(String sub) {
        if (sub == null || sub.isEmpty()) return null;
        for (RelayConnection rc : connections) {
            if (sub.startsWith(rc.profilePrefix)) {
                return sub.substring(rc.profilePrefix.length());
            }
        }
        return null;
    }

    private void closeProfileSub(String relayUrl, String sub) {
        for (RelayConnection rc : connections) {
            if (rc.relayUrl.equals(relayUrl)) {
                rc.closeSub(sub);
                return;
            }
        }
    }

    /**
     * Resolve {@code pubkey} to a profile, then invoke {@code cb} (always on the
     * main handler). Serves from cache when present, otherwise issues a kind-0
     * REQ on {@code relayUrl} and waits up to {@link #PROFILE_TIMEOUT_MS}.
     */
    private void resolveAuthor(String pubkey, String relayUrl, ProfileCallback cb) {
        Profile cached = profileCache.get(pubkey);
        if (cached != null) {
            cb.onProfile(cached);
            return;
        }
        List<ProfileCallback> waiters = pendingProfiles.get(pubkey);
        if (waiters != null) {
            waiters.add(cb); // a fetch is already in flight; piggyback on it
            return;
        }
        waiters = new ArrayList<>();
        waiters.add(cb);
        pendingProfiles.put(pubkey, waiters);

        RelayConnection rc = connectionFor(relayUrl);
        if (rc == null) {
            resolveProfile(pubkey, null);
            return;
        }
        rc.fetchProfile(pubkey);
        // Fallback if the relay never answers (no kind-0 / slow).
        handler.postDelayed(() -> {
            if (pendingProfiles.containsKey(pubkey)) {
                resolveProfile(pubkey, null);
            }
        }, PROFILE_TIMEOUT_MS);
    }

    /** Cache the result (if any) and flush all pending waiters for this pubkey. */
    private void resolveProfile(String pubkey, Profile profile) {
        if (profile != null) {
            profileCache.put(pubkey, profile);
        }
        List<ProfileCallback> waiters = pendingProfiles.remove(pubkey);
        if (waiters == null) return;
        for (ProfileCallback cb : waiters) {
            cb.onProfile(profile);
        }
    }

    private RelayConnection connectionFor(String relayUrl) {
        for (RelayConnection rc : connections) {
            if (rc.relayUrl.equals(relayUrl) && rc.ws != null) return rc;
        }
        return null;
    }

    /** Parse a kind-0 event's content into a {@link Profile} (name + picture). */
    private static Profile parseProfile(JSONObject event) {
        try {
            JSONObject meta = new JSONObject(event.optString("content", "{}"));
            String name = meta.optString("name", null);
            if (name == null || name.isEmpty()) {
                name = meta.optString("display_name", null);
            }
            if (name != null && name.isEmpty()) name = null;
            String picture = meta.optString("picture", null);
            if (picture != null && picture.isEmpty()) picture = null;
            return new Profile(name, picture);
        } catch (JSONException e) {
            return new Profile(null, null);
        }
    }

    // ── Event → notification ──────────────────────────────────────────────────

    private void handleEvent(JSONObject event, String relayUrl) {
        String id = event.optString("id");
        if (id.isEmpty() || notifiedIds.contains(id)) {
            return;
        }

        int kind = event.optInt("kind");

        // Concord (E2E): we can't decrypt, so fire a generic notification keyed
        // off the #z pseudonym → community/channel name. Outer events are signed
        // by ephemeral keys, so there's no author/self check to apply.
        if (kind == 3300) {
            String z = tagValue(event, "z");
            String name = z != null ? zToName.get(z) : null;
            if (name == null) {
                return;
            }
            String url = zToUrl.get(z);
            long cts = event.optLong("created_at", 0);
            if (cts + 1 > sinceSec) sinceSec = cts + 1;
            notifiedIds.add(id);
            if (BuildConfig.DEBUG) Log.d(TAG, "NOTIFY concord: " + name);
            showNotification(hashId(id), name, "New message", url != null ? url : "/");
            return;
        }

        String author = event.optString("pubkey");
        if (author.equals(userPubkey)) {
            return;
        }

        boolean mentionsMe = pTags(event).contains(userPubkey);

        if (!wantsNotification(kind, mentionsMe)) {
            return;
        }

        // Claim the event now so the async profile fetch can't double-fire, and
        // advance `since` so reconnects don't replay it.
        notifiedIds.add(id);
        long ts = event.optLong("created_at", 0);
        if (ts + 1 > sinceSec) sinceSec = ts + 1;

        final int notifId = hashId(id);
        final boolean mention = mentionsMe;
        // Resolve the author's name + avatar, then build a "<name> did X" body.
        resolveAuthor(author, relayUrl, profile -> {
            String name = displayName(profile, author);
            String picture = profile != null ? profile.picture : null;
            String title;
            String body;
            String url;
            switch (kind) {
                case 9: {
                    String groupId = tagValue(event, "h");
                    title = mention ? name + " mentioned you" : name;
                    body = truncate(event.optString("content"));
                    if (body.isEmpty()) body = mention ? "Mentioned you" : "Sent a message";
                    url = groupId != null
                            ? "/s/" + relayToRouteParam(relayUrl) + "/" + uriEncode(groupId)
                            : "/";
                    break;
                }
                case 7: {
                    title = name;
                    body = "Reacted " + reactionEmoji(event) + " to your message";
                    String groupId = tagValue(event, "h");
                    url = groupId != null
                            ? "/s/" + relayToRouteParam(relayUrl) + "/" + uriEncode(groupId)
                            : "/";
                    break;
                }
                case 1111: {
                    title = name + " replied to you";
                    body = truncate(event.optString("content"));
                    if (body.isEmpty()) body = "Replied to you";
                    String groupId = tagValue(event, "h");
                    url = groupId != null
                            ? "/s/" + relayToRouteParam(relayUrl) + "/" + uriEncode(groupId)
                            : "/";
                    break;
                }
                case 4:
                    title = name;
                    // kind-4 DMs are NIP-04 encrypted; the service has no key.
                    body = "Sent you a direct message";
                    url = "/dms/" + author;
                    break;
                default:
                    return;
            }
            if (BuildConfig.DEBUG) Log.d(TAG, "NOTIFY kind=" + kind + " title=" + title);
            showNotification(notifId, title, body, url, picture);
        });
    }

    /** Display name from a resolved profile, falling back to a short npub-ish id. */
    private static String displayName(Profile profile, String pubkey) {
        if (profile != null && profile.name != null && !profile.name.isEmpty()) {
            return profile.name;
        }
        if (pubkey != null && pubkey.length() >= 8) {
            return "User " + pubkey.substring(0, 8);
        }
        return "Someone";
    }

    /**
     * Map a kind-7 reaction's content to a display emoji, mirroring the web
     * client (useReactions.ts): "+"/empty → 👍, "-" → 👎, ":shortcode:" → the
     * bare shortcode, otherwise the content verbatim.
     */
    private static String reactionEmoji(JSONObject event) {
        String c = event.optString("content", "").trim();
        if (c.isEmpty() || c.equals("+")) return "👍";
        if (c.equals("-")) return "👎";
        if (c.length() >= 2 && c.startsWith(":") && c.endsWith(":")) {
            return c.substring(1, c.length() - 1);
        }
        return c;
    }

    private boolean wantsNotification(int kind, boolean mentionsMe) {
        switch (kind) {
            case 9:
                if (mentionsMe) return prefBool("mentions", true);
                return prefBool("allGroupMessages", false);
            case 7:
                return prefBool("reactions", true);
            case 1111:
                return prefBool("replies", true);
            case 4:
                return prefBool("directMessages", true);
        }
        return false;
    }

    private boolean prefBool(String key, boolean dflt) {
        return prefs.optBoolean(key, dflt);
    }

    // ── Notifications ───────────────────────────────────────────────────────

    /** Avatar-less notification (Concord E2E, where there's no resolvable author). */
    private void showNotification(int id, String title, String body, String url) {
        postNotification(id, title, body, url, null);
    }

    /**
     * Notification with an optional avatar URL for the large icon. The avatar is
     * fetched + circle-cropped off the main thread; the notification posts
     * immediately without it if the fetch is slow or fails.
     */
    private void showNotification(int id, String title, String body, String url, String pictureUrl) {
        if (pictureUrl == null || pictureUrl.isEmpty()) {
            postNotification(id, title, body, url, null);
            return;
        }
        Bitmap cached = avatarCache.get(pictureUrl);
        if (cached != null) {
            postNotification(id, title, body, url, cached);
            return;
        }
        // Post now (no avatar), then re-post with the avatar once it's loaded so
        // the notification isn't delayed by image I/O.
        postNotification(id, title, body, url, null);
        fetchAvatar(pictureUrl, bmp -> {
            if (bmp != null) postNotification(id, title, body, url, bmp);
        });
    }

    private void postNotification(int id, String title, String body, String url, Bitmap largeIcon) {
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;

        Intent intent = new Intent(this, MainActivity.class);
        intent.setData(Uri.parse("armada://open" + url));
        intent.putExtra("armada_path", url);
        intent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi = PendingIntent.getActivity(
                this, id, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        NotificationCompat.Builder b = new NotificationCompat.Builder(this, MSG_CHANNEL_ID)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setSmallIcon(R.drawable.ic_stat_armada)
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .setContentIntent(pi)
                .setAutoCancel(true);
        if (largeIcon != null) b.setLargeIcon(largeIcon);
        manager.notify(id, b.build());
    }

    private interface BitmapCallback {
        void onBitmap(Bitmap bitmap);
    }

    /**
     * Fetch an avatar URL, downscale + circle-crop it to {@link #AVATAR_PX}, and
     * deliver the bitmap on the main handler. Best-effort: null on any failure.
     * Results are cached by URL for the service lifetime.
     */
    private void fetchAvatar(String url, BitmapCallback cb) {
        Request request = new Request.Builder().url(url).build();
        httpClient.newCall(request).enqueue(new Callback() {
            @Override
            public void onFailure(Call call, IOException e) {
                if (BuildConfig.DEBUG) Log.d(TAG, "avatar fetch failed: " + e.getMessage());
                handler.post(() -> cb.onBitmap(null));
            }

            @Override
            public void onResponse(Call call, Response response) {
                Bitmap circle = null;
                try {
                    if (response.isSuccessful() && response.body() != null) {
                        byte[] bytes = response.body().bytes();
                        Bitmap raw = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
                        circle = circleCrop(raw);
                    }
                } catch (Exception e) {
                    if (BuildConfig.DEBUG) Log.d(TAG, "avatar decode failed: " + e.getMessage());
                } finally {
                    response.close();
                }
                final Bitmap result = circle;
                handler.post(() -> {
                    if (result != null) avatarCache.put(url, result);
                    cb.onBitmap(result);
                });
            }
        });
    }

    /** Center-crop a bitmap to a square, scale to AVATAR_PX, and mask to a circle. */
    private static Bitmap circleCrop(Bitmap src) {
        if (src == null) return null;
        int size = Math.min(src.getWidth(), src.getHeight());
        if (size <= 0) return null;
        int left = (src.getWidth() - size) / 2;
        int top = (src.getHeight() - size) / 2;

        Bitmap output = Bitmap.createBitmap(AVATAR_PX, AVATAR_PX, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(output);
        Paint paint = new Paint();
        paint.setAntiAlias(true);
        float r = AVATAR_PX / 2f;
        canvas.drawCircle(r, r, r, paint);
        paint.setXfermode(new PorterDuffXfermode(PorterDuff.Mode.SRC_IN));
        Rect srcRect = new Rect(left, top, left + size, top + size);
        RectF dstRect = new RectF(0, 0, AVATAR_PX, AVATAR_PX);
        canvas.drawBitmap(src, srcRect, dstRect, paint);
        return output;
    }

    private Notification buildForegroundNotification() {
        Intent open = new Intent(this, MainActivity.class);
        PendingIntent pi = PendingIntent.getActivity(
                this, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new NotificationCompat.Builder(this, SVC_CHANNEL_ID)
                .setContentTitle("Armada")
                .setContentText("Connected for instant notifications")
                .setSmallIcon(R.drawable.ic_stat_armada)
                .setContentIntent(pi)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setOngoing(true)
                .setSilent(true)
                .build();
    }

    private void createChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager m = getSystemService(NotificationManager.class);
        if (m == null) return;

        NotificationChannel svc = new NotificationChannel(
                SVC_CHANNEL_ID, "Background connection", NotificationManager.IMPORTANCE_LOW);
        svc.setDescription("Keeps Armada connected for instant notifications");
        svc.setShowBadge(false);
        m.createNotificationChannel(svc);

        NotificationChannel msg = new NotificationChannel(
                MSG_CHANNEL_ID, "Notifications", NotificationManager.IMPORTANCE_DEFAULT);
        msg.setDescription("Mentions, replies, reactions and direct messages");
        m.createNotificationChannel(msg);
    }

    // ── Network monitoring ────────────────────────────────────────────────────

    private void registerNetworkCallback() {
        ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) return;
        NetworkRequest req = new NetworkRequest.Builder()
                .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                .build();
        networkCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network network) {
                handler.post(() -> {
                    for (RelayConnection rc : connections) rc.resetAndConnectNow();
                });
            }
        };
        try { cm.registerNetworkCallback(req, networkCallback); } catch (Exception ignored) {}
    }

    private void unregisterNetworkCallback() {
        if (networkCallback == null) return;
        ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm != null) {
            try { cm.unregisterNetworkCallback(networkCallback); } catch (Exception ignored) {}
        }
    }

    private boolean isNetworkAvailable() {
        ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) return false;
        Network n = cm.getActiveNetwork();
        if (n == null) return false;
        NetworkCapabilities c = cm.getNetworkCapabilities(n);
        return c != null && c.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
    }

    // ── Config change listener ──────────────────────────────────────────────

    private void registerConfigListener() {
        SharedPreferences sp = getSharedPreferences(ArmadaNotificationPlugin.PREFS_NAME, Context.MODE_PRIVATE);
        configListener = (sharedPreferences, key) -> handler.post(this::loadConfigAndReconnect);
        sp.registerOnSharedPreferenceChangeListener(configListener);
    }

    private void unregisterConfigListener() {
        if (configListener == null) return;
        SharedPreferences sp = getSharedPreferences(ArmadaNotificationPlugin.PREFS_NAME, Context.MODE_PRIVATE);
        sp.unregisterOnSharedPreferenceChangeListener(configListener);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private void closeAllConnections() {
        for (RelayConnection rc : connections) rc.close();
        connections.clear();
    }

    private static List<String> parseStringArray(String json) {
        List<String> out = new ArrayList<>();
        if (json == null) return out;
        try {
            JSONArray arr = new JSONArray(json);
            for (int i = 0; i < arr.length(); i++) out.add(arr.getString(i));
        } catch (JSONException ignored) {}
        return out;
    }

    private static Set<String> pTags(JSONObject event) {
        Set<String> out = new HashSet<>();
        JSONArray tags = event.optJSONArray("tags");
        if (tags == null) return out;
        for (int i = 0; i < tags.length(); i++) {
            JSONArray tag = tags.optJSONArray(i);
            if (tag != null && "p".equals(tag.optString(0)) && tag.length() > 1) {
                out.add(tag.optString(1));
            }
        }
        return out;
    }

    private static String tagValue(JSONObject event, String name) {
        JSONArray tags = event.optJSONArray("tags");
        if (tags == null) return null;
        for (int i = 0; i < tags.length(); i++) {
            JSONArray tag = tags.optJSONArray(i);
            if (tag != null && name.equals(tag.optString(0)) && tag.length() > 1) {
                return tag.optString(1);
            }
        }
        return null;
    }

    private static String truncate(String s) {
        if (s == null) return "";
        s = s.trim();
        return s.length() <= CONTENT_CAP ? s : s.substring(0, CONTENT_CAP) + "…";
    }

    /**
     * Mirror of the web client's relayToRouteParam (platform.ts): drop a wss://
     * scheme, keep ws: as a marker, then URL-encode for the /s/:server segment.
     */
    private static String relayToRouteParam(String relayUrl) {
        String s = relayUrl;
        if (s.regionMatches(true, 0, "wss://", 0, 6)) {
            s = s.substring(6);
        } else if (s.regionMatches(true, 0, "ws://", 0, 5)) {
            s = "ws:" + s.substring(5);
        }
        return uriEncode(s);
    }

    private static String uriEncode(String s) {
        try {
            return java.net.URLEncoder.encode(s, "UTF-8").replace("+", "%20");
        } catch (Exception e) {
            return s;
        }
    }

    private static int hashId(String id) {
        int hash = 0;
        for (int i = 0; i < Math.min(id.length(), 16); i++) {
            hash = ((hash << 5) - hash) + id.charAt(i);
        }
        return (Math.abs(hash) % MAX_NOTIFICATION_ID) + 2;
    }
}
