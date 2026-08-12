package buzz.armada.app;

import android.content.Intent;
import android.util.Log;

import androidx.annotation.Nullable;

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
 *   - start({ title, text })  → post/refresh the ongoing notification
 *   - stop()                  → tear it down
 *
 * Events emitted to JS:
 *   - "hangup" — the notification's "Leave" button was tapped
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

    @Override
    public void load() {
        super.load();
        instance = this;
    }

    @Override
    protected void handleOnDestroy() {
        if (instance == this) instance = null;
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

    @PluginMethod
    public void stop(PluginCall call) {
        try {
            getContext().stopService(new Intent(getContext(), CallForegroundService.class));
        } catch (Exception e) {
            Log.w(TAG, "Could not stop the call foreground service", e);
        }
        call.resolve();
    }
}
