package buzz.armada.app;

import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.webkit.WebView;

import androidx.activity.EdgeToEdge;
import androidx.core.splashscreen.SplashScreen;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    // Held true from launch until the web layer reports it has painted its first
    // real frame (WebReadyPlugin) or a safety timeout fires. While true, the
    // native animated-crest splash stays up, covering the whole cold start.
    private volatile boolean webNotReady = true;

    // Hard cap on how long the splash may cover a cold start. The web "painted"
    // signal is the normal dismisser; this only guards against it never arriving
    // (e.g. a JS crash before paint) so the splash can't hang forever.
    private static final long SPLASH_MAX_MS = 8000;

    // How often to check WebReadyPlugin.webPainted (ms).
    private static final long SPLASH_POLL_MS = 16;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register native plugins before super.onCreate.
        registerPlugin(ArmadaNotificationPlugin.class);
        registerPlugin(buzz.armada.app.db.ArmadaDbPlugin.class);
        registerPlugin(ArmadaCredentialPlugin.class);
        registerPlugin(BluetoothMeshPlugin.class);
        registerPlugin(WebReadyPlugin.class);

        // Install the androidx splash screen. This dismisses the launch
        // (Theme.SplashScreen) window and hands off to postSplashScreenTheme
        // (AppTheme.NoActionBar) once the activity is up — without this the
        // launch theme's splash window can linger as a band after launch.
        SplashScreen splashScreen = SplashScreen.installSplashScreen(this);

        // Hold the branded ANIMATED-crest splash on screen until the WEB LAYER
        // reports it has painted its first real frame (WebReadyPlugin.signalReady,
        // called from React after commit + a rAF). The in-HTML animated crest
        // can't cover the cold start (it only exists once the WebView paints,
        // ~1-2s in), so the animated NATIVE splash owns the whole cold start:
        // it plays its entrance, then the finished crest sits until the app is
        // actually on screen. We deliberately do NOT lift on the WebView's
        // onPageCommitVisible — that fires on the blank background frame BEFORE
        // React renders, which flashed an empty WebView ("the void") between the
        // splash and the app.
        splashScreen.setKeepOnScreenCondition(() -> webNotReady);

        // Enable edge-to-edge so the WebView draws under the status and
        // navigation bars. The @capacitor-community/safe-area plugin then
        // feeds the resulting insets to the web layer (env(safe-area-inset-*)
        // on modern Chromium, padding fallback on older webviews), which the
        // app's CSS consumes for top/bottom safe-area handling.
        EdgeToEdge.enable(this);
        super.onCreate(savedInstanceState);

        // Poll the web-painted flag; lift the splash once set, with a safety
        // timeout so it can never hang.
        final Handler handler = new Handler(Looper.getMainLooper());
        final long deadline = System.currentTimeMillis() + SPLASH_MAX_MS;
        handler.post(
            new Runnable() {
                @Override
                public void run() {
                    if (WebReadyPlugin.webPainted || System.currentTimeMillis() >= deadline) {
                        webNotReady = false;
                    } else {
                        handler.postDelayed(this, SPLASH_POLL_MS);
                    }
                }
            }
        );
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

    // Recover from the WebView getting STUCK reporting `document.visibilityState
    // === "hidden"` while the app is actually foreground. On some background→
    // foreground / screen-off→on transitions the Android WebView fails to
    // propagate its restored visibility to the renderer's page-visibility state,
    // so Chromium keeps the document "hidden" and FREEZES all timers, intervals,
    // rAF and background tasks in it. Every timer-driven subsystem then stops —
    // relay reconnect polls, Concord backfill retries, wire sync — and channels
    // silently read blank until the process is killed and relaunched (a fresh
    // WebView starts visible). A document reload does NOT fix it (the reloaded
    // document is still hidden); only re-resuming the WebView does.
    //
    // `WebView.onResume()` + `resumeTimers()` un-freeze the renderer's timer and
    // task queues for this (now genuinely foreground) activity, so the frozen
    // subsystems resume even if the WebView's `visibilityState` stays cosmetically
    // "hidden". The existing `appStateChange`→`focusManager` wiring (see App.tsx)
    // then drives the catch-up refetch. Cheap and idempotent, so running it on
    // every resume is safe; it's a no-op when the WebView was never frozen.
    @Override
    public void onResume() {
        super.onResume();
        try {
            if (this.bridge != null) {
                WebView webView = this.bridge.getWebView();
                if (webView != null) {
                    webView.onResume();
                    webView.resumeTimers();
                }
            }
        } catch (Exception ignored) {
            // Best-effort: never let a resume-recovery attempt crash the activity.
        }
    }
}
