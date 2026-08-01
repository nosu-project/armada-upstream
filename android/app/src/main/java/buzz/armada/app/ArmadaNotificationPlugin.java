package buzz.armada.app;

import android.app.ForegroundServiceStartNotAllowedException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import android.util.Log;

import androidx.core.app.NotificationManagerCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import buzz.armada.app.db.ServiceStore;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Capacitor bridge that lets the web layer configure the native background
 * notification service.
 *
 * The web app calls {@code configure({ enabled, userPubkey, relayUrls,
 * groupIds, prefs })}. We persist the config to SharedPreferences (the running
 * service watches it and re-subscribes on change) and start/stop the
 * {@link NotificationRelayService} foreground service accordingly.
 *
 * This is a fully de-Googled instant-push path: the service holds a persistent
 * Nostr REQ to the relay, so notifications fire the moment an event arrives —
 * no FCM, no Web Push, no polling.
 */
@CapacitorPlugin(
        name = "ArmadaNotification",
        permissions = {
                @Permission(alias = "notifications", strings = { android.Manifest.permission.POST_NOTIFICATIONS })
        }
)
public class ArmadaNotificationPlugin extends Plugin {

    private static final String TAG = "ArmadaNotifPlugin";
    static final String PREFS_NAME = "armada_notification_config";

    /**
     * Live plugin instance, so the background service can reach back into the
     * Capacitor bridge to ask the WebView's signer for a NIP-42 signature.
     * Null when the activity/bridge isn't up (WebView dead) — the service then
     * simply can't authenticate until the app is reopened.
     */
    private static ArmadaNotificationPlugin instance;

    @Override
    public void load() {
        super.load();
        instance = this;
    }

    @Override
    protected void handleOnDestroy() {
        if (instance == this) instance = null;
        super.handleOnDestroy();
    }

    /**
     * Emit a NIP-42 challenge to the JS layer so it can sign a kind-22242 with
     * the user's signer (nsec/bunker/extension — all handled in the WebView).
     * Returns false if the bridge isn't available (WebView not running).
     */
    static boolean emitAuthChallenge(String relayUrl, String challenge) {
        ArmadaNotificationPlugin p = instance;
        if (p == null) return false;
        JSObject data = new JSObject();
        data.put("relayUrl", relayUrl);
        data.put("challenge", challenge);
        p.notifyListeners("authChallenge", data);
        return true;
    }

    /** Max rows per drainEvents page (the JS side loops until empty). */
    private static final int DRAIN_PAGE = 500;

    /**
     * SharedPreferences file holding pending "Mark read" markers the service
     * recorded from notification-action taps, for the WebView to drain and apply
     * to the in-app read state on its next open/resume. One JSON object under
     * key "markers": {@code {roomKey: {ts, channelId?}, …}} — keyed by room so a
     * later tap in the same room just raises the (monotonic) timestamp.
     */
    static final String READ_MARKERS_PREFS = "armada_read_markers";
    private static final String READ_MARKERS_KEY = "markers";
    /** Guards the read-modify-write of the read-marker map (service ⇄ bridge). */
    private static final Object READ_MARKERS_LOCK = new Object();

    /**
     * Record a "Mark read" marker (called by the service on an action tap). Keyed
     * by room, monotonic in timestamp. {@code channelId} carries the Concord V1
     * channel id (the roomKey holds only the per-epoch `z` pseudonym); null for
     * every other room type, which the WebView derives from the room key itself.
     */
    static void enqueueReadMarker(Context ctx, String roomKey, long tsSec, String channelId) {
        if (ctx == null || roomKey == null || roomKey.isEmpty()) return;
        synchronized (READ_MARKERS_LOCK) {
            SharedPreferences sp = ctx.getSharedPreferences(READ_MARKERS_PREFS, Context.MODE_PRIVATE);
            try {
                JSONObject map;
                try {
                    map = new JSONObject(sp.getString(READ_MARKERS_KEY, "{}"));
                } catch (Exception e) {
                    map = new JSONObject();
                }
                JSONObject existing = map.optJSONObject(roomKey);
                long prev = existing != null ? existing.optLong("ts", 0L) : 0L;
                if (tsSec >= prev) {
                    JSONObject entry = new JSONObject();
                    entry.put("ts", tsSec);
                    if (channelId != null && !channelId.isEmpty()) entry.put("channelId", channelId);
                    map.put(roomKey, entry);
                    sp.edit().putString(READ_MARKERS_KEY, map.toString()).apply();
                }
            } catch (Exception e) {
                Log.w(TAG, "enqueueReadMarker failed", e);
            }
        }
    }

