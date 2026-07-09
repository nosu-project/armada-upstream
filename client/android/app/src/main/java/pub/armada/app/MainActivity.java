package pub.armada.app;

import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.webkit.WebView;

import androidx.activity.EdgeToEdge;
import androidx.core.splashscreen.SplashScreen;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;

public class MainActivity extends BridgeActivity {
    // Held true from launch until the WebView commits its first visible paint
    // (or a safety timeout fires). While true, the native splash stays up.
    private volatile boolean webNotReady = true;

    // Hard cap on how long the native splash may cover a cold start. The
    // WebView first-paint signal is the normal dismisser; this only guards
    // against it never arriving (so the splash can't hang forever).
    private static final long SPLASH_MAX_MS = 8000;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register native plugins before super.onCreate.
        registerPlugin(ArmadaNotificationPlugin.class);
        registerPlugin(BluetoothMeshPlugin.class);

        // Install the androidx splash screen. This dismisses the launch
        // (Theme.SplashScreen) window and hands off to postSplashScreenTheme
        // (AppTheme.NoActionBar) once the activity is up — without this the
        // launch theme's splash window can linger as a band after launch.
        SplashScreen splashScreen = SplashScreen.installSplashScreen(this);

        // Hold the branded native splash on screen until the WebView has
        // actually PAINTED the web content. Without this, Android dismisses the
        // splash the moment the activity is up — but on a cold start the WebView
        // warm-up + bundle parse takes ~1-2s more, leaving a blank dark window
        // (the app's #100b15 background) with nothing on it. Keeping the splash
        // up bridges that gap so the crest covers the whole cold start and hands
        // off directly to the rendered app (whose own in-HTML splash then shows
        // during any further route-chunk load).
        splashScreen.setKeepOnScreenCondition(() -> webNotReady);

        // Enable edge-to-edge so the WebView draws under the status and
        // navigation bars. The @capacitor-community/safe-area plugin then
        // feeds the resulting insets to the web layer (env(safe-area-inset-*)
        // on modern Chromium, padding fallback on older webviews), which the
        // app's CSS consumes for top/bottom safe-area handling.
        EdgeToEdge.enable(this);
        super.onCreate(savedInstanceState);

        // Lift the splash on the WebView's first visible paint.
        // onPageCommitVisible fires when the WebView has committed the first
        // frame with page content on screen — the exact moment the blank dark
        // window would otherwise give way to the web layer. A safety timeout
        // guarantees the splash lifts even if the callback never arrives.
        new Handler(Looper.getMainLooper()).postDelayed(() -> webNotReady = false, SPLASH_MAX_MS);

        if (getBridge() != null) {
            getBridge()
                .addWebViewListener(
                    new WebViewListener() {
                        @Override
                        public void onPageCommitVisible(WebView view, String url) {
                            webNotReady = false;
                        }
                    }
                );
        } else {
            // No bridge handle (shouldn't happen): don't hold the splash.
            webNotReady = false;
        }
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
