package pub.armada.app;

import android.os.Bundle;

import androidx.activity.EdgeToEdge;
import androidx.core.splashscreen.SplashScreen;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register native plugins before super.onCreate.
        registerPlugin(ArmadaNotificationPlugin.class);

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
    }

    // Notification taps deep-link via the `armada://open<path>` data URI set on
    // the launch Intent (see NotificationRelayService.roomPendingIntent). We rely
    // on Capacitor's @capacitor/app plugin to surface it — `App.getLaunchUrl()`
    // on a cold launch and the `appUrlOpen` event on a warm one. BridgeActivity
    // already forwards the launch Intent to that plugin (its own onCreate +
    // onNewIntent), so no custom intent handling is needed here. The web layer
    // (useNotificationNavigation) reads the URL and routes via React Router —
    // a soft navigation, never a `window.location.href` document reload (which
    // would cold-boot the whole app: re-mount providers, re-open IndexedDB and
    // pay its multi-second WebView warm-up, re-run sync, re-subscribe relays).
}