    /** Drop all pending read markers (on logout / disable, so they don't cross accounts). */
    private static void clearReadMarkers(Context ctx) {
        synchronized (READ_MARKERS_LOCK) {
            ctx.getSharedPreferences(READ_MARKERS_PREFS, Context.MODE_PRIVATE).edit().clear().apply();
        }
    }

    /**
     * Rolling per-room cache of raw outer events, keyed by room
     * ("h:<groupId>" / "z:<pseudonym>" / "c2:<channelId>" / "dm"), newest last.
     * Unlike {@link #eventBuffer} (a one-shot drain of what arrived while the
     * WebView was down, shared across ALL rooms), this survives drains and
     * retains the last screenful per room for the service's lifetime — so
     * opening a room from a notification can paint natively-received history
     * even when the global buffer overflowed or was already drained. LRU-bounded.
     */
    private static final int ROOM_CACHE_MAX_ROOMS = 24;
    private static final int ROOM_CACHE_MAX_EVENTS = 30;
    private static final java.util.LinkedHashMap<String, java.util.ArrayDeque<String>> roomEvents =
            new java.util.LinkedHashMap<String, java.util.ArrayDeque<String>>(16, 0.75f, /*accessOrder=*/true) {
                @Override
                protected boolean removeEldestEntry(java.util.Map.Entry<String, java.util.ArrayDeque<String>> eldest) {
                    return size() > ROOM_CACHE_MAX_ROOMS;
                }
            };

    /** Record an event into its room's rolling cache (no-op without a room key). */
    private static void recordRoomEvent(String roomKey, String eventJson) {
        if (roomKey == null || eventJson == null) return;
        synchronized (roomEvents) {
            java.util.ArrayDeque<String> q = roomEvents.get(roomKey);
            if (q == null) {
                q = new java.util.ArrayDeque<>();
                roomEvents.put(roomKey, q);
            }
            if (q.size() >= ROOM_CACHE_MAX_EVENTS) q.pollFirst();
            q.addLast(eventJson);
        }
    }

    /**
     * Hand a raw outer event (the wire JSON the service received) to the WebView.
     * Emits live when the bridge is up; durability is the shared database (the
     * service already wrote the event before calling this — see
     * NotificationRelayService.handleEvent), which the WebView drains by cursor
     * on open/resume. Also recorded in the per-room rolling cache regardless of
     * bridge state. Same event for NIP-29 (kind 9/1068/…), DMs (kind 4,
     * ciphertext) and Concord (sealed kind 3300 / wrapped kind 1059) — the
     * WebView routes it through wire ingest and its read path decodes it.
     *
     * @param roomKey per-room cache key ("h:<groupId>" / "z:<z>" / "dm"), or
     *                null to skip the room cache.
     */
    static void feedRelayEvent(String roomKey, String eventJson) {
        if (eventJson == null) return;
        recordRoomEvent(roomKey, eventJson);
        ArmadaNotificationPlugin p = instance;
        if (p != null) {
            JSObject data = new JSObject();
            data.put("event", eventJson);
            p.notifyListeners("relayEvent", data);
        }
    }

    /**
     * Concord inner events the service ALREADY decrypted (it holds the channel
     * key to render the notification). Buffered like {@link #eventBuffer} so a
     * cold-launched app drains them too. Each entry is a 3-line tuple:
     * inner-event JSON, the outer `z` pseudonym, and the outer event id — enough
     * for the WebView to bind it to a held epoch, verify the inner Schnorr
     * signature, and fold it in WITHOUT re-decrypting or hitting the relay.
     */
    private static final java.util.ArrayDeque<String[]> concordBuffer = new java.util.ArrayDeque<>();
    private static final int CONCORD_BUFFER_MAX = 200;

    /**
     * Hand a decrypted Concord inner event to the WebView. The WebView still
     * fully verifies it (the service only checked HMAC + channel/epoch binding,
     * not the author's Schnorr signature), so a forged inner is dropped there.
     * Emits live if the bridge is up; otherwise buffers for the next drain.
     */
    static void feedConcordInner(String innerJson, String z, String outerId) {
        if (innerJson == null || z == null || outerId == null) return;
        ArmadaNotificationPlugin p = instance;
        if (p != null) {
            JSObject data = new JSObject();
            data.put("inner", innerJson);
            data.put("z", z);
            data.put("outerId", outerId);
            p.notifyListeners("concordMessage", data);
            return;
        }
        synchronized (concordBuffer) {
            if (concordBuffer.size() >= CONCORD_BUFFER_MAX) concordBuffer.pollFirst();
            concordBuffer.addLast(new String[] { innerJson, z, outerId });
        }
    }

