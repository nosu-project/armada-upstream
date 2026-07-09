package pub.armada.app;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Tiny bridge the web layer calls once React has committed and painted its
 * first real frame, so the native launch splash can lift at the right moment.
 *
 * The native splash is held (MainActivity.setKeepOnScreenCondition) across the
 * cold start. The WebView's own onPageCommitVisible fires on the FIRST paint —
 * which is the blank background frame BEFORE React renders content — so lifting
 * on that alone flashes an empty WebView ("the void") before the app appears.
 * This plugin lets the web layer say "I've actually painted", which is the
 * correct dismiss signal. An 8s native timeout still guards against it never
 * arriving (e.g. a JS crash before paint).
 */
@CapacitorPlugin(name = "WebReady")
public class WebReadyPlugin extends Plugin {

    /** Set true once the web layer reports its first painted frame. */
    static volatile boolean webPainted = false;

    @PluginMethod
    public void signalReady(PluginCall call) {
        webPainted = true;
        call.resolve();
    }
}
