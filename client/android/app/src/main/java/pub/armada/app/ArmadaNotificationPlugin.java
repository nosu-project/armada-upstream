package pub.armada.app;

import android.app.ForegroundServiceStartNotAllowedException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Log;

import androidx.core.app.NotificationManagerCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONArray;

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

    @PluginMethod
    public void configure(PluginCall call) {
        boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        String userPubkey = call.getString("userPubkey");

        String relayUrlsRaw = arrayToString(call.getArray("relayUrls"));
        String groupIdsRaw = arrayToString(call.getArray("groupIds"));
        String dmRelaysRaw = arrayToString(call.getArray("dmRelays"));
        String concordSubsRaw = arrayToString(call.getArray("concordSubs"));
        // prefs is a flat object of booleans; store its JSON verbatim.
        String prefsRaw = null;
        try {
            if (call.getObject("prefs") != null) {
                prefsRaw = call.getObject("prefs").toString();
            }
        } catch (Exception e) {
            Log.w(TAG, "Failed to read prefs", e);
        }

        SharedPreferences prefs = getContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        boolean hasWatch = relayUrlsRaw != null || concordSubsRaw != null || dmRelaysRaw != null;
        boolean hasConfig = enabled && userPubkey != null && hasWatch;

        if (hasConfig) {
            SharedPreferences.Editor editor = prefs.edit()
                    .putBoolean("enabled", true)
                    .putString("userPubkey", userPubkey)
                    .putString("relayUrls", relayUrlsRaw != null ? relayUrlsRaw : "[]");
            if (groupIdsRaw != null) editor.putString("groupIds", groupIdsRaw);
            else editor.remove("groupIds");
            if (dmRelaysRaw != null) editor.putString("dmRelays", dmRelaysRaw);
            else editor.remove("dmRelays");
            if (concordSubsRaw != null) editor.putString("concordSubs", concordSubsRaw);
            else editor.remove("concordSubs");
            if (prefsRaw != null) editor.putString("prefs", prefsRaw);
            // Bump a revision so the running service's SharedPreferences
            // listener always fires even if the values look unchanged.
            editor.putLong("rev", System.currentTimeMillis());
            editor.apply();
            if (BuildConfig.DEBUG) Log.d(TAG, "Configured: relays=" + relayUrlsRaw + " groups=" + groupIdsRaw
                    + " dmRelays=" + dmRelaysRaw
                    + " concordSubs=" + (concordSubsRaw != null ? "yes" : "none"));
        } else {
            prefs.edit().clear().apply();
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
            ctx.stopService(serviceIntent);
            Log.d(TAG, "Stopped NotificationRelayService");
        }
    }

    private static String arrayToString(JSONArray arr) {
        return arr != null ? arr.toString() : null;
    }
}