    /**
     * Drain a page of the events the service ingested, oldest first. Returns
     * { events: [json, …], ids }; the JS layer routes them through wire ingest
     * and then calls {@link #ackDrain} with those ids — peek+ack, so a WebView
     * crash mid-page replays instead of losing events, and a service restart
     * loses nothing (the queue is a durable ArmadaDB tenant). Concord decrypted
     * inners are a SEPARATE buffer — see drainConcord.
     *
     * This is ROUTING, not storage: the events themselves are already in the
     * tenants the WebView reads (the service wrote them there), and what a drain
     * still buys is a pass through ingest — parking undecryptable wraps, ringing
     * the scopes that repaint a timeline, feeding notification candidates.
     */
    @PluginMethod
    public void drainEvents(PluginCall call) {
        ServiceStore.Page page = ServiceStore.drain(getContext(), DRAIN_PAGE);
        JSArray events = new JSArray();
        for (String event : page.getEvents()) events.put(event);
        JSArray ids = new JSArray();
        for (String id : page.getIds()) ids.put(id);

        JSObject ret = new JSObject();
        ret.put("events", events);
        ret.put("ids", ids);
        call.resolve(ret);
    }

    /** Drop an acknowledged page from the queue, once the JS layer has ingested it. */
    @PluginMethod
    public void ackDrain(PluginCall call) {
        JSArray ids = call.getArray("ids");
        if (ids != null) {
            try {
                ServiceStore.ackDrain(getContext(), ids.toList());
            } catch (org.json.JSONException e) {
                Log.w(TAG, "ackDrain failed", e);
            }
        }
        call.resolve();
    }

    /**
     * Return (without consuming) the rolling per-room cache for one room —
     * the newest raw outer events the service received for it this service
     * lifetime. Keys: "h:<groupId>", "z:<pseudonym>", "c2:<channelId>", "dm".
     * The JS layer merges them by event id, so re-reads are idempotent.
     */
    @PluginMethod
    public void getRoomEvents(PluginCall call) {
        String room = call.getString("room");
        JSArray arr = new JSArray();
        if (room != null) {
            synchronized (roomEvents) {
                java.util.ArrayDeque<String> q = roomEvents.get(room);
                if (q != null) {
                    for (String e : q) arr.put(e);
                }
            }
        }
        JSObject ret = new JSObject();
        ret.put("events", arr);
        call.resolve(ret);
    }

    /**
     * Drain buffered Concord inner events the service already decrypted. Returns
     * { concord: [{ inner, z, outerId }, …] }. The open channel verifies each
     * inner's signature + binding and folds it straight in — no second decrypt,
     * no relay round-trip.
     */
    @PluginMethod
    public void drainConcord(PluginCall call) {
        JSArray concord = new JSArray();
        synchronized (concordBuffer) {
            String[] c;
            while ((c = concordBuffer.pollFirst()) != null) {
                JSObject o = new JSObject();
                o.put("inner", c[0]);
                o.put("z", c[1]);
                o.put("outerId", c[2]);
                concord.put(o);
            }
        }
        JSObject ret = new JSObject();
        ret.put("concord", concord);
        call.resolve(ret);
    }

    /**
     * Drain (and clear) the pending "Mark read" markers the service recorded
     * from notification-action taps. Returns { markers: [{ room, ts, channelId? },
     * …] }; the JS layer maps each room key to the right per-protocol read-state
     * write. Consumed once — a clean drain, since read state is monotonic so a
     * lost marker is at worst a stale badge the next real read corrects.
     */
    @PluginMethod
    public void drainReadMarkers(PluginCall call) {
        JSArray markers = new JSArray();
        synchronized (READ_MARKERS_LOCK) {
            SharedPreferences sp = getContext().getSharedPreferences(READ_MARKERS_PREFS, Context.MODE_PRIVATE);
            String raw = sp.getString(READ_MARKERS_KEY, null);
            if (raw != null) {
                try {
                    JSONObject map = new JSONObject(raw);
                    java.util.Iterator<String> keys = map.keys();
                    while (keys.hasNext()) {
                        String room = keys.next();
                        JSONObject entry = map.optJSONObject(room);
                        if (entry == null) continue;
                        JSObject o = new JSObject();
                        o.put("room", room);
                        o.put("ts", entry.optLong("ts", 0L));
                        String channelId = entry.optString("channelId", null);
                        if (channelId != null && !channelId.isEmpty()) o.put("channelId", channelId);
                        markers.put(o);
                    }
                } catch (Exception e) {
                    Log.w(TAG, "drainReadMarkers parse failed", e);
                }
                sp.edit().remove(READ_MARKERS_KEY).apply();
            }
        }
        JSObject ret = new JSObject();
        ret.put("markers", markers);
        call.resolve(ret);
    }

