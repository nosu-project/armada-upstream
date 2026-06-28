package pub.armada.app;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;

import androidx.activity.EdgeToEdge;
import androidx.core.splashscreen.SplashScreen;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register native plugins before super.onCreate.
        registerPlugin(ArmadaNotificationPlugin.class);
        registerPlugin(BluetoothMeshPlugin.class);

        // Install the androidx splash screen. This dismisses the launch
        // (Theme.SplashScreen) window and hands off to postSplashScreenTheme
        // (AppTheme.NoActionBar) once the activity is up — without this the
        // launch theme's splash window can linger as a band after launch.
        SplashScreen.installSplashScreen(this);

        // Enable edge-to-edge so the WebView draws under the status and
        // navigation bars. The @capacitor-community/safe-area plugin then
        // feeds the resulting insets to the web layer (env(safe-area-inset-*)
        // on modern Chromium, padding fallback on older webviews), which the
        // app's CSS consumes for top/bottom safe-area handling.
        EdgeToEdge.enable(this);
        super.onCreate(savedInstanceState);

        handleNotificationIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleNotificationIntent(intent);
    }

    /**
     * When the activity is launched from a notification tap, navigate the
     * in-app WebView to the in-app path the notification points at (e.g.
     * /s/<server>/<groupId> or /dms/<peer>). The path is carried both as an
     * armada://open<path> data URI and an armada_path extra.
     */
    private void handleNotificationIntent(Intent intent) {
        if (intent == null) return;
        String path = intent.getStringExtra("armada_path");
        if (path == null) {
            Uri data = intent.getData();
            if (data != null && "armada".equals(data.getScheme())) {
                // armada://open/s/<server>/<id> → strip the "open" host.
                String full = data.getSchemeSpecificPart(); // "//open/s/..."
                int idx = full.indexOf("/open");
                path = idx >= 0 ? full.substring(idx + "/open".length()) : null;
            }
        }
        if (path == null || path.isEmpty()) return;

        final String target = path;
        getBridge().getWebView().post(() ->
                getBridge().getWebView().evaluateJavascript(
                        "window.location.href = '" + target.replace("'", "\\'") + "';",
                        null));
    }
}
