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
import androidx.core.app.Person;
import androidx.core.graphics.drawable.IconCompat;

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
 *   - {@code {kinds:[7,1111], #h:[...groupIds], #p:[userPubkey], since}} reactions/replies
 *   - {@code {kinds:[4], authors:[...follows], #p:[userPubkey], since}} DMs (friends only)
 *   - {@code {kinds:[3300], #z:[...pseudonyms], since}}  Concord V1 sealed messages
 *   - {@code {kinds:[1059], authors:[...stream pks], since}} Concord V2 wraps
 *
 * On each EVENT we apply the user's prefs (mention vs all-group, per-type
 * toggles), dedupe by id, skip self, and post it into its room's grouped
 * notification (see {@code enqueueRoomMessage}).
 *
 * Resilience:
 *   - Exponential reconnect backoff per relay (1s → 5min cap), reset only
 *     after a connection survives long enough to be considered stable.
 *   - Network-aware: reconnects immediately when connectivity returns.
 *   - Re-reads config (login/logout/relay/group changes) via a SharedPreferences
 *     listener and rebuilds subscriptions live.
 */
public class NotificationRelayService extends Service {

    private static final String TAG = "ArmadaNotifSvc";
    private static final String SVC_CHANNEL_ID = "armada_background_service";
    // Bumped to _v2 so the stronger vibration + HIGH importance take effect on
    // installs that already created the old channel (channel settings are
    // immutable once created; only a new id picks up new settings). The old
    // channel is deleted in createChannels().
    private static final String MSG_CHANNEL_ID = "armada_notifications_v2";
    private static final String MSG_CHANNEL_ID_LEGACY = "armada_notifications";
    // A firm, attention-grabbing buzz for messages: wait, buzz, gap, buzz again.
    private static final long[] MSG_VIBRATION_PATTERN = { 0L, 400L, 200L, 400L };
    private static final int FOREGROUND_ID = 1;
    // Room notification ids are hashed into [2, ROOM_ID_MODULUS+1]; the group
    // summary lives ABOVE that band so it can never collide with a room id.
    private static final int ROOM_ID_MODULUS = 2_000_000_000;
    private static final int CONTENT_CAP = 140;
    // ── Grouped (per-room) notifications ──────────────────────────────────────
    // All message notifications share one group so the system collapses them
    // under a single summary (Discord/Signal style). Each ROOM (NIP-29 group,
    // Concord channel, or DM peer) gets ONE notification that accumulates its
    // recent messages via MessagingStyle, rather than one flat notification per
    // event. The summary is an InboxStyle digest of the active rooms.
    private static final String GROUP_KEY = "armada_messages";
    // The group summary's own notification id, reserved above the room id band.
    private static final int SUMMARY_NOTIFICATION_ID = 2_000_000_001;
    // Most recent messages kept per room for the MessagingStyle expansion.
    private static final int MAX_MESSAGES_PER_ROOM = 8;

    private static final long INITIAL_BACKOFF_MS = 1_000;
    private static final long MAX_BACKOFF_MS = 5 * 60 * 1_000;
    // A connection must survive this long before a subsequent failure resets
    // the backoff. Resetting in onOpen instead (the old behavior) meant a
    // relay that accepts the handshake but drops the socket right after
    // (auth-walled, overloaded, misbehaving proxy) reconnected every 1s
    // forever — a battery-melting hot loop while the phone sleeps.
    private static final long STABLE_CONNECTION_MS = 60_000;

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
    // People the user follows (kind 3 `p` tags, hex). DM (kind 4) subscriptions
    // are scoped to `authors:[...dmFollows]` so notifications only fire for DMs
    // from friends — matching the client's permanent friends-only DM view.
    private final Set<String> dmFollows = new LinkedHashSet<>();
    private JSONObject prefs = new JSONObject();
    // Concord (E2E) channel subscriptions, keyed for fast lookup:
    //   zToName: #z pseudonym (hex) → "Community / #channel" display name
    //   zToUrl:  #z pseudonym (hex) → in-app deep-link base (/c1/<communityId>);
    //            the channel id is appended per-event at notify time
    //            (/c1/<communityId>/<channelId>) so a tap opens the right channel
    //   zToKey:  #z pseudonym (hex) → decrypt material (raw key + channel/epoch
    //            binding) so the service can open the sealed message
    //   relayToZs: relay url → the #z values that live on that relay
    private final java.util.Map<String, String> zToName = new java.util.HashMap<>();
    private final java.util.Map<String, String> zToUrl = new java.util.HashMap<>();
    private final java.util.Map<String, ConcordKey> zToKey = new java.util.HashMap<>();
    private final java.util.Map<String, Set<String>> relayToZs = new java.util.HashMap<>();
    // Concord V2 (CORD-02) channel subscriptions, keyed for fast lookup:
    //   pkToStream2: stream pubkey (the kind-1059 wrap's author, hex) → decrypt
    //                material + display name + deep link for that channel/epoch
    //   relayToPks2: relay url → the stream pubkeys that live on that relay
    private final java.util.Map<String, Concord2Stream> pkToStream2 = new java.util.HashMap<>();
    private final java.util.Map<String, Set<String>> relayToPks2 = new java.util.HashMap<>();
    // De-dupe notifications across relays/reconnects for this service lifetime.
    private final Set<String> notifiedIds = new HashSet<>();
    // Connect time; we only notify for events at/after this to avoid backfill spam.
    private long sinceSec;

    // roomKey → the accumulating per-room notification (Signal/Discord style).
    // The roomKey is a stable identifier for the conversation (NIP-29 groupId,
    // Concord `z` pseudonym, or "dm:<peer>"), so successive messages UPDATE the
    // same notification instead of stacking a new one per event.
    private final Map<String, RoomNotif> roomNotifs = new HashMap<>();


    // pubkey → resolved profile (kind 0). Cached for the service lifetime so we
    // don't re-fetch the same author's name/avatar on every notification.
    private final Map<String, Profile> profileCache = new HashMap<>();
    // pubkey → waiters for an in-flight kind-0 fetch, so concurrent events for
    // the same author share a single REQ.
    private final Map<String, List<ProfileCallback>> pendingProfiles = new HashMap<>();
    // pubkey → best (newest) kind-0 seen so far for an in-flight fetch, across
    // all relays it was broadcast to. A profile from one relay can be staler
    // than another's, so we keep the highest created_at rather than first-wins.
    private final Map<String, Profile> bestProfile = new HashMap<>();
    // avatar URL → circle-cropped bitmap, decoded once and reused.
    private final Map<String, Bitmap> avatarCache = new HashMap<>();
    // groupId → resolved group name (kind 39000). Cached for the service lifetime
    // so the room name in a notification doesn't re-fetch on every event.
    private final Map<String, String> groupNameCache = new HashMap<>();
    // groupId → waiters for an in-flight kind-39000 fetch.
    private final Map<String, List<GroupNameCallback>> pendingGroupNames = new HashMap<>();
    // Largest dimension (px) we keep for an avatar large-icon.
    private static final int AVATAR_PX = 128;
    // How long to wait for a kind-0 profile before firing a name-less fallback.
    private static final long PROFILE_TIMEOUT_MS = 4_000;

    /** Minimal author profile: display name + avatar URL + nip05 (any may be null). */
    private static final class Profile {
        final String name;
        final String picture;
        final String nip05;
        /** kind-0 created_at, so a newer event from another relay wins. */
        final long ts;
        Profile(String name, String picture, String nip05, long ts) {
            this.name = name;
            this.picture = picture;
            this.nip05 = nip05;
            this.ts = ts;
        }
    }

    /**
     * Per-`z` Concord decrypt material: the raw NIP-44 channel key and the
     * channel id + epoch the sealed message is bound to. Used to open a kind-3300
     * outer event and recover the inner author + plaintext.
     */
    private static final class ConcordKey {
        final byte[] key;        // raw 32-byte channel key (NIP-44 conversation key)
        final String channelId;  // hex; the inner `channel` tag must match (best-effort)
        final String epoch;      // decimal string; the inner `epoch` tag must match
        ConcordKey(byte[] key, String channelId, String epoch) {
            this.key = key;
            this.channelId = channelId;
            this.epoch = epoch;
        }
    }

    private interface ProfileCallback {
        void onProfile(Profile profile);
    }

    /**
     * Per-stream Concord V2 decrypt material: the NIP-44 conversation key that
     * opens the stream's kind-1059 wraps (wrap → seal → rumor), the channel id
     * + epoch the rumor must bind to, and the display/deep-link strings for
     * the notification. One entry per (channel, epoch) — each epoch has its
     * own stream pubkey and conversation key.
     */
    private static final class Concord2Stream {
        final byte[] convKey;    // raw 32-byte NIP-44 conversation key
        final String channelId;  // hex; the rumor's `channel` tag must match
        final String epoch;      // decimal string; the rumor's `epoch` tag must match
        final String name;       // "Community / #channel" display name
        final String url;        // in-app deep link (/c/<communityId>/<channelId>)
        Concord2Stream(byte[] convKey, String channelId, String epoch, String name, String url) {
            this.convKey = convKey;
            this.channelId = channelId;
            this.epoch = epoch;
            this.name = name;
            this.url = url;
        }
    }

    private interface GroupNameCallback {
        /** Receives the group's display name, or null if unresolved. */
        void onName(String name);
    }

    /**
     * One conversation's accumulating notification. Holds the room's display
     * title + deep-link, a bounded history of recent messages (for the
     * MessagingStyle expansion), and the stable notification id derived from the
     * roomKey. New messages append here and re-post the SAME id so a busy room
     * shows as a single, growing thread — not a flat stack of per-event notifs.
     */
    private static final class RoomNotif {
        final String roomKey;
        final int notifId;
        String title;                // conversation/room name shown as the notif title
        String url;                  // in-app deep-link for the tap intent
        boolean isGroupConversation; // true for rooms (group title), false for 1:1 DMs
        final List<NotificationCompat.MessagingStyle.Message> messages = new ArrayList<>();
        long lastTimestampMs;

        RoomNotif(String roomKey, int notifId) {
            this.roomKey = roomKey;
            this.notifId = notifId;
        }
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
        dmFollows.clear();
        dmFollows.addAll(parseStringArray(sp.getString("dmFollows", null)));
        try {
            String p = sp.getString("prefs", null);
            prefs = p != null ? new JSONObject(p) : new JSONObject();
        } catch (JSONException e) {
            prefs = new JSONObject();
        }
        parseConcordSubs(sp.getString("concordSubs", null));
        parseConcord2Subs(sp.getString("concord2Subs", null));

        // The relays to connect to: NIP-29 group relays ∪ DM relays ∪ Concord relays.
        Set<String> allRelays = new LinkedHashSet<>(relayUrls);
        allRelays.addAll(dmRelays);
        allRelays.addAll(relayToZs.keySet());
        allRelays.addAll(relayToPks2.keySet());

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
     * ([{relays:[],zs:[],keys:[{z,key,channelId,epoch}],communityName,channelName}, …])
     * into the lookup maps: z→display-name, z→deep-link, z→decrypt-key, and
     * relay→{z…}. Concord messages are E2E-encrypted; the per-`z` key lets the
     * service open the sealed message for a rich "<sender>: <preview>" body.
     */
    private void parseConcordSubs(String json) {
        zToName.clear();
        zToUrl.clear();
        zToKey.clear();
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
                String url = communityId.isEmpty() ? "/" : "/c1/" + uriEncode(communityId);
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
                // Per-`z` decrypt material (key + channel/epoch binding).
                JSONArray keys = sub.optJSONArray("keys");
                if (keys != null) {
                    for (int j = 0; j < keys.length(); j++) {
                        JSONObject k = keys.optJSONObject(j);
                        if (k == null) continue;
                        String z = k.optString("z", null);
                        byte[] raw = ConcordCrypto.hexToBytes(k.optString("key", null));
                        if (z == null || z.isEmpty() || raw == null || raw.length != 32) continue;
                        zToKey.put(z, new ConcordKey(raw, k.optString("channelId", ""), k.optString("epoch", "")));
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

    /**
     * Parse the Concord V2 subscriptions JSON
     * ([{relays:[],communityId,communityName,channelId,channelName,
     *    streams:[{pk,convKey,epoch}]}, …])
     * into the lookup maps: stream-pubkey→decrypt-material and relay→{pk…}.
     * V2 traffic is kind-1059 wraps AUTHORED BY the derived stream keys (no
     * routing tag); the per-stream conversation key opens wrap → seal → rumor
     * for a rich "<sender>: <preview>" body.
     */
    private void parseConcord2Subs(String json) {
        pkToStream2.clear();
        relayToPks2.clear();
        if (json == null) return;
        try {
            JSONArray arr = new JSONArray(json);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject sub = arr.optJSONObject(i);
                if (sub == null) continue;
                String community = sub.optString("communityName", "Community");
                String channel = sub.optString("channelName", "channel");
                String communityId = sub.optString("communityId", "");
                String channelId = sub.optString("channelId", "");
                if (communityId.isEmpty() || channelId.isEmpty()) continue;
                String name = community + " / #" + channel;
                String url = "/c/" + uriEncode(communityId) + "/" + uriEncode(channelId);
                JSONArray streams = sub.optJSONArray("streams");
                JSONArray relays = sub.optJSONArray("relays");
                if (streams == null || relays == null) continue;

                List<String> pkList = new ArrayList<>();
                for (int j = 0; j < streams.length(); j++) {
                    JSONObject s = streams.optJSONObject(j);
                    if (s == null) continue;
                    String pk = s.optString("pk", null);
                    byte[] convKey = ConcordCrypto.hexToBytes(s.optString("convKey", null));
                    if (pk == null || pk.isEmpty() || convKey == null || convKey.length != 32) continue;
                    pkList.add(pk);
                    pkToStream2.put(pk, new Concord2Stream(
                            convKey, channelId, s.optString("epoch", ""), name, url));
                }
                for (int j = 0; j < relays.length(); j++) {
                    String relay = relays.optString(j);
                    if (relay == null || relay.isEmpty()) continue;
                    Set<String> set = relayToPks2.get(relay);
                    if (set == null) {
                        set = new LinkedHashSet<>();
                        relayToPks2.put(relay, set);
                    }
                    set.addAll(pkList);
                }
            }
        } catch (JSONException e) {
            Log.w(TAG, "Failed to parse concord2Subs", e);
        }
    }

    // ── Per-relay connection ────────────────────────────────────────────────

    private class RelayConnection {
        final String relayUrl;
        WebSocket ws;
        long backoffMs = INITIAL_BACKOFF_MS;
        boolean closed = false;

        // When the current connection attempt started (main thread only).
        // Used by scheduleReconnect to distinguish "stable connection finally
        // died" (reset backoff) from "relay drops us right away" (keep growing).
        long connectAttemptAt = 0;

        // Single pending reconnect, cancellable — prevents a queued reconnect
        // and the network callback from racing to open duplicate sockets.
        final Runnable reconnectRunnable = this::connect;

        final String subGroups = "ag-" + Long.toHexString(System.nanoTime());
        final String subDirect = "ad-" + Long.toHexString(System.nanoTime() + 1);
        final String subConcord = "ac-" + Long.toHexString(System.nanoTime() + 2);
        final String subDm = "am-" + Long.toHexString(System.nanoTime() + 3);
        // Prefix for one-shot kind-0 profile lookups. The sub id embeds only a
        // TRUNCATED key (see shortKey) so it stays within NIP-01's customary
        // 64-char subscription-id cap — strfry-family relays reject longer ids
        // with "invalid subscription id length" (#50). The full pubkey/groupId
        // is recovered through the lookup maps below, not the sub id.
        final String profilePrefix = "ap-" + Long.toHexString(System.nanoTime() + 4) + "-";
        // Prefix for one-shot kind-39000 group-metadata lookups.
        final String groupPrefix = "ah-" + Long.toHexString(System.nanoTime() + 5) + "-";
        final String subConcord2 = "a2-" + Long.toHexString(System.nanoTime() + 6);
        // One-shot lookup sub id → the full pubkey / group id it was issued
        // for. Entries are removed when the lookup resolves; capped clears
        // protect against relays that never answer.
        final Map<String, String> profileLookups = new HashMap<>();
        final Map<String, String> groupLookups = new HashMap<>();
        // ids of the kind-22242s we sent and haven't seen an OK for. NIP-42
        // allows several AUTHs per connection (the user + every Concord V2
        // stream key), so this is a set; a relay's OK for some other event
        // can't trigger a REQ re-send.
        final Set<String> pendingAuthIds = new HashSet<>();
        // Backoff for relay-initiated CLOSED resubscribes (#49): a relay that
        // drops a standing sub (restart, transient error, rate limit) earns a
        // DELAYED re-REQ with a growing gap, never an instant retry loop.
        // Reset when a fresh socket session opens.
        long subRetryBackoffMs = INITIAL_BACKOFF_MS;
        final Runnable resubscribeRunnable = () -> {
            if (!closed && ws != null) sendReqs(ws);
        };
        // Coalesces the REQ re-send that follows AUTH acks (#49): the user +
        // every Concord V2 stream key each get their own OK, so an auth round
        // used to trigger one full sendReqs PER OK — dozens of duplicate REQ
        // bursts per challenge. One re-send shortly after the burst settles
        // covers them all.
        boolean authResendPending = false;
        final Runnable authResendRunnable = () -> {
            authResendPending = false;
            if (!closed && ws != null) sendReqs(ws);
        };

        /** Re-send REQs shortly, collapsing a burst of AUTH OKs into one round. */
        void scheduleAuthResend() {
            if (authResendPending) return;
            authResendPending = true;
            handler.postDelayed(authResendRunnable, 300);
        }

        RelayConnection(String relayUrl) {
            this.relayUrl = relayUrl;
        }

        void connect() {
            // ws != null guard: a socket is already open (or opening). Without
            // it, a stale queued reconnect firing after the network callback
            // already reconnected would open a second socket and orphan the
            // first — leaked sockets keep pinging and re-failing forever.
            if (closed || ws != null || !isNetworkAvailable()) return;
            connectAttemptAt = System.currentTimeMillis();
            Request request = new Request.Builder().url(relayUrl).build();
            ws = httpClient.newWebSocket(request, new WebSocketListener() {
                @Override
                public void onOpen(WebSocket webSocket, Response response) {
                    if (BuildConfig.DEBUG) Log.d(TAG, "WS open: " + relayUrl);
                    // A fresh socket session: CLOSED-resubscribe backoff starts
                    // over, and a pending auth re-send belongs to the old session.
                    handler.post(() -> {
                        subRetryBackoffMs = INITIAL_BACKOFF_MS;
                        handler.removeCallbacks(resubscribeRunnable);
                        authResendPending = false;
                        handler.removeCallbacks(authResendRunnable);
                    });
                    sendReqs(webSocket);
                }

                @Override
                public void onMessage(WebSocket webSocket, String text) {
                    handler.post(() -> onRelayMessage(text, relayUrl));
                }

                @Override
                public void onFailure(WebSocket webSocket, Throwable t, Response response) {
                    Log.w(TAG, "WS failure (" + relayUrl + "): " + t.getMessage());
                    handler.post(RelayConnection.this::scheduleReconnect);
                }

                @Override
                public void onClosed(WebSocket webSocket, int code, String reason) {
                    handler.post(() -> {
                        if (!closed) scheduleReconnect();
                    });
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
                // (NOT the NIP-29 group relays — DMs don't live there). Scoped to
                // `authors:[...dmFollows]` so only DMs from people I follow notify
                // (permanent friends-only). No follows ⇒ no DM subscription.
                if (dmRelays.contains(relayUrl) && !dmFollows.isEmpty()) {
                    JSONObject f4 = new JSONObject();
                    f4.put("kinds", new JSONArray().put(4));
                    JSONArray dmAuthors = new JSONArray();
                    for (String pk : dmFollows) dmAuthors.put(pk);
                    f4.put("authors", dmAuthors);
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
                // Concord V2 channel wraps on this relay: kind-1059 events
                // AUTHORED BY the derived stream keys (no routing tag at all).
                Set<String> pks = relayToPks2.get(relayUrl);
                if (pks != null && !pks.isEmpty()) {
                    JSONObject f5 = new JSONObject();
                    f5.put("kinds", new JSONArray().put(1059));
                    JSONArray authors = new JSONArray();
                    for (String pk : pks) authors.put(pk);
                    f5.put("authors", authors);
                    f5.put("since", sinceSec);
                    webSocket.send(reqMessage(subConcord2, f5));
                }
            } catch (JSONException e) {
                Log.w(TAG, "Failed to build REQ", e);
            }
        }

        void sendAuth(String eventJson) {
            if (ws == null) return;
            try {
                JSONObject event = new JSONObject(eventJson);
                String eid = event.optString("id", null);
                if (eid != null && !eid.isEmpty()) pendingAuthIds.add(eid);
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
                ws.send(reqMessage(profileSubId(pubkey), f));
            } catch (JSONException e) {
                if (BuildConfig.DEBUG) Log.w(TAG, "Failed to build profile REQ", e);
            }
        }

        /**
         * Fire a one-shot kind-39000 (NIP-29 group metadata) REQ for
         * {@code groupId}, scoped with a `#d` filter. The EVENT is picked up in
         * {@link #onRelayMessage} (sub id starts with {@link #groupPrefix}).
         */
        void fetchGroupName(String groupId) {
            if (closed || ws == null) return;
            try {
                JSONObject f = new JSONObject();
                f.put("kinds", new JSONArray().put(39000));
                f.put("#d", new JSONArray().put(groupId));
                f.put("limit", 1);
                ws.send(reqMessage(groupSubId(groupId), f));
            } catch (JSONException e) {
                if (BuildConfig.DEBUG) Log.w(TAG, "Failed to build group-name REQ", e);
            }
        }

        /**
         * The sub id for a one-shot profile lookup, registered in
         * {@link #profileLookups} so the full pubkey can be recovered. Embeds
         * only a truncated key: relays commonly cap subscription ids at 64
         * chars and reject longer ones outright, so `prefix + full 64-hex
         * pubkey` (~84 chars) meant those relays' notifications never fired (#50).
         */
        String profileSubId(String pubkey) {
            String subId = profilePrefix + shortKey(pubkey);
            if (profileLookups.size() > 512) profileLookups.clear();
            profileLookups.put(subId, pubkey);
            return subId;
        }

        /** Group-metadata analogue of {@link #profileSubId}. */
        String groupSubId(String groupId) {
            String subId = groupPrefix + shortKey(groupId);
            if (groupLookups.size() > 512) groupLookups.clear();
            groupLookups.put(subId, groupId);
            return subId;
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
            ws = null;
            // Only a connection that stayed up for a while earns a backoff
            // reset; instant drops keep doubling toward the 5-minute cap.
            if (connectAttemptAt > 0
                    && System.currentTimeMillis() - connectAttemptAt >= STABLE_CONNECTION_MS) {
                backoffMs = INITIAL_BACKOFF_MS;
            }
            long delay = backoffMs;
            backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
            handler.removeCallbacks(reconnectRunnable);
            handler.postDelayed(reconnectRunnable, delay);
        }

        /**
         * Re-send this connection's standing REQs after a relay-initiated
         * CLOSED (#49), with an exponential per-connection delay (1s → 5min)
         * so a relay that keeps dropping the sub can never be hammered in a
         * tight loop. Never used for `auth-required` CLOSEDs — those re-send
         * through the AUTH → OK path instead.
         */
        void scheduleResubscribe() {
            if (closed || ws == null) return;
            handler.removeCallbacks(resubscribeRunnable);
            handler.postDelayed(resubscribeRunnable, subRetryBackoffMs);
            subRetryBackoffMs = Math.min(subRetryBackoffMs * 2, MAX_BACKOFF_MS);
        }

        void close() {
            closed = true;
            handler.removeCallbacks(reconnectRunnable);
            handler.removeCallbacks(resubscribeRunnable);
            if (ws != null) {
                try { ws.close(1000, "service reconfigured"); } catch (Exception ignored) {}
                ws = null;
            }
        }

        void resetAndConnectNow() {
            backoffMs = INITIAL_BACKOFF_MS;
            handler.removeCallbacks(reconnectRunnable);
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

    /**
     * Truncate a hex pubkey / group id for embedding in a subscription id.
     * 24 hex chars keep concurrent lookups distinct for all practical
     * purposes while the whole sub id stays well under the 64-char cap many
     * relays enforce (#50); the full value is recovered via the per-connection
     * lookup maps, never parsed back out of the sub id.
     */
    private static String shortKey(String value) {
        return value.length() <= 24 ? value : value.substring(0, 24);
    }

    private void onRelayMessage(String text, String relayUrl) {
        try {
            JSONArray msg = new JSONArray(text);
            String type = msg.optString(0);
            if ("AUTH".equals(type)) {
                // NIP-42 challenge. The user's kind-22242 goes through the
                // WebView's signer (handles nsec / bunker / extension) and
                // comes back via ArmadaNotificationPlugin.submitAuth →
                // deliverAuth.
                String challenge = msg.optString(1);
                if (BuildConfig.DEBUG) Log.d(TAG, "AUTH challenge from " + relayUrl);
                boolean bridged = ArmadaNotificationPlugin.emitAuthChallenge(relayUrl, challenge);
                if (!bridged) {
                    Log.w(TAG, "No bridge (WebView down) — can't AUTH " + relayUrl + " as the user");
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
                    return;
                }
                // A group-name lookup with no kind-39000: resolve waiters null.
                String gid = groupIdForSub(sub);
                if (gid != null) {
                    closeProfileSub(relayUrl, sub);
                    resolveGroupName(gid, null);
                }
                return;
            }
            if ("CLOSED".equals(type)) {
                String sub = msg.optString(1);
                String reason = msg.optString(2);
                Log.w(TAG, "CLOSED from " + relayUrl + " sub=" + sub + " reason=" + reason);
                // A one-shot profile/group lookup the relay rejected (bad sub
                // id, auth wall, filter policy): resolve its waiters like an
                // empty EOSE so the notification fires name-less instead of
                // hanging on the timeout.
                String pk = profilePubkeyForSub(sub);
                if (pk != null) {
                    closeProfileSub(relayUrl, sub);
                    resolveProfile(pk, bestProfile.get(pk));
                    return;
                }
                String gid = groupIdForSub(sub);
                if (gid != null) {
                    closeProfileSub(relayUrl, sub);
                    resolveGroupName(gid, (String) null);
                    return;
                }
                // A standing subscription the relay dropped. `auth-required`
                // is NOT retried from here — the AUTH → OK path re-sends every
                // REQ once authentication lands, and without an auth path a
                // blind re-REQ is an unwinnable retry storm (#49). Everything
                // else (relay restart, transient error, rate limit) earns a
                // DELAYED resubscribe with per-connection exponential backoff.
                if (reason.startsWith("auth-required:")) return;
                for (RelayConnection rc : connections) {
                    if (rc.relayUrl.equals(relayUrl)) {
                        rc.scheduleResubscribe();
                        break;
                    }
                }
                return;
            }
            if ("OK".equals(type)) {
                // AUTH ack (["OK", <event-id>, true/false, msg]). On success,
                // and only when the id matches a kind-22242 we sent (the user's
                // or a Concord V2 stream key's), the matching connection
                // re-sends its REQs — coalesced into one round after the OK
                // burst settles (see scheduleAuthResend).
                String okId = msg.optString(1);
                boolean ok = msg.optBoolean(2, false);
                if (BuildConfig.DEBUG) Log.d(TAG, "OK from " + relayUrl + " ok=" + ok + " " + msg.optString(3));
                for (RelayConnection rc : connections) {
                    if (!rc.relayUrl.equals(relayUrl) || rc.ws == null) continue;
                    if (ok && rc.pendingAuthIds.remove(okId)) {
                        rc.scheduleAuthResend();
                    }
                }
                return;
            }
            if (!"EVENT".equals(type)) return;
            String sub = msg.optString(1);
            JSONObject event = msg.optJSONObject(2);
            if (event == null) return;
            // A kind-0 from a profile lookup: keep the newest across relays and
            // resolve waiters with the best we have.
            String pk = profilePubkeyForSub(sub);
            if (pk != null) {
                closeProfileSub(relayUrl, sub);
                Profile parsed = parseProfile(event);
                Profile prev = bestProfile.get(pk);
                if (prev == null || parsed.ts >= prev.ts) {
                    bestProfile.put(pk, parsed);
                }
                resolveProfile(pk, bestProfile.get(pk));
                return;
            }
            // A kind-39000 from a group-name lookup: cache the name + resolve.
            String gid = groupIdForSub(sub);
            if (gid != null) {
                closeProfileSub(relayUrl, sub);
                resolveGroupName(gid, parseGroupName(event));
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
     * it was issued for; otherwise null. Recovered from each connection's
     * lookup map (the sub id itself only carries a truncated key, #50).
     */
    private String profilePubkeyForSub(String sub) {
        if (sub == null || sub.isEmpty()) return null;
        for (RelayConnection rc : connections) {
            String pk = rc.profileLookups.get(sub);
            if (pk != null) return pk;
        }
        return null;
    }

    private void closeProfileSub(String relayUrl, String sub) {
        for (RelayConnection rc : connections) {
            if (rc.relayUrl.equals(relayUrl)) {
                rc.profileLookups.remove(sub);
                rc.groupLookups.remove(sub);
                rc.closeSub(sub);
                return;
            }
        }
    }

    /**
     * Resolve {@code pubkey} to a profile, then invoke {@code cb} (always on the
     * main handler). Serves from cache when present, otherwise issues a kind-0
     * REQ on EVERY open relay (a user's kind-0 usually lives on their general /
     * outbox relays, not the NIP-29 group relay the message came from, so a
     * single-relay lookup misses it — that was why many senders showed no name
     * or avatar). Waits up to {@link #PROFILE_TIMEOUT_MS}, keeping the newest
     * kind-0 seen across relays.
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

        // Broadcast to every connected relay (originating relay first), not just
        // the one the message arrived on.
        boolean sentAny = false;
        for (RelayConnection rc : connections) {
            if (rc.ws != null && !rc.closed) {
                rc.fetchProfile(pubkey);
                sentAny = true;
            }
        }
        if (!sentAny) {
            resolveProfile(pubkey, null);
            return;
        }
        // Fallback if no relay answers in time (no kind-0 / slow): resolve with
        // the best profile gathered so far (possibly null).
        handler.postDelayed(() -> {
            if (pendingProfiles.containsKey(pubkey)) {
                resolveProfile(pubkey, bestProfile.get(pubkey));
            }
        }, PROFILE_TIMEOUT_MS);
    }

    /** Cache the result (if any) and flush all pending waiters for this pubkey. */
    private void resolveProfile(String pubkey, Profile profile) {
        if (profile != null) {
            profileCache.put(pubkey, profile);
        }
        bestProfile.remove(pubkey);
        // Close any profile subs still open for this pubkey on the other relays
        // we broadcast to, so they don't linger.
        for (RelayConnection rc : connections) {
            String subId = rc.profilePrefix + shortKey(pubkey);
            rc.profileLookups.remove(subId);
            rc.closeSub(subId);
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

    /** Parse a kind-0 event's content into a {@link Profile}. */
    private static Profile parseProfile(JSONObject event) {
        long ts = event.optLong("created_at", 0);
        try {
            JSONObject meta = new JSONObject(event.optString("content", "{}"));
            String name = meta.optString("display_name", null);
            if (name == null || name.isEmpty()) {
                name = meta.optString("name", null);
            }
            if (name != null && name.isEmpty()) name = null;
            String picture = meta.optString("picture", null);
            if (picture != null && picture.isEmpty()) picture = null;
            String nip05 = meta.optString("nip05", null);
            if (nip05 != null && nip05.isEmpty()) nip05 = null;
            return new Profile(name, picture, nip05, ts);
        } catch (JSONException e) {
            return new Profile(null, null, null, ts);
        }
    }

    // ── Group name (kind 39000) resolution ────────────────────────────────────

    /**
     * If {@code sub} is one of our one-shot group-name lookups, return the group
     * id it was issued for; otherwise null. Recovered from each connection's
     * lookup map (the sub id itself only carries a truncated id, #50).
     */
    private String groupIdForSub(String sub) {
        if (sub == null || sub.isEmpty()) return null;
        for (RelayConnection rc : connections) {
            String gid = rc.groupLookups.get(sub);
            if (gid != null) return gid;
        }
        return null;
    }

    /** Parse a kind-39000 group-metadata event's name (the `name` tag). */
    private static String parseGroupName(JSONObject event) {
        return tagValue(event, "name");
    }

    /**
     * Resolve {@code groupId} to a display name, then invoke {@code cb} (always
     * on the main handler). Serves from cache, else issues a kind-39000 REQ on
     * {@code relayUrl} and waits up to {@link #PROFILE_TIMEOUT_MS}.
     */
    private void resolveGroupName(String groupId, String relayUrl, GroupNameCallback cb) {
        String cached = groupNameCache.get(groupId);
        if (cached != null) {
            cb.onName(cached);
            return;
        }
        List<GroupNameCallback> waiters = pendingGroupNames.get(groupId);
        if (waiters != null) {
            waiters.add(cb);
            return;
        }
        waiters = new ArrayList<>();
        waiters.add(cb);
        pendingGroupNames.put(groupId, waiters);

        RelayConnection rc = connectionFor(relayUrl);
        if (rc == null) {
            resolveGroupName(groupId, (String) null);
            return;
        }
        rc.fetchGroupName(groupId);
        handler.postDelayed(() -> {
            if (pendingGroupNames.containsKey(groupId)) {
                resolveGroupName(groupId, (String) null);
            }
        }, PROFILE_TIMEOUT_MS);
    }

    /** Cache the name (if any) and flush all pending waiters for this group. */
    private void resolveGroupName(String groupId, String name) {
        if (name != null && !name.isEmpty()) {
            groupNameCache.put(groupId, name);
        }
        List<GroupNameCallback> waiters = pendingGroupNames.remove(groupId);
        if (waiters == null) return;
        for (GroupNameCallback cb : waiters) {
            cb.onName(name);
        }
    }

    // ── Event → notification ──────────────────────────────────────────────────

    /**
     * Open a Concord sealed outer event with the supplied channel key: NIP-44
     * v2-decrypt the {@code content}, parse the inner authorship event, and
     * return it (with {@code pubkey} = real author, {@code content} = message).
     * Best-effort: returns {@code null} on decrypt/parse failure or if the inner
     * channel/epoch binding doesn't match (a spliced/foreign payload). We do not
     * verify the inner Schnorr signature here (see {@link ConcordCrypto}).
     */
    private static JSONObject openConcord(JSONObject outer, ConcordKey ck) {
        try {
            String payload = outer.optString("content", "");
            if (payload.isEmpty()) return null;
            String json = ConcordCrypto.decrypt(ck.key, payload);
            if (json == null) return null;
            JSONObject inner = new JSONObject(json);
            // Binding: the inner kind must equal the outer's, and the inner
            // channel/epoch tags must match the key we decrypted with — cheap
            // anti-splice checks that don't need secp256k1.
            if (inner.optInt("kind", -1) != outer.optInt("kind", -2)) return null;
            String ch = tagValue(inner, "channel");
            String ep = tagValue(inner, "epoch");
            if (!ck.channelId.isEmpty() && ch != null && !ck.channelId.equals(ch)) return null;
            if (!ck.epoch.isEmpty() && ep != null && !ck.epoch.equals(ep)) return null;
            return inner;
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * Open a Concord V2 stream wrap with the supplied conversation key:
     * NIP-44-decrypt the wrap's {@code content} → the seal (kind 20013
     * encrypted / 20014 plaintext), recover the rumor (decrypting again for
     * 20013), and return it ({@code pubkey} = real author, {@code content} =
     * message). Best-effort: returns {@code null} on decrypt/parse failure or
     * if the rumor's author/channel/epoch binding doesn't match — cheap
     * anti-splice checks that don't need secp256k1. We do not verify the
     * seal's Schnorr signature here (see {@link ConcordCrypto}); the WebView
     * fully re-verifies before trusting the event.
     */
    private static JSONObject openConcord2(JSONObject wrap, Concord2Stream st) {
        try {
            String payload = wrap.optString("content", "");
            if (payload.isEmpty()) return null;
            String sealJson = ConcordCrypto.decrypt(st.convKey, payload);
            if (sealJson == null) return null;
            JSONObject seal = new JSONObject(sealJson);
            int sealKind = seal.optInt("kind", -1);
            String rumorJson;
            if (sealKind == 20013) {
                rumorJson = ConcordCrypto.decrypt(st.convKey, seal.optString("content", ""));
            } else if (sealKind == 20014) {
                rumorJson = seal.optString("content", null);
            } else {
                return null;
            }
            if (rumorJson == null) return null;
            JSONObject rumor = new JSONObject(rumorJson);
            // The rumor's author must equal the seal's signer (or a keyholder
            // could re-seal another member's rumor under their own name), and
            // the channel/epoch binding must match the stream that decrypted
            // the wrap (a spliced/foreign payload).
            String author = rumor.optString("pubkey");
            if (author.isEmpty() || !author.equals(seal.optString("pubkey"))) return null;
            String ch = tagValue(rumor, "channel");
            String ep = tagValue(rumor, "epoch");
            if (ch != null && !st.channelId.equals(ch)) return null;
            if (ep != null && !st.epoch.isEmpty() && !st.epoch.equals(ep)) return null;
            return rumor;
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * Per-room cache key for the plugin's rolling event cache (see
     * ArmadaNotificationPlugin.getRoomEvents): NIP-29 events key by their group
     * (`h` tag), Concord V1 sealed outers by pseudonym (`z` tag), Concord V2
     * wraps by the channel their stream author maps to, DMs share one bucket
     * (the WebView splits threads by counterparty itself). Null when the event
     * carries no usable room scope.
     */
    private String roomKeyFor(JSONObject event, int kind) {
        if (kind == 4) return "dm";
        if (kind == 3300) {
            String z = tagValue(event, "z");
            return z != null ? "z:" + z : null;
        }
        if (kind == 1059) {
            Concord2Stream st = pkToStream2.get(event.optString("pubkey"));
            return st != null ? "c2:" + st.channelId : null;
        }
        String h = tagValue(event, "h");
        return h != null ? "h:" + h : null;
    }

    private void handleEvent(JSONObject event, String relayUrl) {
        String id = event.optString("id");
        if (id.isEmpty() || notifiedIds.contains(id)) {
            return;
        }

        int kind = event.optInt("kind");

        // Feed the raw outer event to the WebView (live if it's up, buffered
        // otherwise) so a message the service already received is in the app's
        // store the instant it opens — no relay round-trip, no "wait for the
        // chat to catch up". Covers the timeline kinds the WebView renders:
        // NIP-29 chat/polls/reactions/replies/deletes, Concord V1 sealed outers
        // (kind 3300) and V2 wraps (kind 1059, both decrypted in the WebView)
        // and DMs (kind 4 — ciphertext; the WebView holds the NIP-04 keys).
        // Each is also recorded in the plugin's per-room rolling cache (see
        // getRoomEvents) so opening a room can pull its natively-received
        // history directly.
        switch (kind) {
            case 9: case 1068: case 7: case 1111: case 5: case 3300: case 1059: case 4:
                ArmadaNotificationPlugin.feedRelayEvent(roomKeyFor(event, kind), event.toString());
                break;
            default:
                break;
        }

        // Concord (E2E): the outer event is signed by an ephemeral key with
        // NIP-44-encrypted content. Open it with the channel key we were handed
        // (derived in the WebView, where membership lives) to recover the inner
        // author + plaintext, then notify just like a group message. If we have
        // no key (or decryption fails) fall back to a keyless room notification.
        if (kind == 3300) {
            String z = tagValue(event, "z");
            String room = z != null ? zToName.get(z) : null;
            if (room == null) {
                return;
            }
            String url = zToUrl.get(z);
            long cts = event.optLong("created_at", 0);
            if (cts + 1 > sinceSec) sinceSec = cts + 1;
            notifiedIds.add(id);

            ConcordKey ck = zToKey.get(z);
            // Deep-link to the SPECIFIC channel (not just the community), so a
            // tap opens the room the notification is about instead of falling
            // back to the last-opened channel. The community-only url is the
            // base; append the channel id when the key carries one.
            if (ck != null && url != null && !url.equals("/") && !ck.channelId.isEmpty()) {
                url = url + "/" + uriEncode(ck.channelId);
            }
            JSONObject inner = ck != null ? openConcord(event, ck) : null;
            if (inner == null) {
                // Couldn't decrypt — still tell the user something arrived, and
                // where. (Generic body, but a real room title.)
                if (BuildConfig.DEBUG) Log.d(TAG, "NOTIFY concord (opaque): " + room);
                if (!prefBool("allGroupMessages", true)) return;
                enqueueRoomMessage(
                        "z:" + z, room, url != null ? url : "/", /*isGroup=*/true,
                        /*senderPubkey=*/null, "Someone", /*picture=*/null,
                        "New message", System.currentTimeMillis());
                return;
            }

            // Feed the DECRYPTED inner straight to the WebView so the message
            // renders the instant the app opens — no second NIP-44 decrypt, no
            // relay round-trip. We only checked HMAC + channel/epoch binding
            // here, so the WebView re-verifies the inner Schnorr signature before
            // trusting it (a channel-key holder could otherwise forge `pubkey`).
            ArmadaNotificationPlugin.feedConcordInner(inner.toString(), z, id);

            String author = inner.optString("pubkey");
            if (author.equals(userPubkey)) {
                return; // our own message echoed back
            }
            boolean mentionsMe = pTags(inner).contains(userPubkey);
            // Concord rooms reuse the group-message prefs: always notify on a
            // mention; otherwise honour the all-messages toggle.
            if (!(mentionsMe ? prefBool("mentions", true) : prefBool("allGroupMessages", true))) {
                return;
            }
            final String fZ = z;
            final String fRoom = room;
            final String fUrl = url != null ? url : "/";
            final boolean fMention = mentionsMe;
            final String preview = truncate(inner.optString("content"));
            final long fTs = (cts > 0 ? cts * 1000L : System.currentTimeMillis());
            resolveAuthor(author, relayUrl, profile -> {
                String name = displayName(profile, author);
                String picture = profile != null ? profile.picture : null;
                // The room is the conversation title (MessagingStyle); a mention
                // is reflected in the line text so it stands out in the thread.
                String text = !preview.isEmpty() ? preview : "Sent a message";
                if (fMention) text = "@you " + text;
                if (BuildConfig.DEBUG) Log.d(TAG, "NOTIFY concord: " + fRoom + " / " + name);
                enqueueRoomMessage(
                        "z:" + fZ, fRoom, fUrl, /*isGroup=*/true,
                        author, name, picture, text, fTs);
            });
            return;
        }

        // Concord V2 (E2E): the outer event is a kind-1059 wrap SIGNED BY a
        // derived stream key with NIP-44-encrypted content. Open wrap → seal →
        // rumor with the stream's conversation key (derived in the WebView,
        // where membership lives) to recover the real author + plaintext, then
        // notify just like a group message. If decryption fails (e.g. a rekey
        // epoch we don't hold yet) fall back to a keyless room notification.
        if (kind == 1059) {
            Concord2Stream st = pkToStream2.get(event.optString("pubkey"));
            if (st == null) {
                return;
            }
            long cts = event.optLong("created_at", 0);
            if (cts + 1 > sinceSec) sinceSec = cts + 1;
            notifiedIds.add(id);

            JSONObject rumor = openConcord2(event, st);
            if (rumor == null) {
                // Couldn't decrypt — still tell the user something arrived,
                // and where. (Generic body, but a real room title.)
                if (BuildConfig.DEBUG) Log.d(TAG, "NOTIFY concord2 (opaque): " + st.name);
                if (!prefBool("allGroupMessages", true)) return;
                enqueueRoomMessage(
                        "c2:" + st.channelId, st.name, st.url, /*isGroup=*/true,
                        /*senderPubkey=*/null, "Someone", /*picture=*/null,
                        "New message", System.currentTimeMillis());
                return;
            }

            // Every chat-plane kind rides an identical wrap; only actual
            // messages (rumor kind 9) notify — reactions/edits/deletes stay
            // silent, mirroring the V1 policy of subscribing messages only.
            if (rumor.optInt("kind", -1) != 9) {
                return;
            }
            final String author2 = rumor.optString("pubkey");
            if (author2.equals(userPubkey)) {
                return; // our own message echoed back
            }
            boolean mentionsMe2 = pTags(rumor).contains(userPubkey);
            // Concord rooms reuse the group-message prefs: always notify on a
            // mention; otherwise honour the all-messages toggle.
            if (!(mentionsMe2 ? prefBool("mentions", true) : prefBool("allGroupMessages", true))) {
                return;
            }
            final Concord2Stream fSt = st;
            final boolean fMention2 = mentionsMe2;
            final String preview2 = truncate(rumor.optString("content"));
            final long rts = rumor.optLong("created_at", 0);
            final long fTs2 = (rts > 0 ? rts * 1000L : System.currentTimeMillis());
            resolveAuthor(author2, relayUrl, profile -> {
                String name = displayName(profile, author2);
                String picture = profile != null ? profile.picture : null;
                String text = !preview2.isEmpty() ? preview2 : "Sent a message";
                if (fMention2) text = "@you " + text;
                if (BuildConfig.DEBUG) Log.d(TAG, "NOTIFY concord2: " + fSt.name + " / " + name);
                enqueueRoomMessage(
                        "c2:" + fSt.channelId, fSt.name, fSt.url, /*isGroup=*/true,
                        author2, name, picture, text, fTs2);
            });
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

        final boolean mention = mentionsMe;
        final long fTs = (ts > 0 ? ts * 1000L : System.currentTimeMillis());
        // Resolve the author's name + avatar, then feed a per-room message line.
        // MessagingStyle shows WHO via the sender Person, so the line is just the
        // message/verb; the room name is the conversation title.
        resolveAuthor(author, relayUrl, profile -> {
            String name = displayName(profile, author);
            final String picture = profile != null ? profile.picture : null;
            String line;
            String url;
            // The NIP-29 group this happened in (kinds 9/7/1111). Null for DMs.
            String groupId = null;
            switch (kind) {
                case 9: {
                    groupId = tagValue(event, "h");
                    line = truncate(event.optString("content"));
                    if (line.isEmpty()) line = "Sent a message";
                    if (mention) line = "@you " + line;
                    url = groupId != null
                            ? "/s/" + relayToRouteParam(relayUrl) + "/" + uriEncode(groupId)
                            : "/";
                    break;
                }
                case 7: {
                    line = "Reacted " + reactionEmoji(event) + " to your message";
                    groupId = tagValue(event, "h");
                    url = groupId != null
                            ? "/s/" + relayToRouteParam(relayUrl) + "/" + uriEncode(groupId)
                            : "/";
                    break;
                }
                case 1111: {
                    line = truncate(event.optString("content"));
                    if (line.isEmpty()) line = "Replied to you";
                    else line = "↪ " + line;
                    groupId = tagValue(event, "h");
                    url = groupId != null
                            ? "/s/" + relayToRouteParam(relayUrl) + "/" + uriEncode(groupId)
                            : "/";
                    break;
                }
                case 4:
                    // kind-4 DMs are NIP-04 encrypted; the service has no key.
                    line = "Sent you a direct message";
                    url = "/dms/" + author;
                    break;
                default:
                    return;
            }
            final String fName = name;
            final String fLine = line;
            final String fUrl = url;
            if (groupId == null) {
                // DM: the conversation is 1:1 with the sender, so the sender's
                // name is the room title and it's not a "group" conversation.
                if (BuildConfig.DEBUG) Log.d(TAG, "NOTIFY dm from=" + fName);
                enqueueRoomMessage(
                        "dm:" + author, fName, fUrl, /*isGroup=*/false,
                        author, fName, picture, fLine, fTs);
                return;
            }
            // Resolve the group's display name; it becomes the conversation title.
            final String fGroupId = groupId;
            resolveGroupName(groupId, relayUrl, groupName -> {
                String roomTitle = (groupName != null && !groupName.isEmpty()) ? groupName : "Group";
                if (BuildConfig.DEBUG) Log.d(TAG, "NOTIFY kind=" + kind + " room=" + roomTitle);
                enqueueRoomMessage(
                        "h:" + relayUrl + "|" + fGroupId, roomTitle, fUrl, /*isGroup=*/true,
                        author, fName, picture, fLine, fTs);
            });
        });
    }

    /** Display name from a resolved profile, falling back to a short npub-ish id. */
    private static String displayName(Profile profile, String pubkey) {
        if (profile != null && profile.name != null && !profile.name.isEmpty()) {
            return profile.name;
        }
        // Fall back to the NIP-05 identifier (its local-part, dropping a leading
        // "_@" which conventionally means "the domain itself") before the raw
        // pubkey stub, so a user with only a nip05 still gets a readable name.
        if (profile != null && profile.nip05 != null && !profile.nip05.isEmpty()) {
            String n = profile.nip05;
            int at = n.indexOf('@');
            if (at == 0) {
                n = n.substring(1);
            } else if (at > 0) {
                String local = n.substring(0, at);
                n = local.equals("_") ? n.substring(at + 1) : local;
            }
            if (!n.isEmpty()) return n;
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
                return prefBool("allGroupMessages", true);
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

    /**
     * Append a message to its room's accumulating MessagingStyle notification and
     * (re)post it under the shared group, plus refresh the group summary. This is
     * the single entry point for all message-like notifications (groups, Concord
     * channels, DMs), giving the Discord/Signal-style "one growing thread per
     * conversation, collapsed under a summary" presentation.
     *
     * @param roomKey   stable conversation id (groupId / Concord `z` / "dm:<peer>")
     * @param roomTitle conversation display name (room name, or peer name for DMs)
     * @param url       in-app deep-link opened on tap
     * @param isGroup   true for multi-party rooms (shows the room title), false for 1:1 DMs
     * @param senderPubkey  message author (for the MessagingStyle Person key)
     * @param senderName    author display name
     * @param senderPicture author avatar URL (resolved async; optional)
     * @param text          the message line (already truncated/verb-substituted)
     * @param timestampMs   message time in ms (for ordering in the expansion)
     */
    private void enqueueRoomMessage(
            String roomKey, String roomTitle, String url, boolean isGroup,
            String senderPubkey, String senderName, String senderPicture,
            String text, long timestampMs) {
        // Build the Person now (without an avatar); post immediately, then re-post
        // with the avatar once loaded so image I/O never delays the notification.
        Bitmap cachedAvatar = senderPicture != null ? avatarCache.get(senderPicture) : null;
        postRoomMessage(roomKey, roomTitle, url, isGroup, senderPubkey, senderName,
                cachedAvatar, text, timestampMs, /*replaceLast=*/false, /*alert=*/true);

        if (senderPicture != null && !senderPicture.isEmpty() && cachedAvatar == null) {
            fetchAvatar(senderPicture, bmp -> {
                if (bmp != null) {
                    // Replace the just-added message line in-place with one that
                    // carries the avatar, then re-post the same room id. This is a
                    // silent refresh — the initial post already alerted, so don't
                    // vibrate/sound again just because the avatar finished loading.
                    postRoomMessage(roomKey, roomTitle, url, isGroup, senderPubkey, senderName,
                            bmp, text, timestampMs, /*replaceLast=*/true, /*alert=*/false);
                }
            });
        }
    }

    /**
     * Core builder: accumulate a message into its {@link RoomNotif} and post the
     * room's MessagingStyle notification + the group summary. When
     * {@code replaceLast} is set, the most recently appended message for this room
     * is swapped out (used to re-post the same line once its avatar resolves)
     * rather than appended again. {@code alert} false posts silently (no
     * vibration/sound) for in-place refreshes like a late-arriving avatar.
     */
    private void postRoomMessage(
            String roomKey, String roomTitle, String url, boolean isGroup,
            String senderPubkey, String senderName, Bitmap avatar,
            String text, long timestampMs, boolean replaceLast, boolean alert) {
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;

        RoomNotif room = roomNotifs.get(roomKey);
        if (room == null) {
            room = new RoomNotif(roomKey, hashId(roomKey));
            roomNotifs.put(roomKey, room);
        }
        room.title = roomTitle;
        room.url = url;
        room.isGroupConversation = isGroup;
        room.lastTimestampMs = Math.max(room.lastTimestampMs, timestampMs);

        Person.Builder pb = new Person.Builder()
                .setName(senderName != null ? senderName : "Someone")
                .setKey(senderPubkey != null ? senderPubkey : roomKey);
        if (avatar != null) pb.setIcon(IconCompat.createWithBitmap(avatar));
        Person sender = pb.build();

        NotificationCompat.MessagingStyle.Message msg =
                new NotificationCompat.MessagingStyle.Message(
                        text != null ? text : "", timestampMs, sender);

        if (replaceLast && !room.messages.isEmpty()) {
            room.messages.set(room.messages.size() - 1, msg);
        } else {
            room.messages.add(msg);
            // Bound the retained history so a chatty room can't grow unbounded.
            while (room.messages.size() > MAX_MESSAGES_PER_ROOM) {
                room.messages.remove(0);
            }
        }

        // Drop rooms the user already dismissed from the tray so the summary's
        // count/lines reflect only what's still showing (else a tapped/swiped
        // room lingers in the digest until the service restarts).
        pruneDismissedRooms(manager, room.notifId);

        manager.notify(room.notifId, buildRoomNotification(room, alert));
        manager.notify(SUMMARY_NOTIFICATION_ID, buildSummaryNotification());
    }

    /**
     * Remove from {@link #roomNotifs} any room whose notification is no longer in
     * the status bar (the user tapped/swiped it away), except {@code keepNotifId}
     * (the one we're about to (re)post). API 23+; a no-op on older devices.
     */
    private void pruneDismissedRooms(NotificationManager manager, int keepNotifId) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return;
        try {
            Set<Integer> active = new HashSet<>();
            for (android.service.notification.StatusBarNotification sbn : manager.getActiveNotifications()) {
                active.add(sbn.getId());
            }
            java.util.Iterator<Map.Entry<String, RoomNotif>> it = roomNotifs.entrySet().iterator();
            while (it.hasNext()) {
                RoomNotif r = it.next().getValue();
                if (r.notifId != keepNotifId && !active.contains(r.notifId)) {
                    it.remove();
                }
            }
        } catch (Exception ignored) {
            // getActiveNotifications can throw on some OEM builds — best-effort.
        }
    }

    /** Build a room's MessagingStyle notification from its accumulated messages. */
    private Notification buildRoomNotification(RoomNotif room, boolean alert) {
        // "You" is the local user; MessagingStyle needs a self Person to anchor
        // incoming vs. outgoing (we only post incoming, so this is just the label).
        Person self = new Person.Builder().setName("You").setKey(userPubkey != null ? userPubkey : "self").build();
        NotificationCompat.MessagingStyle style = new NotificationCompat.MessagingStyle(self);
        if (room.isGroupConversation) {
            style.setConversationTitle(room.title);
            style.setGroupConversation(true);
        } else {
            style.setGroupConversation(false);
        }
        for (NotificationCompat.MessagingStyle.Message m : room.messages) {
            style.addMessage(m);
        }

        NotificationCompat.Builder b = new NotificationCompat.Builder(this, MSG_CHANNEL_ID)
                .setStyle(style)
                .setSmallIcon(R.drawable.ic_stat_armada)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setContentIntent(roomPendingIntent(room))
                .setGroup(GROUP_KEY)
                .setAutoCancel(true)
                .setWhen(room.lastTimestampMs)
                // A silent refresh (e.g. late avatar) must not re-buzz; only a
                // genuine new message alerts.
                .setOnlyAlertOnce(!alert);
        if (alert) {
            b.setVibrate(MSG_VIBRATION_PATTERN)
                    .setDefaults(NotificationCompat.DEFAULT_LIGHTS | NotificationCompat.DEFAULT_SOUND);
        }
        return b.build();
    }

    /**
     * Build the InboxStyle group summary: a digest of the active rooms with the
     * total unread count. Android shows this when the room notifications are
     * collapsed into the group (Discord/Signal-style stack).
     */
    private Notification buildSummaryNotification() {
        NotificationCompat.InboxStyle inbox = new NotificationCompat.InboxStyle();
        int totalMessages = 0;
        // Newest rooms first.
        List<RoomNotif> rooms = new ArrayList<>(roomNotifs.values());
        rooms.sort((a, c) -> Long.compare(c.lastTimestampMs, a.lastTimestampMs));
        for (RoomNotif room : rooms) {
            int count = room.messages.size();
            totalMessages += count;
            // One digest line per room: "<room> · <N new>" or the latest sender.
            NotificationCompat.MessagingStyle.Message last =
                    room.messages.isEmpty() ? null : room.messages.get(room.messages.size() - 1);
            CharSequence whoCs = last != null && last.getPerson() != null ? last.getPerson().getName() : null;
            String who = whoCs != null ? whoCs.toString() : null;
            String line = room.isGroupConversation && room.title != null
                    ? room.title + (count > 1 ? " · " + count + " new" : (who != null ? " · " + who : ""))
                    : (room.title != null ? room.title : (who != null ? who : "New message"));
            inbox.addLine(line);
        }
        String summaryText = roomNotifs.size() == 1
                ? totalMessages + (totalMessages == 1 ? " new message" : " new messages")
                : roomNotifs.size() + " conversations";
        inbox.setSummaryText(summaryText);

        return new NotificationCompat.Builder(this, MSG_CHANNEL_ID)
                .setContentTitle("Armada")
                .setContentText(summaryText)
                .setStyle(inbox)
                .setSmallIcon(R.drawable.ic_stat_armada)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setGroup(GROUP_KEY)
                .setGroupSummary(true)
                // The child (room) notification owns the alert (vibration/sound),
                // so posting the summary alongside it doesn't double-buzz.
                .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN)
                .setAutoCancel(true)
                .build();
    }

    /** Deep-link tap intent for a room, keyed by the room's stable notif id. */
    private PendingIntent roomPendingIntent(RoomNotif room) {
        Intent intent = new Intent(this, MainActivity.class);
        String url = room.url != null ? room.url : "/";
        // ACTION_VIEW is REQUIRED: Capacitor's @capacitor/app plugin only surfaces
        // the launch URL (getLaunchUrl / appUrlOpen) for an intent whose action is
        // ACTION_VIEW. Without it the data URI is present but ignored, so a
        // notification tap delivers the intent yet the web layer never navigates.
        intent.setAction(Intent.ACTION_VIEW);
        intent.setData(Uri.parse("armada://open" + url));
        intent.putExtra("armada_path", url);
        intent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(
                this, room.notifId, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
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

        // Retire the old message channel so the stronger vibration + HIGH
        // importance below apply on upgrades (channel settings can't be edited
        // in place — only a fresh channel id picks up the new config).
        try {
            m.deleteNotificationChannel(MSG_CHANNEL_ID_LEGACY);
        } catch (Exception ignored) {
            // Channel may not exist (fresh install) — nothing to retire.
        }

        NotificationChannel msg = new NotificationChannel(
                MSG_CHANNEL_ID, "Notifications", NotificationManager.IMPORTANCE_HIGH);
        msg.setDescription("Mentions, replies, reactions and direct messages");
        msg.enableVibration(true);
        msg.setVibrationPattern(MSG_VIBRATION_PATTERN);
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

    /**
     * Stable, collision-resistant notification id for a key (a room key or event
     * id). Hashes the WHOLE string (not a prefix) so distinct rooms sharing a
     * common prefix — e.g. two groups on the same relay ("h:wss://r|a" vs
     * "h:wss://r|b") — never collapse into one notification. Kept below the
     * summary's reserved id.
     */
    private static int hashId(String id) {
        if (id == null) return 2;
        int hash = 0;
        for (int i = 0; i < id.length(); i++) {
            hash = ((hash << 5) - hash) + id.charAt(i);
        }
        return (Math.abs(hash) % ROOM_ID_MODULUS) + 2;
    }
}