    /**
     * Receive a signed kind-22242 event from JS and hand it to the running
     * service to send as ["AUTH", event] on the matching relay connection.
     */
    @PluginMethod
    public void submitAuth(PluginCall call) {
        String relayUrl = call.getString("relayUrl");
        try {
            if (relayUrl != null && call.getObject("event") != null) {
                NotificationRelayService.submitAuth(relayUrl, call.getObject("event").toString());
            }
        } catch (Exception e) {
            Log.w(TAG, "submitAuth failed", e);
        }
        call.resolve();
    }

    /** Whether the POST_NOTIFICATIONS runtime permission is granted (always true < API 33). */
    @PluginMethod
    public void checkPermission(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("granted", hasNotificationPermission());
        call.resolve(ret);
    }

    /** Request POST_NOTIFICATIONS (API 33+). Resolves { granted } either way. */
    @PluginMethod
    public void requestPermission(PluginCall call) {
        if (hasNotificationPermission()) {
            JSObject ret = new JSObject();
            ret.put("granted", true);
            call.resolve(ret);
            return;
        }
        requestPermissionForAlias("notifications", call, "permissionCallback");
    }

    @PermissionCallback
    private void permissionCallback(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("granted", hasNotificationPermission());
        call.resolve(ret);
    }

    private boolean hasNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return NotificationManagerCompat.from(getContext()).areNotificationsEnabled();
        }
        return getContext().checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED;
    }

    /**
     * Check whether the app is exempt from battery optimizations (Doze).
     *
     * Battery optimization tears down the persistent relay websockets while
     * the device is idle, and on Android 15+ an exemption is also what permits
     * restarting the foreground service from the boot-retry alarm (see
     * BootReceiver). The settings UI uses this to decide whether to show the
     * exemption prompt.
     */
    @PluginMethod
    public void isIgnoringBatteryOptimizations(PluginCall call) {
        PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        boolean ignoring = pm != null && pm.isIgnoringBatteryOptimizations(getContext().getPackageName());
        JSObject ret = new JSObject();
        ret.put("ignoring", ignoring);
        call.resolve(ret);
    }

    /**
     * Show the system dialog asking the user to exempt Armada from battery
     * optimizations (one tap: "Allow"). Falls back to the battery
     * optimization settings list on OEM builds that don't handle the direct
     * request intent.
     */
    @PluginMethod
    public void requestIgnoreBatteryOptimizations(PluginCall call) {
        try {
            Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            intent.setData(Uri.parse("package:" + getContext().getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            Log.w(TAG, "Direct battery optimization request failed, opening settings list", e);
            try {
                Intent fallback = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
                fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(fallback);
                call.resolve();
            } catch (Exception e2) {
                call.reject("Unable to open battery optimization settings", e2);
            }
        }
    }

    /**
     * Tell the running service which roomKey(s) the WebView is currently
     * showing (so it can suppress redundant notifications for those rooms — the
     * live timeline already paints the message). Pass an empty array / omit
     * when the app is backgrounded or on a non-chat screen. The value is
     * volatile: it lives only on the running service instance, so killing the
     * app or the service immediately resumes notifications.
     *
     * A set (not a single key) because a Concord V1 channel can span multiple
     * rekey epochs, each with its own {@code z} pseudonym — and thus multiple
     * roomKeys — all of which are "active" simultaneously.
     *
     * Room-key shapes (must match the service's enqueueRoomMessage keys):
     *   - NIP-29 group: {@code "h:<relayUrl>|<groupId>"}
     *   - Concord V1:   {@code "z:<pseudonym>"}
     *   - Concord V2:   {@code "c2:<channelIdHex>"}
     *   - DM:           {@code "dm:<peerPubkey>"}
     */
    @PluginMethod
    public void setActiveRooms(PluginCall call) {
        JSArray arr = call.getArray("roomKeys");
        java.util.Set<String> set = new java.util.HashSet<>();
        if (arr != null) {
            try {
                for (int i = 0; i < arr.length(); i++) {
                    String k = arr.optString(i);
                    if (k != null && !k.isEmpty()) set.add(k);
                }
            } catch (Exception e) {
                Log.w(TAG, "Failed to read roomKeys", e);
            }
        }
        NotificationRelayService.setActiveRooms(set);
        call.resolve();
    }

    /**
     * Cancel tray notifications for conversations the WebView reports as read.
     * Payload: {@code { markers: [{ room, ts }, …] }} where {@code room} is the
     * WebView's read-state key (`dm:<pk>` / `c2:<id>` / `c1:<id>` /
     * `<relayUrl>::<groupId>`) and {@code ts} the last-read unix seconds. The
     * running service cancels each matching room whose newest notified message
     * is at/older than that stamp — the reverse of a "Mark read" tap. No-op when
     * the service isn't running (nothing posted) or on web/iOS.
     */
    @PluginMethod
    public void dismissRead(PluginCall call) {
        JSArray arr = call.getArray("markers");
        java.util.Map<String, Long> map = new java.util.HashMap<>();
        if (arr != null) {
            try {
                for (int i = 0; i < arr.length(); i++) {
                    JSONObject o = arr.optJSONObject(i);
                    if (o == null) continue;
                    String room = o.optString("room", null);
                    if (room == null || room.isEmpty()) continue;
                    long ts = o.optLong("ts", 0L);
                    if (ts <= 0) continue;
                    Long prev = map.get(room);
                    if (prev == null || ts > prev) map.put(room, ts);
                }
            } catch (Exception e) {
                Log.w(TAG, "dismissRead parse failed", e);
            }
        }
        if (!map.isEmpty()) NotificationRelayService.dismissRead(map);
        call.resolve();
    }

    @PluginMethod
    public void configure(PluginCall call) {
        boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        String userPubkey = call.getString("userPubkey");

        String relayUrlsRaw = arrayToString(call.getArray("relayUrls"));
        String groupIdsRaw = arrayToString(call.getArray("groupIds"));
        String groupSubsRaw = arrayToString(call.getArray("groupSubs"));
        String dmRelaysRaw = arrayToString(call.getArray("dmRelays"));
        String dmFollowsRaw = arrayToString(call.getArray("dmFollows"));
        String concordSubsRaw = arrayToString(call.getArray("concordSubs"));
        String concord2SubsRaw = arrayToString(call.getArray("concord2Subs"));
        String gitSubsRaw = arrayToString(call.getArray("gitSubs"));
        // prefs is a flat object of booleans; store its JSON verbatim.
        String prefsRaw = null;
        try {
            if (call.getObject("prefs") != null) {
                prefsRaw = call.getObject("prefs").toString();
            }
        } catch (Exception e) {
            Log.w(TAG, "Failed to read prefs", e);
        }
        // The shared signer credential ({type:"key"|"amber"|"nip46", …} — see
        // NativeSigner). Secret-bearing, so it is sealed with an Android
        // Keystore key before touching SharedPreferences and wiped with the
        // rest of the config on disable/logout.
        String signerSealed = null;
        try {
            if (call.getObject("signer") != null) {
                signerSealed = SealedStore.seal(call.getObject("signer").toString());
                if (signerSealed == null) Log.w(TAG, "Failed to seal signer credential");
            }
        } catch (Exception e) {
            Log.w(TAG, "Failed to read signer", e);
        }

        SharedPreferences prefs = getContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        boolean hasWatch = relayUrlsRaw != null || concordSubsRaw != null || concord2SubsRaw != null
                || dmRelaysRaw != null;
        boolean hasConfig = enabled && userPubkey != null && hasWatch;

        if (hasConfig) {
            SharedPreferences.Editor editor = prefs.edit()
                    .putBoolean("enabled", true)
                    .putString("userPubkey", userPubkey)
                    .putString("relayUrls", relayUrlsRaw != null ? relayUrlsRaw : "[]");
            if (groupIdsRaw != null) editor.putString("groupIds", groupIdsRaw);
            else editor.remove("groupIds");
            if (groupSubsRaw != null) editor.putString("groupSubs", groupSubsRaw);
            else editor.remove("groupSubs");
            if (dmRelaysRaw != null) editor.putString("dmRelays", dmRelaysRaw);
            else editor.remove("dmRelays");
            if (dmFollowsRaw != null) editor.putString("dmFollows", dmFollowsRaw);
            else editor.remove("dmFollows");
            if (concordSubsRaw != null) editor.putString("concordSubs", concordSubsRaw);
            else editor.remove("concordSubs");
            if (concord2SubsRaw != null) editor.putString("concord2Subs", concord2SubsRaw);
            else editor.remove("concord2Subs");
            if (signerSealed != null) editor.putString("signerSealed", signerSealed);
            else editor.remove("signerSealed");
            if (gitSubsRaw != null) editor.putString("gitSubs", mergeGitRoots(prefs.getString("gitSubs", null), gitSubsRaw));
            else editor.remove("gitSubs");
            // Versioned only for the additive Git plane. Existing installations
            // without this key retain their message/DM configuration unchanged.
            editor.putInt("schemaVersion", 2);
            if (prefsRaw != null) editor.putString("prefs", prefsRaw);
            // Bump a revision so the running service's SharedPreferences
            // listener always fires even if the values look unchanged.
            editor.putLong("rev", System.currentTimeMillis());
            editor.apply();
            if (BuildConfig.DEBUG) Log.d(TAG, "Configured: relays=" + relayUrlsRaw + " groups=" + groupIdsRaw
                    + " dmRelays=" + dmRelaysRaw
                    + " concordSubs=" + (concordSubsRaw != null ? "yes" : "none")
                    + " concord2Subs=" + (concord2SubsRaw != null ? "yes" : "none"));
        } else {
            prefs.edit().clear().apply();
            // Drop any un-drained read markers too, so they can't apply to a
            // different account after a logout/switch.
            clearReadMarkers(getContext());
            Log.d(TAG, "Config cleared (disabled or logged out)");
        }

        manageService(hasConfig);
        call.resolve();
    }

    private void manageService(boolean start) {
        Context ctx = getContext();
        Intent serviceIntent = new Intent(ctx, NotificationRelayService.class);
        if (start) {
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    ctx.startForegroundService(serviceIntent);
                } else {
                    ctx.startService(serviceIntent);
                }
                Log.d(TAG, "Started NotificationRelayService");
            } catch (Exception e) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                        && e instanceof ForegroundServiceStartNotAllowedException) {
                    Log.w(TAG, "Could not start foreground service: " + e.getMessage());
                } else {
                    Log.w(TAG, "Failed to start service", e);
                }
            }
        } else {
            BootReceiver.cancelWatchdog(ctx);
            ctx.stopService(serviceIntent);
            Log.d(TAG, "Stopped NotificationRelayService");
        }
    }

    private static String arrayToString(JSONArray arr) {
        return arr != null ? arr.toString() : null;
    }

    /** Keep roots dynamically learned by the service if a WebView config refresh
     * races before IndexedDB has observed them. Attachments/relays always come
     * from the fresh verified web config; only public ticket ids are merged. */
    private static String mergeGitRoots(String oldJson, String nextJson) {
        if (oldJson == null) return nextJson;
        try {
            JSONArray oldRepos = new JSONArray(oldJson), nextRepos = new JSONArray(nextJson);
            for (int i = 0; i < nextRepos.length(); i++) {
                org.json.JSONObject next = nextRepos.optJSONObject(i); if (next == null) continue;
                String address = next.optString("address", "");
                org.json.JSONObject old = null;
                for (int j = 0; j < oldRepos.length(); j++) { org.json.JSONObject candidate = oldRepos.optJSONObject(j); if (candidate != null && address.equals(candidate.optString("address"))) { old = candidate; break; } }
                if (old == null) continue;
                JSONArray roots = next.optJSONArray("ticketRoots"); if (roots == null) next.put("ticketRoots", roots = new JSONArray());
                JSONArray oldRoots = old.optJSONArray("ticketRoots"); if (oldRoots == null) continue;
                for (int j = 0; j < oldRoots.length(); j++) {
                    org.json.JSONObject root = oldRoots.optJSONObject(j); if (root == null) continue;
                    boolean exists = false; for (int k = 0; k < roots.length(); k++) { org.json.JSONObject present = roots.optJSONObject(k); if (present != null && root.optString("id").equals(present.optString("id"))) exists = true; }
                    if (!exists) roots.put(root);
                }
            }
            return nextRepos.toString();
        } catch (Exception ignored) { return nextJson; }
    }
}
