package buzz.armada.app;

import android.content.Intent;
import android.os.Build;
import android.util.Log;

import androidx.annotation.Nullable;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Capacitor bridge over {@link CallForegroundService}: the web layer's call
 * lifecycle (useCallForegroundService.ts) turns into the ongoing-call
 * notification and the foreground state that keeps a backgrounded call alive.
 *
 * JS calls:
 *   - start({ title, text, icon })  → post/refresh the ongoing notification
 *                                     and hold the call's audio session
 *   - stop()                        → tear both down
 *   - setMic({ muted, published })  → the mute button's state
 *   - listRoutes()                  → the call's output routes (CallRouteSelector)
 *   - selectRoute({ id })           → apply one for the rest of the call
 *
 * Events emitted to JS:
 *   - "hangup" — the notification's hang-up button was tapped
 *   - "toggleMute" — the notification's mute button was tapped
 *   - "routesChanged" — a route appeared, left, or the active one switched
 *
 * Android-only. There is no iOS counterpart (an iOS call needs CallKit, which
 * is a different shape entirely), so the web layer gates on the platform
 * explicitly rather than on isNativePlatform().
 */
@CapacitorPlugin(name = "ArmadaCall")
public class ArmadaCallPlugin extends Plugin {
    private static final String TAG = "ArmadaCallPlugin";

    /**
     * The live plugin instance, so the service can push a "Leave" tap back to
     * the web layer. Null when the WebView isn't up — in which case there is no
     * call to leave either, since the room only exists inside it.
     */
    @Nullable
    private static ArmadaCallPlugin instance;

    @Nullable
    private CallAudioSession audioSession;
    /** Null below Android 12, where there is no communication-device API. */
    @Nullable
    private CallRouteSelector routes;

    @Override
    public void load() {
        super.load();
        instance = this;
        audioSession = new CallAudioSession(getContext());
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            routes = new CallRouteSelector(getContext(),
                    snapshot -> notifyListeners("routesChanged", snapshot, false));
        }
    }

    @Override
    protected void handleOnDestroy() {
        if (instance == this) instance = null;
        if (routes != null) routes.end();
        if (audioSession != null) audioSession.end();
        // A destroyed WebView has taken the LiveKit room with it, so the
        // notification would be advertising a call that no longer exists.
        try {
            getContext().stopService(new Intent(getContext(), CallForegroundService.class));
        } catch (Exception ignored) {
        }
        super.handleOnDestroy();
    }

    /** Called from the service when the notification's "Leave" action fires. */
    static void notifyHangup() {
        ArmadaCallPlugin plugin = instance;
        if (plugin == null) return;
        // Retained until consumed: the tap can land while the WebView is
        // backgrounded and its listeners have yet to be re-attached.
        plugin.notifyListeners("hangup", new JSObject(), true);
    }

    @PluginMethod
    public void start(PluginCall call) {
        String title = call.getString("title");
        String text = call.getString("text");
        Intent intent = new Intent(getContext(), CallForegroundService.class);
        intent.setAction(CallForegroundService.ACTION_UPDATE);
        intent.putExtra(CallForegroundService.EXTRA_TITLE,
                title != null && !title.isEmpty() ? title : "Voice call");
        intent.putExtra(CallForegroundService.EXTRA_TEXT, text != null ? text : "");
        intent.putExtra(CallForegroundService.EXTRA_ICON, call.getString("icon", ""));
        // Before the service: the call's audio behaviour doesn't depend on the notification.
        if (audioSession != null) audioSession.begin();
        if (routes != null) routes.begin();
        try {
            // startService(), not startForegroundService(): joining a call is a
            // foreground user gesture, so the background-start restriction this
            // would be refused by does not apply — and startForegroundService()
            // is a 10-second promise to call startForeground() that buys
            // nothing here. A refusal costs the notification, not the call.
            getContext().startService(intent);
            call.resolve();
        } catch (Exception e) {
            Log.w(TAG, "Could not start the call foreground service", e);
            call.reject("Could not start the call service: " + e.getMessage(), e);
        }
    }

    static void notifyToggleMute() {
        ArmadaCallPlugin plugin = instance;
        if (plugin == null) return;
        // Not retained: a toggle replayed later would flip the mic unasked.
        plugin.notifyListeners("toggleMute", new JSObject(), false);
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        if (CallForegroundService.ACTION_TOGGLE_MUTE.equals(intent.getAction())) notifyToggleMute();
    }

    @PluginMethod
    public void setMic(PluginCall call) {
        // Never starts the service: a report racing a hang-up must not resurrect it.
        CallForegroundService.updateMic(
                Boolean.TRUE.equals(call.getBoolean("muted", true)),
                Boolean.TRUE.equals(call.getBoolean("published", false)));
        call.resolve();
    }

    @PluginMethod
    public void listRoutes(PluginCall call) {
        call.resolve(routes != null ? routes.snapshot() : unsupportedRoutes());
    }

    @PluginMethod
    public void selectRoute(PluginCall call) {
        Integer id = call.getInt("id");
        if (id == null) {
            call.reject("id is required");
            return;
        }
        JSObject result = new JSObject();
        result.put("ok", routes != null && routes.select(id));
        call.resolve(result);
    }

    private static JSObject unsupportedRoutes() {
        JSObject out = new JSObject();
        out.put("supported", false);
        out.put("routes", new JSArray());
        out.put("active", JSObject.NULL);
        return out;
    }

    @PluginMethod
    public void stop(PluginCall call) {
        if (routes != null) routes.end();
        if (audioSession != null) audioSession.end();
        try {
            getContext().stopService(new Intent(getContext(), CallForegroundService.class));
        } catch (Exception e) {
            Log.w(TAG, "Could not stop the call foreground service", e);
        }
        call.resolve();
    }
}
